/**
 * `media inspect`: read-only facts about one local media file. Magic bytes
 * against the extension, sha256 of the exact bytes, container and streams
 * from ffprobe and, with `decode`, a full decode that counts decode errors.
 * Nothing is uploaded and the file is never modified.
 */

import path from "node:path";
import { ProviderError } from "../../core/errors.js";
import { analyzeMedia } from "./media-analyze.js";
import {
  type AudioStreamInfo,
  type ProbeInfo,
  ProbeInterruptedError,
  type VideoStreamInfo,
  firstAudio,
  firstVideo,
  probeMedia,
} from "./media-probe.js";
import { extensionMatches, sniffContainer } from "./media-sniff.js";
import { type MediaSource, resolveMediaSource } from "./media-source.js";

export const INSPECT_SCHEMA = "multix.media-inspect/v1";

export interface DecodeReport {
  completed: boolean;
  decoded_s: number | null;
  timed_out: boolean;
  error_count: number;
  errors: string[];
}

export interface InspectReport {
  schema: typeof INSPECT_SCHEMA;
  ok: boolean;
  source: { path: string; resolved: string; symlink: boolean; bytes: number; sha256: string };
  sniff: { container: string | null; extension: string; extension_matches: boolean | null };
  /** What the file holds, from its streams; null when ffprobe could not read it. */
  kind: "video" | "audio" | "image" | null;
  format: Omit<ProbeInfo, "streams"> | null;
  streams: ProbeInfo["streams"];
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  decode: DecodeReport | null;
  /** ffprobe or the decode was stopped by the timeout or a cancel: what was not read is unknown. */
  interrupted: boolean;
  errors: string[];
}

export interface InspectOptions {
  decode?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const IMAGE_FORMATS = /(^|,)(image2|[a-z0-9]+_pipe|gif|apng)(,|$)/;

export function kindOf(probe: ProbeInfo): InspectReport["kind"] {
  const video = firstVideo(probe);
  if (video && probe.format_name && IMAGE_FORMATS.test(probe.format_name)) {
    // An animated GIF/APNG has more than one frame: treat it as video.
    return video.nb_frames !== null && video.nb_frames > 1 ? "video" : "image";
  }
  if (video) return "video";
  if (firstAudio(probe)) return "audio";
  return null;
}

/** Inspect an already resolved source (lets verify reuse the hash). */
export async function inspectSource(
  src: MediaSource,
  opts: InspectOptions = {},
): Promise<InspectReport> {
  const sniff = sniffContainer(src.head);
  const ext = path.extname(src.path);
  const errors: string[] = [];
  let probe: ProbeInfo | null = null;
  let interrupted = false;
  if (src.bytes === 0) errors.push("File is empty");
  else if (sniff.container === "text")
    errors.push(
      "File content is text (an error page, playlist or concat list), not media; it was not passed to ffprobe",
    );
  else {
    try {
      probe = await probeMedia(src.resolved, opts);
    } catch (e) {
      // A missing ffprobe is a blocker for the caller, not a property of the file.
      if (!(e instanceof ProviderError)) throw e;
      if (e instanceof ProbeInterruptedError) interrupted = true;
      errors.push(e.message);
    }
  }
  if (probe && probe.streams.length === 0) errors.push("No audio or video streams found");

  let decode: DecodeReport | null = null;
  if (opts.decode && probe && probe.streams.length > 0) {
    const video = firstVideo(probe);
    const audio = firstAudio(probe);
    const a = await analyzeMedia(src.resolved, {
      video: video ? { streamIndex: video.index } : undefined,
      audio: audio ? { streamIndex: audio.index } : undefined,
      formatName: probe.format_name,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    if (a.timed_out || a.cancelled) interrupted = true;
    decode = {
      completed: a.completed,
      decoded_s: a.decoded_s,
      timed_out: a.timed_out,
      error_count: a.decode_error_count,
      errors: a.decode_errors,
    };
    if (!a.completed && !a.timed_out && !a.cancelled && a.decode_error_count === 0)
      errors.push(
        `Decode stopped early (ffmpeg exit ${a.exit_code}): ${a.log_tail.slice(-1)[0] ?? ""}`.trim(),
      );
  }

  const { streams = [], ...format } = probe ?? {};
  return {
    schema: INSPECT_SCHEMA,
    ok: errors.length === 0 && (!decode || (decode.completed && decode.error_count === 0)),
    source: {
      path: src.path,
      resolved: src.resolved,
      symlink: src.symlink,
      bytes: src.bytes,
      sha256: src.sha256,
    },
    sniff: {
      container: sniff.container,
      extension: ext,
      extension_matches: extensionMatches(ext, sniff),
    },
    kind: probe ? kindOf(probe) : null,
    format: probe ? (format as Omit<ProbeInfo, "streams">) : null,
    streams,
    video: probe ? (firstVideo(probe) ?? null) : null,
    audio: probe ? (firstAudio(probe) ?? null) : null,
    decode,
    interrupted,
    errors,
  };
}

export async function inspectMedia(
  input: string,
  opts: InspectOptions = {},
): Promise<InspectReport> {
  return inspectSource(await resolveMediaSource(input, opts.signal), opts);
}
