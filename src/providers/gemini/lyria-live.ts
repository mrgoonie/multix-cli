/**
 * Lyria RealTime (`lyria-realtime-exp`) WebSocket protocol: real-time
 * instrumental music streamed as raw PCM.
 *
 * Runtime-neutral (no `node:*` imports): the caller injects the WebSocket
 * factory and receives PCM chunks through a callback, so the CLI writes them to
 * disk while other runtimes can do something else with them.
 *
 * Protocol (BidiGenerateMusic, mirrored from the @google/genai `LiveMusic` SDK):
 *   client → {"setup":{"model":"models/<id>"}}            server → {"setupComplete":{}}
 *   client → {"clientContent":{"weightedPrompts":[...]}}  (at least one prompt)
 *   client → {"musicGenerationConfig":{...}}              (whole config; omitted fields reset)
 *   client → {"playbackControl":"PLAY"|"PAUSE"|"STOP"|"RESET_CONTEXT"}
 *   server → {"serverContent":{"audioChunks":[{"data":<base64>,"mimeType":...}]}}
 *   server → {"filteredPrompt":{"text":...,"filteredReason":...}} (prompt ignored)
 * Audio is 16-bit little-endian PCM, 48 kHz stereo unless the mime type says otherwise.
 *
 * The API key travels in the URL query string, so the URL is never logged and
 * any text that reaches a message (close reasons) is scrubbed of the key.
 */

import { z } from "zod";
import { ProviderError, ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { redactUrlsInText } from "../../core/redact.js";

export const LYRIA_REALTIME_MODEL = "lyria-realtime-exp";
export const LYRIA_REALTIME_MODELS: ReadonlySet<string> = new Set([LYRIA_REALTIME_MODEL]);
export const LYRIA_WS_BASE_URL = "wss://generativelanguage.googleapis.com";
export const LYRIA_API_VERSION = "v1beta";

export const LYRIA_DEFAULT_SAMPLE_RATE = 48_000;
export const LYRIA_DEFAULT_CHANNELS = 2;
export const LYRIA_BITS_PER_SAMPLE = 16;

export const LYRIA_DEFAULT_DURATION_SEC = 30;
export const LYRIA_MAX_DURATION_SEC = 600;
export const LYRIA_SETUP_TIMEOUT_MS = 30_000;
export const LYRIA_IDLE_TIMEOUT_MS = 30_000;

export const LYRIA_SCALES = [
  "SCALE_UNSPECIFIED",
  "C_MAJOR_A_MINOR",
  "D_FLAT_MAJOR_B_FLAT_MINOR",
  "D_MAJOR_B_MINOR",
  "E_FLAT_MAJOR_C_MINOR",
  "E_MAJOR_D_FLAT_MINOR",
  "F_MAJOR_D_MINOR",
  "G_FLAT_MAJOR_E_FLAT_MINOR",
  "G_MAJOR_E_MINOR",
  "A_FLAT_MAJOR_F_MINOR",
  "A_MAJOR_G_FLAT_MINOR",
  "B_FLAT_MAJOR_G_MINOR",
  "B_MAJOR_A_FLAT_MINOR",
] as const;
export type LyriaScale = (typeof LYRIA_SCALES)[number];

export const LYRIA_MODES = ["QUALITY", "DIVERSITY", "VOCALIZATION"] as const;
export type LyriaMode = (typeof LYRIA_MODES)[number];

const weightedPromptSchema = z
  .object({
    text: z.string().trim().min(1, "prompt text must not be empty"),
    weight: z
      .number()
      .finite()
      .refine((w) => w !== 0, "weight must not be 0")
      .default(1),
  })
  .strict();

export type WeightedPrompt = z.output<typeof weightedPromptSchema>;

export const lyriaMusicConfigSchema = z
  .object({
    guidance: z.number().min(0).max(6),
    bpm: z.number().int().min(60).max(200),
    density: z.number().min(0).max(1),
    brightness: z.number().min(0).max(1),
    scale: z.enum(LYRIA_SCALES),
    muteBass: z.boolean(),
    muteDrums: z.boolean(),
    onlyBassAndDrums: z.boolean(),
    musicGenerationMode: z.enum(LYRIA_MODES),
    temperature: z.number().min(0).max(3),
    topK: z.number().int().min(1).max(1000),
    seed: z.number().int().min(0).max(2_147_483_647),
  })
  .partial()
  .strict();

export type LyriaMusicConfig = z.output<typeof lyriaMusicConfigSchema>;

const timelineStepSchema = z
  .object({
    at: z.number().finite().min(0),
    prompts: z.array(weightedPromptSchema).min(1).optional(),
    config: lyriaMusicConfigSchema.optional(),
  })
  .strict()
  .refine((s) => s.prompts !== undefined || s.config !== undefined, {
    message: "a step needs prompts, config, or both",
  });

/** Schema of `--prompts-file`: a timeline of prompt/config changes. */
export const lyriaTimelineSchema = z
  .object({ steps: z.array(timelineStepSchema).min(1).max(100) })
  .strict();

export type LyriaTimeline = z.output<typeof lyriaTimelineSchema>;

/** One scheduled change: everything is sent once `at` seconds of audio are recorded. */
export interface LyriaPlanStep {
  at: number;
  prompts?: WeightedPrompt[];
  /** Full merged config (the server resets omitted fields). */
  config?: LyriaMusicConfig;
  /** bpm or scale changed mid-session: the model only applies those after RESET_CONTEXT. */
  resetContext: boolean;
}

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

function zodMessage(error: z.ZodError, where: string): string {
  const issues = error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
  return `Invalid ${where}: ${issues.join("; ")}`;
}

/** Validate a music generation config (flags or file), throwing ValidationError. */
export function validateLyriaConfig(config: unknown, where = "music config"): LyriaMusicConfig {
  const parsed = lyriaMusicConfigSchema.safeParse(config);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error, where));
  return parsed.data;
}

/** Validate one weighted prompt, throwing ValidationError. */
export function validateWeightedPrompt(prompt: unknown, where = "prompt"): WeightedPrompt {
  const parsed = weightedPromptSchema.safeParse(prompt);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error, where));
  return parsed.data;
}

/**
 * Validate a parsed `--prompts-file`: strict schema, step times strictly
 * increasing and below the recording duration.
 */
export function parseLyriaTimeline(json: unknown, durationSec: number): LyriaTimeline {
  const parsed = lyriaTimelineSchema.safeParse(json);
  if (!parsed.success) throw new ValidationError(zodMessage(parsed.error, "--prompts-file"));
  const { steps } = parsed.data;
  for (const [i, step] of steps.entries()) {
    const prev = steps[i - 1];
    if (prev && step.at <= prev.at) {
      throw new ValidationError(
        `Invalid --prompts-file: steps.${i}.at (${step.at}) must be greater than steps.${i - 1}.at (${prev.at})`,
      );
    }
    if (step.at >= durationSec) {
      throw new ValidationError(
        `Invalid --prompts-file: steps.${i}.at (${step.at}) must be below --duration (${durationSec})`,
      );
    }
  }
  return parsed.data;
}

/**
 * Turn flag prompts/config plus an optional timeline into the steps to send.
 * The first step (at 0) always carries prompts and the full config. Prompts at
 * 0 come from the flags or from a timeline step at 0, never both. Each later
 * config is merged into the previous one, so it is sent whole.
 */
export function buildLyriaPlan(
  flagPrompts: WeightedPrompt[],
  flagConfig: LyriaMusicConfig,
  timeline?: LyriaTimeline,
): LyriaPlanStep[] {
  const steps = timeline?.steps ?? [];
  const first = steps[0]?.at === 0 ? steps[0] : undefined;
  if (first?.prompts && flagPrompts.length > 0) {
    throw new ValidationError(
      "--prompt/--weighted-prompt conflict with the prompts of the --prompts-file step at 0; use one or the other",
    );
  }
  const initialPrompts = first?.prompts ?? flagPrompts;
  if (initialPrompts.length === 0) {
    throw new ValidationError(
      "At least one prompt is required at the start: use --prompt, --weighted-prompt, or a --prompts-file step at 0 with prompts",
    );
  }

  let config: LyriaMusicConfig = { ...flagConfig, ...first?.config };
  const plan: LyriaPlanStep[] = [{ at: 0, prompts: initialPrompts, config, resetContext: false }];
  for (const step of first ? steps.slice(1) : steps) {
    const out: LyriaPlanStep = { at: step.at, resetContext: false };
    if (step.prompts) out.prompts = step.prompts;
    if (step.config) {
      const next = { ...config, ...step.config };
      out.resetContext = next.bpm !== config.bpm || next.scale !== config.scale;
      config = next;
      out.config = config;
    }
    plan.push(out);
  }
  return plan;
}

/** WebSocket URL for BidiGenerateMusic. Contains the API key: never log it. */
export function buildLyriaLiveUrl(
  apiKey: string,
  baseUrl = LYRIA_WS_BASE_URL,
  apiVersion = LYRIA_API_VERSION,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateMusic?key=${encodeURIComponent(apiKey)}`;
}

export function lyriaSetupMessage(model: string): string {
  return JSON.stringify({
    setup: { model: model.startsWith("models/") ? model : `models/${model}` },
  });
}

export function lyriaPromptsMessage(prompts: WeightedPrompt[]): string {
  return JSON.stringify({
    clientContent: { weightedPrompts: prompts.map((p) => ({ text: p.text, weight: p.weight })) },
  });
}

export function lyriaConfigMessage(config: LyriaMusicConfig): string {
  return JSON.stringify({ musicGenerationConfig: config });
}

export type LyriaPlaybackControl = "PLAY" | "PAUSE" | "STOP" | "RESET_CONTEXT";

export function lyriaPlaybackMessage(control: LyriaPlaybackControl): string {
  return JSON.stringify({ playbackControl: control });
}

/** Sample rate and channel count from e.g. `audio/l16;rate=48000;channels=2`. */
export function parsePcmFormat(mimeType: string | undefined): PcmFormat {
  const rate = mimeType?.match(/rate=(\d+)/i)?.[1];
  const channels = mimeType?.match(/channels=(\d+)/i)?.[1];
  const sampleRate = rate ? Number.parseInt(rate, 10) : LYRIA_DEFAULT_SAMPLE_RATE;
  const ch = channels ? Number.parseInt(channels, 10) : LYRIA_DEFAULT_CHANNELS;
  return {
    sampleRate: sampleRate > 0 ? sampleRate : LYRIA_DEFAULT_SAMPLE_RATE,
    channels: ch > 0 ? ch : LYRIA_DEFAULT_CHANNELS,
  };
}

export function bytesPerSecond(format: PcmFormat): number {
  return format.sampleRate * format.channels * (LYRIA_BITS_PER_SAMPLE / 8);
}

export type LyriaServerEvent =
  | { type: "setupComplete" }
  | { type: "audio"; chunks: Array<{ pcm: Uint8Array; format: PcmFormat }> }
  | { type: "filteredPrompt"; text: string; reason: string }
  | { type: "warning"; message: string }
  | { type: "other" };

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Text of a WebSocket frame: string, ArrayBuffer, typed array/Buffer, or Blob. */
export async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  const blob = data as { text?: () => Promise<string> } | null;
  if (blob && typeof blob.text === "function") return blob.text();
  throw new ProviderError("Lyria sent a WebSocket frame of an unsupported type", "gemini");
}

/** Parse one server frame into the events this client acts on. Several may be present. */
export function parseLyriaServerMessage(text: string): LyriaServerEvent[] {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new ProviderError("Lyria sent a frame that is not JSON", "gemini");
  }
  if (!msg || typeof msg !== "object") return [{ type: "other" }];
  const m = msg as Record<string, unknown>;
  const events: LyriaServerEvent[] = [];
  if (m.setupComplete !== undefined) events.push({ type: "setupComplete" });

  const content = m.serverContent as { audioChunks?: unknown } | undefined;
  if (content && Array.isArray(content.audioChunks)) {
    const chunks: Array<{ pcm: Uint8Array; format: PcmFormat }> = [];
    for (const chunk of content.audioChunks as Array<Record<string, unknown>>) {
      if (!chunk || typeof chunk.data !== "string" || chunk.data.length === 0) continue;
      const mimeType = typeof chunk.mimeType === "string" ? chunk.mimeType : undefined;
      chunks.push({ pcm: base64ToBytes(chunk.data), format: parsePcmFormat(mimeType) });
    }
    if (chunks.length > 0) events.push({ type: "audio", chunks });
  }

  const filtered = m.filteredPrompt as Record<string, unknown> | undefined;
  if (filtered && typeof filtered === "object") {
    events.push({
      type: "filteredPrompt",
      text: typeof filtered.text === "string" ? filtered.text : "",
      reason: typeof filtered.filteredReason === "string" ? filtered.filteredReason : "unspecified",
    });
  }

  if (m.warning !== undefined) {
    events.push({
      type: "warning",
      message: typeof m.warning === "string" ? m.warning : JSON.stringify(m.warning),
    });
  }
  return events.length > 0 ? events : [{ type: "other" }];
}

/** The subset of the WHATWG WebSocket this client uses. */
export interface LyriaSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: LyriaSocketEvent) => void,
  ): void;
}

/** Fields read from WebSocket events: `data` on message, `code`/`reason` on close. */
export interface LyriaSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export type LyriaSocketFactory = (url: string) => LyriaSocket;

const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type LyriaEndReason =
  | "duration"
  | "aborted"
  | "server-closed"
  | "idle-timeout"
  | "setup-failed"
  | "error";

export interface LyriaLiveSessionOptions {
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  model: string;
  plan: LyriaPlanStep[];
  durationSec: number;
  createSocket: LyriaSocketFactory;
  /** Called in arrival order; the next chunk waits for the returned promise. */
  onAudio: (pcm: Uint8Array, format: PcmFormat) => void | Promise<void>;
  onWarning?: (message: string) => void;
  logger?: Logger;
  /** Aborting stops the session cleanly and keeps what was recorded. */
  signal?: AbortSignal;
  setupTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface LyriaLiveResult {
  /** PCM bytes passed to onAudio. */
  bytes: number;
  seconds: number;
  /** Format of the first chunk; undefined when no audio arrived. */
  format?: PcmFormat;
  endReason: LyriaEndReason;
  /** Set when the session ended abnormally (the recorded audio is still valid). */
  error?: Error;
  filteredPrompts: number;
}

function shorten(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Run one Lyria RealTime session until `durationSec` of audio is recorded, the
 * signal aborts, the server closes, or a timeout fires. Never reconnects (a
 * new session would bill and record again). Resolves in every case; the
 * caller decides what an `error` with or without audio means. On finish it
 * sends STOP and closes the socket.
 */
export function runLyriaLiveSession(opts: LyriaLiveSessionOptions): Promise<LyriaLiveResult> {
  const { apiKey, plan, logger } = opts;
  const setupTimeoutMs = opts.setupTimeoutMs ?? LYRIA_SETUP_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? LYRIA_IDLE_TIMEOUT_MS;
  const scrub = (text: string) =>
    redactUrlsInText(apiKey ? text.split(apiKey).join("[redacted]") : text);

  let bytes = 0;
  let format: PcmFormat | undefined;
  let targetBytes = Number.POSITIVE_INFINITY;
  let filteredPrompts = 0;
  let setupDone = false;
  let sawSocketError = false;
  let nextStep = 1;
  let done = false;
  let socket: LyriaSocket | undefined;
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Promise<LyriaLiveResult>((resolve) => {
    const seconds = () => (format ? bytes / bytesPerSecond(format) : 0);

    const finish = (endReason: LyriaEndReason, error?: Error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (socket) {
        try {
          if (socket.readyState === WS_OPEN) socket.send(lyriaPlaybackMessage("STOP"));
        } catch {
          // The socket is going away anyway; closing below is what matters.
        }
        try {
          if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
            socket.close(1000, "client finished");
          }
        } catch {
          // Already closed.
        }
      }
      logger?.debug(`Lyria session ended: ${endReason} after ${seconds().toFixed(2)}s`);
      // Let any in-flight onAudio settle so the caller finalizes a complete file.
      chain.then(() =>
        resolve({ bytes, seconds: seconds(), format, endReason, error, filteredPrompts }),
      );
    };

    const fail = (endReason: LyriaEndReason, message: string) =>
      finish(endReason, new ProviderError(scrub(message), "gemini"));

    const arm = (ms: number, onFire: () => void) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onFire, ms);
    };

    const armIdle = () =>
      arm(idleTimeoutMs, () =>
        fail("idle-timeout", `Lyria sent no audio for ${idleTimeoutMs / 1000}s; stopping`),
      );

    function onAbort() {
      finish("aborted");
    }

    const send = (message: string) => {
      if (!socket) return;
      socket.send(message);
    };

    const sendStep = (step: LyriaPlanStep) => {
      if (step.prompts) send(lyriaPromptsMessage(step.prompts));
      if (step.config) send(lyriaConfigMessage(step.config));
      if (step.resetContext) send(lyriaPlaybackMessage("RESET_CONTEXT"));
      logger?.debug(
        `Lyria step at ${step.at}s:${step.prompts ? ` ${step.prompts.length} prompt(s)` : ""}${step.config ? " config" : ""}${step.resetContext ? " reset-context" : ""}`,
      );
    };

    const handleAudio = async (chunks: Array<{ pcm: Uint8Array; format: PcmFormat }>) => {
      for (const chunk of chunks) {
        if (done) return;
        if (!format) {
          format = chunk.format;
          targetBytes = Math.round(opts.durationSec * format.sampleRate) * format.channels * 2;
        } else if (
          chunk.format.sampleRate !== format.sampleRate ||
          chunk.format.channels !== format.channels
        ) {
          fail(
            "error",
            `Lyria changed the audio format mid-stream (${format.sampleRate} Hz/${format.channels} ch to ${chunk.format.sampleRate} Hz/${chunk.format.channels} ch)`,
          );
          return;
        }
        const remaining = targetBytes - bytes;
        const pcm = chunk.pcm.length > remaining ? chunk.pcm.subarray(0, remaining) : chunk.pcm;
        await opts.onAudio(pcm, format);
        bytes += pcm.length;
        while (!done && nextStep < plan.length && (plan[nextStep]?.at ?? 0) <= seconds()) {
          const step = plan[nextStep++];
          if (step) sendStep(step);
        }
        if (bytes >= targetBytes) {
          finish("duration");
          return;
        }
      }
    };

    const handleFrame = async (data: unknown) => {
      if (done) return;
      const events = parseLyriaServerMessage(await frameText(data));
      for (const event of events) {
        if (done) return;
        switch (event.type) {
          case "setupComplete": {
            if (setupDone) break;
            setupDone = true;
            const first = plan[0];
            if (!first) {
              fail("error", "Lyria plan has no steps");
              return;
            }
            sendStep(first);
            send(lyriaPlaybackMessage("PLAY"));
            armIdle();
            break;
          }
          case "audio":
            if (!setupDone) break;
            armIdle();
            await handleAudio(event.chunks);
            break;
          case "filteredPrompt":
            filteredPrompts++;
            opts.onWarning?.(
              `Lyria filtered the prompt "${shorten(event.text)}" (${event.reason}); it is ignored`,
            );
            break;
          case "warning":
            opts.onWarning?.(`Lyria warning: ${scrub(event.message)}`);
            break;
          default:
            break;
        }
      }
    };

    if (opts.signal?.aborted) {
      finish("aborted");
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      socket = opts.createSocket(buildLyriaLiveUrl(apiKey, opts.baseUrl, opts.apiVersion));
      socket.binaryType = "arraybuffer";
    } catch (e) {
      socket = undefined;
      fail(
        "setup-failed",
        `Could not open the Lyria WebSocket: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    const ws = socket;

    arm(setupTimeoutMs, () =>
      fail("setup-failed", `Lyria did not complete setup within ${setupTimeoutMs / 1000}s`),
    );

    ws.addEventListener("open", () => {
      if (done) return;
      logger?.debug(`Lyria WebSocket open; sending setup for ${opts.model}`);
      try {
        send(lyriaSetupMessage(opts.model));
      } catch (e) {
        fail("setup-failed", `Could not send setup: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    ws.addEventListener("message", (event) => {
      chain = chain
        .then(() => handleFrame(event.data))
        .catch((e: unknown) => {
          fail("error", e instanceof Error ? e.message : String(e));
        });
    });

    ws.addEventListener("error", () => {
      sawSocketError = true;
      logger?.debug("Lyria WebSocket error event");
    });

    ws.addEventListener("close", (event) => {
      // Let frames that arrived before the close be processed first.
      chain = chain.then(() => {
        if (done) return;
        const code = event.code ?? 0;
        const reason = event.reason ? `: ${event.reason}` : "";
        const detail = `code ${code}${reason}${sawSocketError ? ", after a WebSocket error" : ""}`;
        if (!setupDone) {
          fail("setup-failed", `Lyria closed the connection before setup completed (${detail})`);
        } else if (code === 1000) {
          finish("server-closed");
        } else {
          fail("server-closed", `Lyria closed the connection (${detail})`);
        }
      });
    });
  });
}
