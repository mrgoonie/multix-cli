/**
 * Node-only Gemini Omni video flow for the CLI: pick a key, upload local
 * media, submit once, persist the interaction id, poll, and save the video.
 *
 * Billing safety:
 * - Only the submit may rotate keys, and only on a quota response (nothing was
 *   accepted). A network failure or timeout on the submit is never retried:
 *   the request may already be running and billed.
 * - Once accepted, polling, file checks and the download stay on the key that
 *   created the interaction (it belongs to that key's project).
 * - The interaction id is written to a session record before polling starts,
 *   so a timeout or crash can be resumed with `gemini video-status`.
 *
 * Time and memory:
 * - `--wait-timeout` is one deadline from the start of the command to the
 *   finished interaction: uploads, the submit and polling all spend it. It
 *   decides whether a stored submit is sent, not how long that submit may
 *   take. Once the video is ready, waiting for its file and downloading it
 *   have their own budget (FILE_ACTIVE_TIMEOUT_MS + DOWNLOAD_TIMEOUT_MS).
 * - An Interaction can carry the video inline as base64 (always with
 *   --no-store, sometimes on the final GET of a stored one), so every read of
 *   it is capped (interactionMaxBytes) and only a stall, not a slow body, ends
 *   a status request early.
 */

import fs from "node:fs";
import path from "node:path";
import { PollTimeoutError, pollUntil } from "../../core/async-poll.js";
import {
  ConfigError,
  HttpError,
  ProviderError,
  ProviderJobFailedError,
  ResponseTooLargeError,
  ValidationError,
} from "../../core/errors.js";
import { downloadToFile, maxDownloadBytes } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { outputStamp } from "../../core/output-name.js";
import {
  type InteractionReadOptions,
  assertInteractionId,
  createInteraction,
  fileDownloadUrl,
  geminiFileNameFromUri,
  getFile,
  getInteraction,
} from "./client.js";
import { listGeminiKeys, withGeminiKey } from "./key-pool.js";
import { INLINE_MAX_BYTES, uploadLocalFile } from "./local-files.js";
import {
  type Interaction,
  OMNI_IMAGE_MIME_TYPES,
  type OmniInputPart,
  type OmniRequestOptions,
  base64DecodedBytes,
  buildOmniRequest,
  estimateOmniCost,
  extractOmniVideo,
  interactionFailureMessage,
  isTerminalInteraction,
} from "./omni.js";
import { getMimeType } from "./task-resolver.js";

const SUBMIT_TIMEOUT_MS = 120_000;
export const OMNI_DEFAULT_WAIT_MS = 15 * 60 * 1000;
const FILE_ACTIVE_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How long one status request may wait for its response headers, or between
 * two chunks of its body, before it is dropped and retried.
 */
const STALL_TIMEOUT_MS = 60_000;
/** Room for the JSON around an inline video (ids, text, usage, echoed input steps). */
const INTERACTION_JSON_OVERHEAD_BYTES = 64 * 1024 * 1024;
/**
 * Hard ceiling on an Interaction body, well under the longest JavaScript
 * string (about 512 MiB in V8), so JSON.parse and the base64 decode still fit.
 */
export const INTERACTION_MAX_BYTES_CEILING = 384 * 1024 * 1024;

/**
 * Largest Interaction body read into memory: the base64 form of a video at
 * the MULTIX_MAX_DOWNLOAD_MB cap plus the JSON around it, and never more
 * than INTERACTION_MAX_BYTES_CEILING.
 */
export function interactionMaxBytes(): number {
  return Math.min(
    Math.ceil(maxDownloadBytes() / 3) * 4 + INTERACTION_JSON_OVERHEAD_BYTES,
    INTERACTION_MAX_BYTES_CEILING,
  );
}

/**
 * Limits for reading an Interaction that may hold the video inline: a body
 * that keeps arriving gets all of `timeoutMs`, while a request that stalls
 * (no headers, or no data, for a minute) is dropped so polling can retry it.
 */
function interactionReadLimits(timeoutMs: number): InteractionReadOptions {
  return {
    timeoutMs,
    responseTimeoutMs: Math.min(timeoutMs, STALL_TIMEOUT_MS),
    idleTimeoutMs: STALL_TIMEOUT_MS,
    maxBytes: interactionMaxBytes(),
  };
}

/** The command that resumes an interaction by id (video-status for Omni, music-status for Lyria). */
export type ResumeCommand = (interactionId: string) => string;

/** Explain an Interaction body over the cap; other errors pass through. */
function oversizedInteraction(
  error: unknown,
  interactionId?: string,
  resume: ResumeCommand = resumeCommand,
): unknown {
  if (!(error instanceof ResponseTooLargeError)) return error;
  const what = interactionId ? `interaction ${interactionId}` : "response";
  const next = interactionId
    ? `Raise MULTIX_MAX_DOWNLOAD_MB and resume with: ${resume(interactionId)}`
    : "The output was not saved but may be billed; raise MULTIX_MAX_DOWNLOAD_MB before trying again.";
  return new ProviderError(
    `Gemini ${what} is larger than ${error.limitBytes} bytes because the output came back inline. ${next}`,
    "gemini",
    { cause: error },
  );
}

export interface GeminiKeyChoice {
  apiKey: string;
  keyName: string;
}

export interface OmniLocalMedia {
  /** Images, in order (first/last frame or subject references). */
  imagePaths?: string[];
  /** One video to edit or extend; always sent through the Files API. */
  videoPath?: string;
}

export interface OmniRunOptions extends OmniLocalMedia {
  request: Omit<OmniRequestOptions, "media">;
  /** Poll until done and save the video (default). false: submit and print the id. */
  wait: boolean;
  waitTimeoutMs: number;
  output?: string;
  logger: Logger;
}

/** Portable session record written next to the video (never holds a key or file URI). */
export interface OmniSessionRecord {
  provider: "gemini";
  /** Absent for --no-store: an unstored interaction has no id. */
  interaction_id?: string;
  parent_interaction_id?: string;
  model: string;
  /** Env var of the key that owns the interaction (never its value). */
  key_alias: string;
  status: string;
  store: boolean;
  created_at: string;
  updated_at: string;
  request: Record<string, unknown>;
  output_path?: string;
  media_file?: string;
  usage?: unknown;
  cost_estimate?: unknown;
  error?: string;
}

export function resumeCommand(id: string): string {
  return `multix gemini video-status ${id} --download`;
}

/** Validate local inputs before any request (and before any upload). */
export function checkOmniMedia(media: OmniLocalMedia): void {
  for (const p of media.imagePaths ?? []) {
    requireFile(p, "Image");
    const mime = getMimeType(p);
    if (!OMNI_IMAGE_MIME_TYPES.has(mime)) {
      throw new ValidationError(
        `Gemini Omni accepts PNG, JPEG, WebP, HEIC/HEIF, GIF, BMP or TIFF images: ${p} (${mime})`,
      );
    }
  }
  if (media.videoPath) {
    requireFile(media.videoPath, "Video");
    const mime = getMimeType(media.videoPath);
    if (!mime.startsWith("video/")) {
      throw new ValidationError(`Not a video file: ${media.videoPath} (${mime})`);
    }
  }
}

function requireFile(p: string, label: string): void {
  if (/^https?:\/\//i.test(p)) {
    throw new ValidationError(`${label} must be a local file, not a URL: ${p}`);
  }
  if (!fs.statSync(p, { throwIfNoEntry: false })?.isFile()) {
    throw new ValidationError(`${label} not found: ${p}`);
  }
}

/** Inline small images; upload larger images and every video with the given key. */
async function buildMediaParts(
  media: OmniLocalMedia,
  apiKey: string,
  logger: Logger,
): Promise<OmniInputPart[]> {
  const parts: OmniInputPart[] = [];
  if (media.videoPath) {
    logger.info(`Uploading ${path.basename(media.videoPath)} to the Gemini Files API...`);
    const ref = await uploadLocalFile(media.videoPath, { apiKey, logger });
    parts.push({ type: "video", uri: ref.uri, mime_type: ref.mimeType });
  }
  for (const p of media.imagePaths ?? []) {
    const mime = getMimeType(p);
    if (fs.statSync(p).size > INLINE_MAX_BYTES) {
      const ref = await uploadLocalFile(p, { apiKey, logger });
      parts.push({ type: "image", uri: ref.uri, mime_type: mime });
    } else {
      parts.push({ type: "image", data: fs.readFileSync(p).toString("base64"), mime_type: mime });
    }
  }
  return parts;
}

/**
 * The configured key whose project holds `interactionId`. Each key is asked
 * with a read-only GET, so trying several never creates or bills anything.
 */
export async function findInteractionKey(
  interactionId: string,
  logger: Logger,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; resume?: ResumeCommand } = {},
): Promise<GeminiKeyChoice & { interaction: Interaction }> {
  const { timeoutMs = DOWNLOAD_TIMEOUT_MS, env = process.env, resume } = opts;
  const id = assertInteractionId(interactionId);
  const keys = listGeminiKeys(env);
  if (keys.length === 0) {
    throw new ConfigError(
      "GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey",
    );
  }
  let lastError: unknown;
  for (const key of keys) {
    try {
      const interaction = (await getInteraction(id, {
        apiKey: key.value,
        ...interactionReadLimits(timeoutMs),
      })) as Interaction;
      return { apiKey: key.value, keyName: key.name, interaction };
    } catch (error) {
      if (!(error instanceof HttpError) || ![403, 404, 429].includes(error.status)) {
        throw oversizedInteraction(error, id, resume);
      }
      lastError = error;
      if (keys.length > 1) logger.debug(`${key.name} cannot read ${id} (HTTP ${error.status})`);
    }
  }
  const status = lastError instanceof HttpError ? ` (HTTP ${lastError.status})` : "";
  throw new ProviderError(
    `Interaction ${id} was not found for any configured Gemini key${status}. It may have expired, been created with --no-store, or belong to another project.`,
    "gemini",
  );
}

/** Turn a submit failure into an actionable message (rotation on 429 has already run). */
function submitError(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  if (error.status === 0) {
    return new ProviderError(
      `Gemini Omni submit failed before a response arrived (${error.message}). It was not retried, because the video may already be generating and billed; check https://aistudio.google.com before submitting again.`,
      "gemini",
      { cause: error },
    );
  }
  const message = /"message"\s*:\s*"([^"]+)"/.exec(error.snippet)?.[1] ?? error.snippet;
  const regional = /region|location|country|not available|unsupported.*(eea|uk|switzerland)/i.test(
    message,
  )
    ? " Editing or extending an uploaded video is unavailable in the EEA, Switzerland and the UK; edit a generated video with --interaction-id instead."
    : "";
  // A 5xx may come after Google accepted the job, so it gets the same warning as a lost response.
  const maybeBilled =
    error.status >= 500
      ? " The video may already be generating and billed; check https://aistudio.google.com before submitting again."
      : "";
  return new ProviderError(
    `Gemini Omni request failed (HTTP ${error.status}): ${message}${regional}${maybeBilled}`,
    "gemini",
    { cause: error },
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeRecord(file: string, record: OmniSessionRecord): void {
  record.updated_at = nowIso();
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}

/** Request parameters worth keeping (no image bytes, only local file names). */
function requestSummary(opts: OmniRunOptions): Record<string, unknown> {
  const r = opts.request;
  return {
    prompt: r.prompt,
    ...(r.task ? { task: r.task } : {}),
    ...(r.aspectRatio ? { aspect_ratio: r.aspectRatio } : {}),
    ...(r.resolution ? { resolution: r.resolution } : {}),
    ...(r.durationSeconds !== undefined ? { duration_seconds: r.durationSeconds } : {}),
    ...(opts.imagePaths?.length ? { images: opts.imagePaths.map((p) => path.basename(p)) } : {}),
    ...(opts.videoPath ? { video: path.basename(opts.videoPath) } : {}),
  };
}

/**
 * Generate, edit or extend a video with Gemini Omni. Returns the saved path
 * (undefined with `wait: false`) and the interaction id.
 */
export async function runOmniVideo(
  opts: OmniRunOptions,
): Promise<{ interactionId?: string; dest?: string; recordPath: string }> {
  const { logger, request } = opts;
  const store = request.store ?? true;
  checkOmniMedia(opts);
  if (!store && !opts.wait) {
    throw new ValidationError("--no-wait needs a stored interaction; drop --no-store");
  }
  const deadline = Date.now() + opts.waitTimeoutMs;

  const submit = async (key: GeminiKeyChoice) => {
    const media = await buildMediaParts(opts, key.apiKey, logger);
    const body = buildOmniRequest({ ...request, media });
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ProviderError(
        `--wait-timeout (${opts.waitTimeoutMs} ms) ran out before the request was sent; nothing was submitted`,
        "gemini",
      );
    }
    // The deadline decides whether a stored request is sent, never how long it
    // may take: cutting off an accepted submit would lose the id of a billed
    // job. An unstored request holds the connection until the video is done.
    const resp = (await createInteraction(body, {
      apiKey: key.apiKey,
      timeoutMs: store ? SUBMIT_TIMEOUT_MS : remainingMs,
      maxBytes: interactionMaxBytes(),
    })) as Interaction;
    return { ...key, resp };
  };

  // A follow-up must run in the project that stored its parent. The lookup is
  // read-only, so its failures are not reported as a possibly billed submit.
  let parent: GeminiKeyChoice | undefined;
  if (request.previousInteractionId) {
    const found = await findInteractionKey(request.previousInteractionId, logger, {
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (found.interaction.status !== "completed") {
      throw new ValidationError(
        `Interaction ${request.previousInteractionId} is ${found.interaction.status ?? "not completed"}; only a completed interaction can be edited or extended`,
      );
    }
    parent = { apiKey: found.apiKey, keyName: found.keyName };
  }

  let accepted: GeminiKeyChoice & { resp: Interaction };
  try {
    if (parent) {
      accepted = await submit(parent);
    } else {
      accepted = await withGeminiKey((apiKey, keyName) => submit({ apiKey, keyName }), {
        logger,
      });
    }
  } catch (error) {
    throw submitError(oversizedInteraction(error));
  }

  const { apiKey, keyName } = accepted;
  let interaction = accepted.resp;
  const interactionId =
    typeof interaction?.id === "string" && interaction.id ? interaction.id : undefined;
  // A stored interaction is polled by id; an unstored one answers synchronously.
  if (store ? !interactionId : !isTerminalInteraction(interaction?.status)) {
    throw new ProviderError(
      store ? "Gemini Omni returned no interaction id" : "Gemini Omni returned no finished video",
      "gemini",
    );
  }

  const outDir = getOutputDir();
  const base = `gemini_omni_${outputStamp()}`;
  const recordPath = path.join(outDir, `${base}.json`);
  const record: OmniSessionRecord = {
    provider: "gemini",
    ...(interactionId ? { interaction_id: interactionId } : {}),
    ...(request.previousInteractionId
      ? { parent_interaction_id: request.previousInteractionId }
      : {}),
    model: request.model,
    key_alias: keyName,
    status: interaction.status ?? "in_progress",
    store,
    created_at: nowIso(),
    updated_at: nowIso(),
    request: requestSummary(opts),
  };
  // The job is accepted and billed: show its id even if the record cannot be written.
  if (interactionId) logger.info(`Interaction ID: ${interactionId}`);
  try {
    writeRecord(recordPath, record);
    logger.info(`Session record: ${recordPath}`);
  } catch (error) {
    logger.warn(`Could not write the session record ${recordPath}: ${(error as Error).message}`);
  }
  if (!store) logger.warn("--no-store: this video cannot be edited, extended or resumed later");

  if (!opts.wait && interactionId) {
    logger.info(`Resume with: ${resumeCommand(interactionId)}`);
    return { interactionId, recordPath };
  }

  if (interactionId && !isTerminalInteraction(interaction.status)) {
    logger.info("Generating video with Gemini Omni (usually under a few minutes)...");
    try {
      interaction = await waitForInteraction(
        interactionId,
        apiKey,
        Math.max(1, deadline - Date.now()),
        logger,
      );
    } catch (error) {
      if (error instanceof PollTimeoutError) writeRecord(recordPath, record);
      throw error;
    }
  }

  record.status = interaction.status ?? "unknown";
  record.usage = interaction.usage;
  const cost = estimateOmniCost(interaction.usage);
  if (cost) record.cost_estimate = cost;
  if (interaction.status !== "completed") {
    record.error = interactionFailureMessage(interaction);
    writeRecord(recordPath, record);
    throw new ProviderJobFailedError(record.error, "gemini", {
      terminal: isTerminalInteraction(interaction.status) && interaction.status !== "cancelled",
    });
  }

  const dest = path.join(outDir, `${base}.mp4`);
  const saved = await saveOmniVideo(interaction, apiKey, dest, logger);
  record.output_path = dest;
  if (saved.mediaFile) record.media_file = saved.mediaFile;
  writeRecord(recordPath, record);
  logger.success(`Saved video: ${dest}`);
  if (cost) logger.debug(`Estimated cost: $${cost.usd.toFixed(4)} (${cost.basis})`);
  copyToOutput(dest, opts.output, logger);
  return { interactionId, dest, recordPath };
}

/** Poll GET /interactions/{id} until a terminal status (bounded). */
export async function waitForInteraction(
  interactionId: string,
  apiKey: string,
  timeoutMs: number,
  logger: Logger,
  sleep?: (ms: number) => Promise<void>,
  resume: ResumeCommand = resumeCommand,
): Promise<Interaction> {
  return pollUntil<Interaction>({
    // The final GET may carry the video inline, so its body gets the rest of
    // the wait instead of a per-request limit that would cut it off and
    // download it again on every poll.
    fetchStatus: ({ remainingMs }) =>
      getInteraction(interactionId, {
        apiKey,
        ...interactionReadLimits(remainingMs),
      }).catch((error: unknown) => {
        throw oversizedInteraction(error, interactionId, resume);
      }) as Promise<Interaction>,
    isTerminal: (it) => isTerminalInteraction(it.status),
    timeoutMs,
    intervalMs: 5_000,
    maxIntervalMs: 15_000,
    sleep,
    onPoll: (it, attempt) => logger.debug(`Status ${it.status ?? "?"} (poll ${attempt})`),
    resumeHint: `Interaction ${interactionId} is still running server-side. Resume with: ${resume(interactionId)}`,
  });
}

/**
 * Write the generated video to `dest`. A Files API URI is waited on until
 * ACTIVE and downloaded with the key (only ever sent to the Gemini API host;
 * downloadToFile drops it if a redirect leaves that origin). Inline base64 is
 * size-checked before it is decoded.
 */
export async function saveOmniVideo(
  interaction: Interaction,
  apiKey: string,
  dest: string,
  logger: Logger,
  sleep?: (ms: number) => Promise<void>,
): Promise<{ mediaFile?: string; bytes: number }> {
  const video = extractOmniVideo(interaction);
  if (!video) {
    throw new ProviderError(
      `Gemini Omni completed without a video. ${interactionFailureMessage(interaction)}`,
      "gemini",
    );
  }
  const maxBytes = maxDownloadBytes();
  if (video.data) {
    const bytes = base64DecodedBytes(video.data);
    if (bytes > maxBytes) {
      throw new ProviderError(
        `Inline video is ${bytes} bytes, over the ${maxBytes}-byte download limit (MULTIX_MAX_DOWNLOAD_MB)`,
        "gemini",
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(video.data, "base64"));
    return { bytes };
  }

  const uri = video.uri as string;
  const fileName = geminiFileNameFromUri(uri);
  if (!fileName) {
    // Not a Gemini Files API URI: never send the key, and only fetch over https.
    if (!uri.startsWith("https://")) {
      throw new ProviderError("Gemini Omni returned a non-https video URI", "gemini");
    }
    const result = await downloadToFile(uri, { dest, timeoutMs: DOWNLOAD_TIMEOUT_MS, maxBytes });
    return { bytes: result.bytes };
  }

  const file = await pollUntil({
    fetchStatus: ({ remainingMs }) =>
      getFile(fileName, { apiKey, timeoutMs: Math.min(remainingMs, 60_000) }),
    isTerminal: (f) => f.state !== "PROCESSING",
    timeoutMs: FILE_ACTIVE_TIMEOUT_MS,
    intervalMs: 2_000,
    maxIntervalMs: 10_000,
    sleep,
    onPoll: (f) => logger.debug(`Video file ${fileName} is ${f.state}`),
    resumeHint: `The video file is still processing. Resume with: ${resumeCommand(String(interaction.id))}`,
  });
  if (file.state !== "ACTIVE") {
    throw new ProviderError(`Generated video file ${fileName} is ${file.state}`, "gemini");
  }
  const result = await downloadToFile(fileDownloadUrl(fileName), {
    dest,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    headers: { "x-goog-api-key": apiKey },
    maxBytes,
  });
  return { mediaFile: fileName, bytes: result.bytes };
}

export function copyToOutput(dest: string, output: string | undefined, logger: Logger): void {
  if (!output) return;
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.copyFileSync(dest, output);
  logger.success(`Copied to: ${output}`);
}
