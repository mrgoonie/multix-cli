/**
 * Node-only: run a Gemini Omni video request end to end for the CLI commands
 * (read local images, upload a local video, create the interaction, wait,
 * save the MP4) and keep a session record next to the output.
 *
 * Paid-request safety:
 * - Key rotation applies only until a request is accepted: a 429 means the
 *   interaction was not created. Everything after that (polling, the file
 *   download, follow-up edits) stays on the key, and therefore the Google
 *   Cloud project, that created it.
 * - A create request that times out or loses its connection is never sent
 *   again: the server may still finish (and bill) it.
 */

import fs from "node:fs";
import path from "node:path";
import { PollTimeoutError } from "../../core/async-poll.js";
import { HttpError, ProviderError, ValidationError } from "../../core/errors.js";
import { DownloadTooLargeError, downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { withGeminiKey, withNamedGeminiKey } from "./key-pool.js";
import { INLINE_MAX_BYTES, uploadLocalFile } from "./local-files.js";
import {
  OMNI_API_HOST,
  type OmniDelivery,
  type OmniInteraction,
  type OmniMedia,
  type OmniVideo,
  assertOmniCompleted,
  buildOmniRequest,
  createOmniInteraction,
  extractOmniVideo,
  geminiFileDownloadUrl,
  geminiFileName,
  getOmniInteraction,
  isOmniRunning,
  validateOmniOptions,
  waitForGeminiFileActive,
  waitForOmniInteraction,
} from "./omni.js";
import { veoImageFromFile } from "./veo.js";

export const OMNI_DEFAULT_TIMEOUT_SECONDS = 900;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Portable record of one Omni interaction, written next to its video. */
export interface OmniSessionRecord {
  kind: "gemini-omni-video";
  interaction_id: string;
  parent_interaction_id?: string;
  model: string;
  /** Env var of the key that created it (never the key itself). */
  key_env: string;
  store: boolean;
  status: string;
  output_path?: string;
  /** Files API resource name of the delivered video ("files/abc"), when delivered by URI. */
  media_file?: string;
  created_at: string;
  updated_at: string;
  request: Record<string, unknown>;
  usage?: unknown;
}

/** Common Omni flags shared by every Omni command. */
export interface OmniCommonOptions {
  aspectRatio?: string;
  resolution?: string;
  delivery?: string;
  task?: string;
  store?: boolean;
  background?: boolean;
  timeout?: string;
}

export interface OmniSettings {
  aspectRatio?: string;
  resolution?: string;
  delivery: OmniDelivery;
  task?: string;
  store: boolean;
  background: boolean;
  timeoutMs: number;
}

export function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined) return OMNI_DEFAULT_TIMEOUT_SECONDS * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 30 || n > 7200) {
    throw new ValidationError("--timeout must be a number of seconds between 30 and 7200");
  }
  return Math.round(n * 1000);
}

/** Validate the Omni flags (before any request) and fill in defaults. */
export function omniSettings(opts: OmniCommonOptions): OmniSettings {
  const settings: OmniSettings = {
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution?.toLowerCase(),
    delivery: (opts.delivery ?? "uri") as OmniDelivery,
    task: opts.task,
    store: opts.store !== false,
    // Stored runs go to the background so the id comes back at once and a
    // dropped connection never loses a billed video. --no-store must be sync.
    background: opts.background ?? opts.store !== false,
    timeoutMs: parseTimeoutSeconds(opts.timeout),
  };
  validateOmniOptions(settings);
  return settings;
}

/** Read local images as inline Omni parts (JPEG, PNG or WebP, 20 MB in total). */
export function omniImagesFromPaths(paths: string[] = []): OmniMedia[] {
  let total = 0;
  return paths.map((p) => {
    const img = veoImageFromFile(p);
    total += Math.ceil((img.bytesBase64Encoded.length * 3) / 4);
    if (total > INLINE_MAX_BYTES) {
      throw new ValidationError(
        `Reference images exceed ${INLINE_MAX_BYTES / 1024 / 1024} MB in total; use smaller images`,
      );
    }
    return { data: img.bytesBase64Encoded, mimeType: img.mimeType };
  });
}

/** Session record path for a video: `clip.mp4` -> `clip.interaction.json`. */
export function sessionPathFor(videoPath: string): string {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}.interaction.json`);
}

export function writeSessionRecord(file: string, record: OmniSessionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readSessionRecord(file: string): OmniSessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ValidationError(
      `Cannot read session file ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const r = parsed as Partial<OmniSessionRecord> | null;
  if (!r || r.kind !== "gemini-omni-video" || typeof r.interaction_id !== "string") {
    throw new ValidationError(`${file} is not a Gemini Omni session file`);
  }
  if (typeof r.key_env !== "string" || r.key_env === "" || typeof r.model !== "string") {
    throw new ValidationError(`${file} has no valid key_env or model`);
  }
  if (typeof r.store !== "boolean") {
    throw new ValidationError(`${file} has no valid store flag`);
  }
  return r as OmniSessionRecord;
}

/** Run `fn` on the pinned key (follow-ups) or the rotating pool (new work). */
function withKey<T>(
  keyEnv: string | undefined,
  logger: Logger,
  fn: (apiKey: string, keyName: string) => Promise<T>,
): Promise<T> {
  return keyEnv ? withNamedGeminiKey(keyEnv, fn) : withGeminiKey(fn, { logger });
}

/** Save the video from an interaction to `dest`. Returns the Files API name for URI delivery. */
export async function saveOmniVideo(
  video: OmniVideo,
  dest: string,
  apiKey: string,
  logger: Logger,
  timeoutMs: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<string | undefined> {
  const maxBytes = maxDownloadBytes();
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
  if (video.data !== undefined) {
    // Base64 decodes to at most 3/4 of its length; check before allocating the buffer.
    if (Math.floor((video.data.length * 3) / 4) > maxBytes) {
      throw new DownloadTooLargeError(maxBytes, "inline video data");
    }
    const tmp = `${dest}.${process.pid}.part`;
    try {
      fs.writeFileSync(tmp, Buffer.from(video.data, "base64"));
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return undefined;
  }
  const uri = video.uri ?? "";
  const name = geminiFileName(uri);
  if (name) {
    logger.debug(`Waiting for ${name} to finish processing...`);
    await waitForGeminiFileActive(name, {
      apiKey,
      timeoutMs,
      sleep,
      onPoll: (state, n) => logger.debug(`File state: ${state ?? "?"} (poll ${n})`),
    });
    // The key goes only to the Gemini API host; downloadToFile drops it on a
    // redirect to another origin (the storage host).
    await downloadToFile(geminiFileDownloadUrl(name), {
      dest,
      headers: { "x-goog-api-key": apiKey },
      maxBytes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    return name;
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(uri);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:") {
    throw new ProviderError("Gemini Omni returned an invalid video URI", "gemini");
  }
  if (parsed.hostname === OMNI_API_HOST) {
    // A Gemini URI we cannot map to a Files API name: fetching it without the
    // key would fail, and sending the key to an unknown path is not allowed.
    throw new ProviderError(
      "Gemini Omni returned a Gemini video URI in an unexpected form, so it was not downloaded (the API key is only sent to Files API paths). The interaction id is in the session file.",
      "gemini",
    );
  }
  // Not a Gemini Files API URI: fetch it without credentials.
  await downloadToFile(uri, { dest, maxBytes, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  return undefined;
}

export interface RunOmniOptions {
  model: string;
  prompt: string;
  settings: OmniSettings;
  imagePaths?: string[];
  /** Local video to upload and edit or extend. */
  videoPath?: string;
  previousInteractionId?: string;
  /** Pin the key env var (follow-ups on a stored interaction). */
  keyEnv?: string;
  dest: string;
  logger: Logger;
  /** Recorded in the session file (e.g. the command name). */
  command: string;
  /** Poll delay override (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOmniResult {
  dest: string;
  sessionPath: string;
  interaction: OmniInteraction;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The request may have been accepted (and billed) even though no usable answer came back. */
function ambiguousFailure(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 0 || err.status >= 500) return true;
  return err.status < 300 && err.snippet.startsWith("Invalid JSON response");
}

/**
 * Create one Omni interaction and save its video to `dest`, writing the
 * session record (`<name>.interaction.json`) as soon as the id is known.
 */
export async function runOmni(opts: RunOmniOptions): Promise<RunOmniResult> {
  const { settings, logger, dest } = opts;
  const images = omniImagesFromPaths(opts.imagePaths);
  if (opts.videoPath && !fs.existsSync(opts.videoPath)) {
    throw new ValidationError(`Video not found: ${opts.videoPath}`);
  }
  const startedAt = Date.now();
  const deadline = startedAt + settings.timeoutMs;
  const sessionPath = sessionPathFor(dest);

  const { apiKey, keyName, created } = await withKey(
    opts.keyEnv,
    logger,
    async (apiKey, keyName) => {
      let video: { uri: string; mimeType?: string } | undefined;
      if (opts.videoPath) {
        logger.info(`Uploading ${path.basename(opts.videoPath)} to the Gemini Files API...`);
        const file = await uploadLocalFile(opts.videoPath, { apiKey, logger });
        video = { uri: file.uri, mimeType: file.mimeType };
      }
      const body = buildOmniRequest({
        model: opts.model,
        prompt: opts.prompt,
        images,
        video,
        previousInteractionId: opts.previousInteractionId,
        aspectRatio: settings.aspectRatio,
        resolution: settings.resolution,
        delivery: settings.delivery,
        task: settings.task,
        store: settings.store,
        background: settings.background,
      });
      try {
        const created = await createOmniInteraction(body, {
          apiKey,
          timeoutMs: settings.timeoutMs,
        });
        if (!created || typeof created !== "object") {
          throw new HttpError(200, "Invalid JSON response: empty body", "interactions");
        }
        return { apiKey, keyName, created };
      } catch (err) {
        if (!ambiguousFailure(err)) throw err;
        throw new ProviderError(
          `The Gemini Omni request did not return (${(err as Error).message}). It may still finish and be billed, so it was not sent again. Check your interactions in Google AI Studio before retrying${settings.background ? "" : ", or retry with --background to get the interaction id right away"}.`,
          "gemini",
          { cause: err },
        );
      }
    },
  );

  const id = created.id;
  const record: OmniSessionRecord = {
    kind: "gemini-omni-video",
    interaction_id: id ?? "",
    ...(opts.previousInteractionId ? { parent_interaction_id: opts.previousInteractionId } : {}),
    model: created.model ?? opts.model,
    key_env: keyName,
    store: settings.store,
    status: created.status ?? "unknown",
    created_at: new Date(startedAt).toISOString(),
    updated_at: nowIso(),
    request: {
      command: opts.command,
      prompt: opts.prompt,
      aspect_ratio: settings.aspectRatio,
      resolution: settings.resolution,
      delivery: settings.delivery,
      task: settings.task,
      background: settings.background,
      images: images.length,
      ...(opts.videoPath ? { video: path.basename(opts.videoPath) } : {}),
    },
  };
  const save = () => {
    if (id && settings.store) writeSessionRecord(sessionPath, { ...record, updated_at: nowIso() });
  };
  save();
  if (id) logger.info(`Interaction: ${id}`);
  if (!settings.store) {
    logger.warn("--no-store: this video cannot be edited, extended or fetched again later");
  }

  let final = created;
  if (isOmniRunning(created)) {
    if (!id) throw new ProviderError("Gemini Omni accepted the request but sent no id", "gemini");
    try {
      final = await waitForOmniInteraction(id, {
        apiKey,
        timeoutMs: Math.max(deadline - Date.now(), 1000),
        sleep: opts.sleep,
        onPoll: (status, n) => logger.debug(`Interaction ${status ?? "?"} (poll ${n})`),
        resumeHint: `Resume with: multix gemini video-status --session ${sessionPath} --wait --download`,
      });
    } catch (err) {
      if (err instanceof PollTimeoutError) {
        record.status = "in_progress";
        save();
      }
      throw err;
    }
  }
  record.status = final.status ?? "completed";
  if (final.usage !== undefined) record.usage = final.usage;
  save();
  assertOmniCompleted(final);

  const video = extractOmniVideo(final);
  if (!video) {
    throw new ProviderError(
      `Gemini Omni interaction ${id ?? "(no id)"} finished without a video`,
      "gemini",
    );
  }
  const mediaFile = await saveOmniVideo(
    video,
    dest,
    apiKey,
    logger,
    Math.max(deadline - Date.now(), 60_000),
    opts.sleep,
  );
  record.output_path = path.resolve(dest);
  if (mediaFile) record.media_file = mediaFile;
  save();
  return { dest, sessionPath, interaction: final };
}

export interface OmniStatusOptions {
  interactionId: string;
  keyEnv?: string;
  wait: boolean;
  timeoutMs: number;
  logger: Logger;
}

/** Look up a stored interaction (optionally waiting for it to finish). */
export async function fetchOmniStatus(
  opts: OmniStatusOptions,
): Promise<{ interaction: OmniInteraction; apiKey: string }> {
  return withKey(opts.keyEnv, opts.logger, async (apiKey) => {
    const interaction = opts.wait
      ? await waitForOmniInteraction(opts.interactionId, {
          apiKey,
          timeoutMs: opts.timeoutMs,
          onPoll: (status, n) => opts.logger.debug(`Interaction ${status ?? "?"} (poll ${n})`),
        })
      : await getOmniInteraction(opts.interactionId, { apiKey });
    return { interaction, apiKey };
  });
}
