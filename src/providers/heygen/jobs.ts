/**
 * Operation-aware status for HeyGen async jobs. Each job family has its own
 * endpoint and status vocabulary; this module normalizes them into one shape
 * and waits with bounded polling. Runtime-neutral (no node:* imports).
 *
 * Video Agent is two-stage: a session (`session_id`) gets a `video_id` once
 * rendering starts, and the finished video is read from GET /v3/videos/{id}.
 */

import { type PollOptions, pollUntil } from "../../core/async-poll.js";
import type { HeygenClient } from "./client.js";
import { HeygenJobFailedError } from "./heygen-errors.js";
import type { HeygenJobKind } from "./models.js";
import type {
  HeygenLipsync,
  HeygenModelVideo,
  HeygenVideoDetail,
  HeygenVideoTranslation,
  VideoAgentSession,
} from "./types.js";

export interface HeygenJobState {
  kind: HeygenJobKind;
  /** The ID the caller asked about (session id for `agent`). */
  id: string;
  /** Raw provider status (video status once an agent session has a video). */
  status: string;
  done: boolean;
  succeeded: boolean;
  /** Agent only: the session status and the assigned video id. */
  sessionId?: string;
  sessionStatus?: string;
  videoId?: string;
  progress?: number;
  outputUrl?: string;
  thumbnailUrl?: string;
  captionUrl?: string;
  outputLanguage?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Raw API payloads, for `--raw` output. */
  raw: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function videoState(
  video: HeygenVideoDetail,
  kind: HeygenJobKind = "video",
  id = video.id,
): HeygenJobState {
  const done = video.status === "completed" || video.status === "failed";
  return {
    kind,
    id,
    status: video.status,
    done,
    succeeded: video.status === "completed",
    videoId: video.id,
    outputUrl: str(video.video_url) ?? str(video.captioned_video_url),
    thumbnailUrl: str(video.thumbnail_url),
    captionUrl: str(video.subtitle_url),
    failureCode: str(video.failure_code),
    failureMessage: str(video.failure_message),
    raw: { video },
  };
}

export function translationState(t: HeygenVideoTranslation): HeygenJobState {
  return {
    kind: "translation",
    id: t.id,
    status: t.status,
    done: t.status === "completed" || t.status === "failed",
    succeeded: t.status === "completed",
    outputUrl: str(t.video_url) ?? str(t.audio_url),
    captionUrl: str(t.srt_caption_url) ?? str(t.vtt_caption_url),
    outputLanguage: str(t.output_language),
    failureMessage: str(t.failure_message),
    raw: { translation: t },
  };
}

export function lipsyncState(l: HeygenLipsync): HeygenJobState {
  return {
    kind: "lipsync",
    id: l.id,
    status: l.status,
    done: l.status === "completed" || l.status === "failed",
    succeeded: l.status === "completed",
    outputUrl: str(l.video_url),
    captionUrl: str(l.caption_url),
    failureMessage: str(l.failure_message),
    raw: { lipsync: l },
  };
}

export function modelVideoState(v: HeygenModelVideo): HeygenJobState {
  const done = v.status === "completed" || v.status === "failed" || v.status === "cancelled";
  return {
    kind: "model-video",
    id: v.video_id,
    status: v.status,
    done,
    succeeded: v.status === "completed",
    videoId: v.video_id,
    outputUrl: str(v.video_url),
    failureCode: str(v.failure_code),
    failureMessage: str(v.failure_message),
    raw: { video: v },
  };
}

/**
 * Combine a Video Agent session with its video (when assigned).
 * Once a video exists its status is authoritative; before that, a failed or
 * input-waiting session is terminal because a generate-mode run cannot proceed.
 */
export function agentState(session: VideoAgentSession, video?: HeygenVideoDetail): HeygenJobState {
  const base = {
    kind: "agent" as const,
    id: session.session_id,
    sessionId: session.session_id,
    sessionStatus: session.status,
    progress: session.progress,
  };
  const sessionError = session.error ?? undefined;

  if (video) {
    const v = videoState(video, "agent", session.session_id);
    if (!v.done && session.status === "failed" && sessionError?.code !== "context_limit_exceeded") {
      return {
        ...v,
        ...base,
        status: "failed",
        done: true,
        succeeded: false,
        failureCode: sessionError?.code,
        failureMessage: sessionError?.message ?? "Video Agent session failed",
        raw: { session, video },
      };
    }
    if (v.done && !v.succeeded && session.status === "waiting_for_input") {
      return {
        ...v,
        ...base,
        failureCode: v.failureCode ?? "waiting_for_input",
        failureMessage:
          v.failureMessage ??
          "Video Agent paused for input; continue the session in the HeyGen app or start a new prompt.",
        raw: { session, video },
      };
    }
    return { ...v, ...base, raw: { session, video } };
  }

  const pending = { ...base, status: session.status, raw: { session } };
  if (session.status === "failed") {
    return {
      ...pending,
      done: true,
      succeeded: false,
      failureCode: sessionError?.code,
      failureMessage: sessionError?.message ?? "Video Agent session failed",
    };
  }
  if (session.status === "waiting_for_input") {
    return {
      ...pending,
      done: true,
      succeeded: false,
      failureCode: "waiting_for_input",
      failureMessage:
        "Video Agent paused for input before rendering; continue the session in the HeyGen app or start a new prompt.",
    };
  }
  if (session.status === "completed") {
    return {
      ...pending,
      done: true,
      succeeded: false,
      failureCode: "no_video",
      failureMessage: "Video Agent session completed without a video_id.",
    };
  }
  return { ...pending, done: false, succeeded: false };
}

/**
 * Stateful status reader. For `agent`, the video id is remembered after the
 * first sighting so later polls hit GET /v3/videos/{id} only.
 */
export function createJobStatusReader(
  client: HeygenClient,
  kind: HeygenJobKind,
  id: string,
): () => Promise<HeygenJobState> {
  let agentSession: VideoAgentSession | undefined;
  return async () => {
    switch (kind) {
      case "video":
        return videoState(await client.getVideo(id));
      case "translation":
        return translationState(await client.getVideoTranslation(id));
      case "lipsync":
        return lipsyncState(await client.getLipsync(id));
      case "model-video":
        return modelVideoState(await client.getModelVideo(id));
      case "agent": {
        if (!agentSession?.video_id) agentSession = await client.getVideoAgentSession(id);
        const videoId = agentSession.video_id;
        if (!videoId) return agentState(agentSession);
        return agentState(agentSession, await client.getVideo(videoId));
      }
    }
  };
}

export function getJobState(
  client: HeygenClient,
  kind: HeygenJobKind,
  id: string,
): Promise<HeygenJobState> {
  return createJobStatusReader(client, kind, id)();
}

export type WaitOptions = Omit<PollOptions<HeygenJobState>, "fetchStatus" | "isTerminal">;

/** Poll until terminal. Returns the final state; does not throw on job failure. */
export function waitForJob(
  client: HeygenClient,
  kind: HeygenJobKind,
  id: string,
  opts: WaitOptions,
): Promise<HeygenJobState> {
  return pollUntil({
    intervalMs: 5_000,
    maxIntervalMs: 30_000,
    ...opts,
    fetchStatus: createJobStatusReader(client, kind, id),
    isTerminal: (s) => s.done,
  });
}

/** Throw a HeygenJobFailedError for a terminal non-success state. */
export function assertJobSucceeded(state: HeygenJobState): void {
  if (state.succeeded) return;
  const label =
    state.kind === "agent" ? `Video Agent session ${state.id}` : `${state.kind} ${state.id}`;
  const code = state.failureCode ? ` (${state.failureCode})` : "";
  const msg = state.failureMessage ? `: ${state.failureMessage}` : "";
  throw new HeygenJobFailedError(
    `HeyGen ${label} ended with status "${state.status}"${code}${msg}`,
    state.failureCode,
  );
}

/** Command that resumes a job, printed for `--async` and on timeouts. */
export function resumeCommand(kind: HeygenJobKind, id: string): string {
  return `multix heygen status ${id} --type ${kind} --wait --download`;
}
