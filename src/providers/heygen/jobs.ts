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
  /** True when `outputUrl` is an audio file (an audio-only translation). */
  outputIsAudio?: boolean;
  /** Video only: the burned-in caption render, when HeyGen produced one. */
  captionedVideoUrl?: string;
  thumbnailUrl?: string;
  captionUrl?: string;
  outputLanguage?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Raw API payloads, for `--raw` output. */
  raw: Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Options that change how a job's output is selected. */
export interface JobReadOptions {
  /**
   * Burned-in captions were requested: the deliverable is `captioned_video_url`
   * (HeyGen's `video_url` is the clean render). A completed video without it fails.
   */
  burnCaptions?: boolean;
}

export function videoState(
  video: HeygenVideoDetail,
  kind: HeygenJobKind = "video",
  id = video.id,
  opts: JobReadOptions = {},
): HeygenJobState {
  const done = video.status === "completed" || video.status === "failed";
  const captioned = str(video.captioned_video_url);
  const state: HeygenJobState = {
    kind,
    id,
    status: video.status,
    done,
    succeeded: video.status === "completed",
    videoId: video.id,
    outputUrl: opts.burnCaptions ? captioned : (str(video.video_url) ?? captioned),
    captionedVideoUrl: captioned,
    thumbnailUrl: str(video.thumbnail_url),
    captionUrl: str(video.subtitle_url),
    failureCode: str(video.failure_code),
    failureMessage: str(video.failure_message),
    raw: { video },
  };
  if (opts.burnCaptions && state.succeeded && !captioned) {
    return {
      ...state,
      succeeded: false,
      failureCode: "captioned_video_missing",
      failureMessage:
        "Burned-in captions were requested but HeyGen returned no captioned_video_url. The uncaptioned render is available via `heygen status --raw`.",
    };
  }
  return state;
}

export function translationState(t: HeygenVideoTranslation): HeygenJobState {
  const audioOnly = !str(t.video_url) && !!str(t.audio_url);
  return {
    kind: "translation",
    id: t.id,
    status: t.status,
    done: t.status === "completed" || t.status === "failed",
    succeeded: t.status === "completed",
    outputUrl: str(t.video_url) ?? str(t.audio_url),
    ...(audioOnly ? { outputIsAudio: true } : {}),
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
 * Status reader for one job. `remainingMs` (from polling) caps each request so
 * a single call cannot overrun the overall wait. For `agent`, the session is
 * re-read on every poll so a session that fails after its video was assigned
 * ends the wait instead of polling a stalled video until the timeout.
 */
export function createJobStatusReader(
  client: HeygenClient,
  kind: HeygenJobKind,
  id: string,
  opts: JobReadOptions = {},
): (ctx?: { remainingMs?: number }) => Promise<HeygenJobState> {
  return async (ctx) => {
    const call = { timeoutMs: ctx?.remainingMs };
    switch (kind) {
      case "video":
        return videoState(await client.getVideo(id, call), "video", id, opts);
      case "translation":
        return translationState(await client.getVideoTranslation(id, call));
      case "lipsync":
        return lipsyncState(await client.getLipsync(id, call));
      case "model-video":
        return modelVideoState(await client.getModelVideo(id, call));
      case "agent": {
        const session = await client.getVideoAgentSession(id, call);
        if (!session.video_id) return agentState(session);
        return agentState(session, await client.getVideo(session.video_id, call));
      }
    }
  };
}

export function getJobState(
  client: HeygenClient,
  kind: HeygenJobKind,
  id: string,
  opts: JobReadOptions = {},
): Promise<HeygenJobState> {
  return createJobStatusReader(client, kind, id, opts)();
}

export type WaitOptions = Omit<PollOptions<HeygenJobState>, "fetchStatus" | "isTerminal"> &
  JobReadOptions & {
    /**
     * Delay before the first poll, counted against `timeoutMs`. Used to spread
     * the first polls of parallel jobs instead of sending them as one burst.
     */
    startDelayMs?: number;
  };

/** Default first poll interval; HeyGen recommends polling every 10-30 s. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

const STAGGER_STEP_MS = 500;
const STAGGER_MAX_MS = 5_000;

/**
 * First-poll offset for the `index`-th of several parallel jobs: one step per
 * job (500 ms, or the poll interval when shorter), capped at 5 s.
 */
export function staggerOffsetMs(index: number, intervalMs: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  const step = Math.min(STAGGER_STEP_MS, Math.max(0, intervalMs));
  return Math.min(index * step, STAGGER_MAX_MS);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until terminal. Returns the final state; does not throw on job failure. */
export async function waitForJob(
  client: HeygenClient,
  kind: HeygenJobKind,
  id: string,
  opts: WaitOptions,
): Promise<HeygenJobState> {
  const { burnCaptions, startDelayMs = 0, ...poll } = opts;
  // Keep at least half the budget for polling so a tiny --wait-timeout still polls.
  let pendingDelay = Math.min(Math.max(0, startDelayMs), Math.floor(poll.timeoutMs / 2));
  const read = createJobStatusReader(client, kind, id, { burnCaptions });
  // The start delay runs inside the first status read, so it counts against the
  // caller's timeout and a timeout message reports the caller's own budget.
  return pollUntil({
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxIntervalMs: 30_000,
    ...poll,
    fetchStatus: async (ctx) => {
      const delay = pendingDelay;
      if (delay <= 0) return read(ctx);
      pendingDelay = 0;
      await (poll.sleep ?? defaultSleep)(delay);
      return read({ remainingMs: Math.max(1, ctx.remainingMs - delay) });
    },
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

/** Single-quote a value for a copy-pasteable POSIX shell command when needed. */
function shellArg(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Command that resumes a job, printed for `--async` and on timeouts. */
export function resumeCommand(kind: HeygenJobKind, id: string, opts: JobReadOptions = {}): string {
  const captions = opts.burnCaptions ? " --burn-captions" : "";
  return `multix heygen status ${shellArg(id)} --type ${kind} --wait --download${captions}`;
}
