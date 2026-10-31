/**
 * Lyria RealTime (`lyria-realtime-exp`): instrumental music streamed over the
 * Gemini Live Music WebSocket (BidiGenerateMusic), runtime-neutral (no node:*
 * imports). The caller supplies the WebSocket constructor, receives raw PCM
 * chunks and decides where they go.
 *
 * Protocol (as the official @google/genai SDK speaks it):
 *   client → {setup: {model}}                       then wait for {setupComplete}
 *   client → {clientContent: {weightedPrompts}}     steer (weights are normalised by the server)
 *   client → {musicGenerationConfig: {...}}         bpm, density, brightness, scale, …
 *   client → {playbackControl: "PLAY"|"PAUSE"|"STOP"|"RESET_CONTEXT"}
 *   server → {serverContent: {audioChunks: [{data, mimeType}]}}  base64 16-bit PCM, 48 kHz stereo
 *   server → {filteredPrompt: {text, filteredReason}}
 *
 * The server generates faster than real time, so a recording of N seconds
 * stops once N seconds of audio have arrived. A session is never reconnected
 * or restarted on its own: a dropped connection ends the recording with what
 * arrived, so nothing is generated (or billed) twice.
 *
 * Reference: https://ai.google.dev/gemini-api/docs/realtime-music-generation
 */

import { ProviderError, ValidationError } from "../../core/errors.js";

export const LYRIA_REALTIME_MODEL = "lyria-realtime-exp";
export const LYRIA_REALTIME_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateMusic";

export const REALTIME_SAMPLE_RATE = 48_000;
export const REALTIME_CHANNELS = 2;
export const REALTIME_BITS_PER_SAMPLE = 16;
const BYTES_PER_FRAME = (REALTIME_CHANNELS * REALTIME_BITS_PER_SAMPLE) / 8;
export const REALTIME_BYTES_PER_SECOND = REALTIME_SAMPLE_RATE * BYTES_PER_FRAME;

/** Longest recording one run makes (a WAV of about 115 MB). */
export const REALTIME_MAX_SECONDS = 600;

export const REALTIME_SCALES = [
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
  "SCALE_UNSPECIFIED",
] as const;

export const REALTIME_MODES = ["QUALITY", "DIVERSITY", "VOCALIZATION"] as const;

export interface WeightedPrompt {
  text: string;
  weight: number;
}

/** LiveMusicGenerationConfig fields, camelCase as sent on the wire. */
export interface MusicGenerationConfig {
  guidance?: number;
  bpm?: number;
  density?: number;
  brightness?: number;
  scale?: (typeof REALTIME_SCALES)[number];
  muteBass?: boolean;
  muteDrums?: boolean;
  onlyBassAndDrums?: boolean;
  musicGenerationMode?: (typeof REALTIME_MODES)[number];
  temperature?: number;
  topK?: number;
  seed?: number;
}

/** A change applied once `at` seconds of audio have been recorded. */
export interface SessionChange {
  at: number;
  prompts?: WeightedPrompt[];
  config?: MusicGenerationConfig;
}

export interface SessionPlan {
  prompts: WeightedPrompt[];
  config?: MusicGenerationConfig;
  changes?: SessionChange[];
  /** Seconds of audio to record. */
  durationSeconds: number;
}

const NUMBER_RANGES: Record<string, [number, number, boolean]> = {
  // field: [min, max, integer]
  guidance: [0, 6, false],
  bpm: [60, 200, true],
  density: [0, 1, false],
  brightness: [0, 1, false],
  temperature: [0, 3, false],
  topK: [1, 1000, true],
  seed: [0, 2_147_483_647, true],
};
const BOOLEAN_FIELDS = ["muteBass", "muteDrums", "onlyBassAndDrums"];

/** Snake-case spellings accepted from a prompts file (the Python SDK's names). */
const CONFIG_ALIASES: Record<string, string> = {
  top_k: "topK",
  mute_bass: "muteBass",
  mute_drums: "muteDrums",
  only_bass_and_drums: "onlyBassAndDrums",
  music_generation_mode: "musicGenerationMode",
};

/** Validate a config against the documented ranges; unknown fields are refused, not dropped. */
export function validateMusicConfig(raw: unknown, where = "config"): MusicGenerationConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${where} must be an object`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = CONFIG_ALIASES[key] ?? key;
    const range = NUMBER_RANGES[field];
    if (range) {
      const [min, max, integer] = range;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
      ) {
        throw new ValidationError(
          `${where}.${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`,
        );
      }
    } else if (BOOLEAN_FIELDS.includes(field)) {
      if (typeof value !== "boolean")
        throw new ValidationError(`${where}.${key} must be a boolean`);
    } else if (field === "scale") {
      if (!(REALTIME_SCALES as readonly unknown[]).includes(value)) {
        throw new ValidationError(`${where}.${key} must be one of: ${REALTIME_SCALES.join(", ")}`);
      }
    } else if (field === "musicGenerationMode") {
      if (!(REALTIME_MODES as readonly unknown[]).includes(value)) {
        throw new ValidationError(`${where}.${key} must be one of: ${REALTIME_MODES.join(", ")}`);
      }
    } else {
      throw new ValidationError(`${where}.${key} is not a Lyria RealTime setting`);
    }
    out[field] = value;
  }
  return out as MusicGenerationConfig;
}

export function validateWeightedPrompts(raw: unknown, where = "prompts"): WeightedPrompt[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError(`${where} must be a non-empty array of {text, weight}`);
  }
  const prompts = raw.map((p, i) => {
    const o = p as { text?: unknown; weight?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.text !== "string" || !o.text.trim()) {
      throw new ValidationError(`${where}[${i}].text must be a non-empty string`);
    }
    const extra = Object.keys(o).filter((k) => k !== "text" && k !== "weight");
    if (extra.length > 0)
      throw new ValidationError(`${where}[${i}] has unknown fields: ${extra.join(", ")}`);
    const weight = o.weight ?? 1;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight === 0) {
      throw new ValidationError(`${where}[${i}].weight must be a non-zero number`);
    }
    return { text: o.text.trim(), weight };
  });
  if (prompts.reduce((sum, p) => sum + p.weight, 0) <= 0) {
    throw new ValidationError(`${where}: the weights must add up to more than 0`);
  }
  return prompts;
}

/** Validate a whole session plan, including timed changes inside the recording. */
export function validateSessionPlan(plan: SessionPlan): SessionPlan {
  const { durationSeconds } = plan;
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    durationSeconds > REALTIME_MAX_SECONDS
  ) {
    throw new ValidationError(`--duration must be from 1 to ${REALTIME_MAX_SECONDS} seconds`);
  }
  const prompts = validateWeightedPrompts(plan.prompts);
  const config = plan.config ? validateMusicConfig(plan.config) : undefined;
  const changes = (plan.changes ?? []).map((c, i) => {
    const where = `changes[${i}]`;
    if (
      typeof c.at !== "number" ||
      !Number.isFinite(c.at) ||
      c.at <= 0 ||
      c.at >= durationSeconds
    ) {
      throw new ValidationError(`${where}.at must be a number of seconds inside the recording`);
    }
    if (!c.prompts && !c.config) throw new ValidationError(`${where} needs prompts or config`);
    return {
      at: c.at,
      ...(c.prompts ? { prompts: validateWeightedPrompts(c.prompts, `${where}.prompts`) } : {}),
      ...(c.config ? { config: validateMusicConfig(c.config, `${where}.config`) } : {}),
    };
  });
  changes.sort((a, b) => a.at - b.at);
  return { prompts, ...(config ? { config } : {}), changes, durationSeconds };
}

/** The JSON a prompts file holds: {prompts, config?, changes?}. */
export function parsePromptsFile(raw: unknown): Omit<SessionPlan, "durationSeconds"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(
      "--prompts-file must hold a JSON object {prompts, config?, changes?}",
    );
  }
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["prompts", "config", "changes"].includes(k));
  if (extra.length > 0) {
    throw new ValidationError(`--prompts-file has unknown fields: ${extra.join(", ")}`);
  }
  if (o.changes !== undefined && !Array.isArray(o.changes)) {
    throw new ValidationError("--prompts-file changes must be an array");
  }
  return {
    prompts: o.prompts as WeightedPrompt[],
    ...(o.config !== undefined ? { config: o.config as MusicGenerationConfig } : {}),
    ...(o.changes !== undefined ? { changes: o.changes as SessionChange[] } : {}),
  };
}

/** bpm and scale only take effect after a context reset (or stop/play). */
function needsReset(config: MusicGenerationConfig | undefined): boolean {
  return config?.bpm !== undefined || config?.scale !== undefined;
}

/** The subset of the WHATWG WebSocket the session uses (Node 22+ global, browsers, Workers). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SessionEvents {
  /** Raw 16-bit little-endian PCM, 48 kHz stereo; never more than the plan asks for. */
  onAudio(pcm: Uint8Array): void;
  onFilteredPrompt?(text: string, reason: string): void;
  onChange?(change: SessionChange): void;
  debug?(message: string): void;
}

export type StopReason = "complete" | "stopped" | "closed";

export interface SessionResult {
  reason: StopReason;
  /** Audio bytes delivered to onAudio. */
  bytes: number;
  seconds: number;
}

export interface SessionOptions {
  apiKey: string;
  plan: SessionPlan;
  events: SessionEvents;
  createWebSocket: WebSocketFactory;
  /** Time allowed for the socket to open and answer setup. */
  setupTimeoutMs?: number;
  /** Longest gap between audio chunks once playing. */
  idleTimeoutMs?: number;
  /** Test seam for timers. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Check a chunk's mime (e.g. `audio/l16;rate=48000;channels=2`) against the fixed WAV layout. */
export function checkChunkMime(mime: string | undefined): void {
  if (!mime) return;
  const rate = /rate=(\d+)/i.exec(mime)?.[1];
  const channels = /channels=(\d+)/i.exec(mime)?.[1];
  if (
    (rate && Number(rate) !== REALTIME_SAMPLE_RATE) ||
    (channels && Number(channels) !== REALTIME_CHANNELS)
  ) {
    throw new ProviderError(`Unexpected Lyria RealTime audio format: ${mime}`, "gemini");
  }
}

/**
 * One headless recording session. `start()` resolves when the planned length
 * has been recorded, `stop()` was called, or the server closed the socket; it
 * rejects on setup failure, a protocol error or an idle stream. The socket is
 * closed in every case.
 */
export class LyriaRealtimeSession {
  private ws: WebSocketLike | undefined;
  private bytes = 0;
  private readonly targetBytes: number;
  private nextChange = 0;
  private settled = false;
  private timer: unknown;
  private resolveFn: ((r: SessionResult) => void) | undefined;
  private rejectFn: ((e: Error) => void) | undefined;
  private readonly plan: SessionPlan;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly opts: SessionOptions) {
    this.plan = validateSessionPlan(opts.plan);
    const frames = Math.round(this.plan.durationSeconds * REALTIME_SAMPLE_RATE);
    this.targetBytes = frames * BYTES_PER_FRAME;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get recordedBytes(): number {
    return this.bytes;
  }

  start(): Promise<SessionResult> {
    if (this.ws) throw new Error("Session already started");
    return new Promise<SessionResult>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
      const url = `${LYRIA_REALTIME_URL}?key=${encodeURIComponent(this.opts.apiKey)}`;
      let ws: WebSocketLike;
      try {
        ws = this.opts.createWebSocket(url);
      } catch (e) {
        this.fail(
          new ProviderError(`Could not open the Lyria RealTime socket: ${this.scrub(e)}`, "gemini"),
        );
        return;
      }
      this.ws = ws;
      this.arm(this.opts.setupTimeoutMs ?? 30_000, "Lyria RealTime setup timed out");
      ws.addEventListener("open", () => {
        this.debug("socket open; sending setup");
        this.send({ setup: { model: `models/${LYRIA_REALTIME_MODEL}` } });
      });
      ws.addEventListener("message", (event) => this.onMessage(event.data));
      ws.addEventListener("error", (event) => {
        const msg = (event as { message?: unknown })?.message;
        this.fail(
          new ProviderError(
            `Lyria RealTime socket error${typeof msg === "string" ? `: ${this.scrub(msg)}` : ""}`,
            "gemini",
          ),
        );
      });
      ws.addEventListener("close", (event) => {
        if (this.settled) return;
        const code = event?.code ?? 0;
        const reason = event?.reason ? `: ${this.scrub(event.reason)}` : "";
        if (this.bytes === 0) {
          this.fail(
            new ProviderError(
              `Lyria RealTime closed the session (code ${code})${reason}`,
              "gemini",
            ),
          );
        } else {
          this.debug(`server closed the session (code ${code})${reason}`);
          this.finish("closed");
        }
      });
    });
  }

  /** End the recording now (a signal, the user); keeps what arrived. */
  stop(): void {
    if (this.settled) return;
    this.finish("stopped");
  }

  private onMessage(data: unknown): void {
    if (this.settled) return;
    // The server sends JSON in binary frames; factories should set binaryType
    // "arraybuffer", but a Blob is read as text too.
    if (data && typeof (data as Blob).text === "function" && typeof data !== "string") {
      (data as Blob).text().then(
        (text) => this.onMessage(text),
        () => this.fail(new ProviderError("Could not read a Lyria RealTime message", "gemini")),
      );
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.fail(new ProviderError("Lyria RealTime sent a message that is not JSON", "gemini"));
      return;
    }
    if (msg.setupComplete !== undefined) {
      this.debug("setup complete; starting playback");
      this.sendPrompts(this.plan.prompts);
      if (this.plan.config) this.sendConfig(this.plan.config);
      this.send({ playbackControl: "PLAY" });
      this.arm(this.opts.idleTimeoutMs ?? 30_000, "Lyria RealTime sent no audio");
    }
    const filtered = msg.filteredPrompt as { text?: unknown; filteredReason?: unknown } | undefined;
    if (filtered) {
      this.opts.events.onFilteredPrompt?.(
        typeof filtered.text === "string" ? filtered.text : "",
        typeof filtered.filteredReason === "string" ? filtered.filteredReason : "filtered",
      );
    }
    const content = msg.serverContent as { audioChunks?: unknown } | undefined;
    if (Array.isArray(content?.audioChunks)) {
      for (const chunk of content.audioChunks as { data?: unknown; mimeType?: unknown }[]) {
        if (this.settled) return;
        if (typeof chunk?.data !== "string" || chunk.data.length === 0) continue;
        try {
          checkChunkMime(typeof chunk.mimeType === "string" ? chunk.mimeType : undefined);
          this.onAudio(decodeBase64(chunk.data));
        } catch (e) {
          this.fail(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
    }
  }

  private onAudio(pcm: Uint8Array): void {
    const room = this.targetBytes - this.bytes;
    // Keep whole frames so the channels never swap.
    const take = Math.min(pcm.length - (pcm.length % BYTES_PER_FRAME), room);
    if (take > 0) {
      this.opts.events.onAudio(take === pcm.length ? pcm : pcm.subarray(0, take));
      this.bytes += take;
    }
    if (this.bytes >= this.targetBytes) {
      this.finish("complete");
      return;
    }
    this.arm(this.opts.idleTimeoutMs ?? 30_000, "Lyria RealTime sent no audio");
    const changes = this.plan.changes ?? [];
    while (this.nextChange < changes.length) {
      const change = changes[this.nextChange] as SessionChange;
      if (this.bytes < change.at * REALTIME_BYTES_PER_SECOND) break;
      this.nextChange++;
      if (change.prompts) this.sendPrompts(change.prompts);
      if (change.config) this.sendConfig(change.config);
      this.opts.events.onChange?.(change);
    }
  }

  private sendPrompts(prompts: WeightedPrompt[]): void {
    this.send({ clientContent: { weightedPrompts: prompts } });
  }

  private sendConfig(config: MusicGenerationConfig): void {
    this.send({ musicGenerationConfig: config });
    if (needsReset(config)) this.send({ playbackControl: "RESET_CONTEXT" });
  }

  private send(message: unknown): void {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  private arm(ms: number, message: string): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      if (this.bytes > 0) {
        this.debug(`${message} for ${ms} ms; ending the recording`);
        this.finish("closed");
      } else {
        this.fail(new ProviderError(message, "gemini"));
      }
    }, ms);
  }

  private teardown(): void {
    this.settled = true;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (this.ws && this.ws.readyState === OPEN) {
      try {
        this.ws.send(JSON.stringify({ playbackControl: "STOP" }));
      } catch {
        // Closing below is what matters.
      }
    }
    try {
      this.ws?.close(1000, "done");
    } catch {
      // Already closed.
    }
  }

  private finish(reason: StopReason): void {
    if (this.settled) return;
    this.teardown();
    this.resolveFn?.({
      reason,
      bytes: this.bytes,
      seconds: this.bytes / REALTIME_BYTES_PER_SECOND,
    });
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.teardown();
    this.rejectFn?.(error);
  }

  /** Error text from the socket layer may echo the URL, which carries the key. */
  private scrub(value: unknown): string {
    const text = value instanceof Error ? value.message : String(value);
    const key = this.opts.apiKey;
    let out = key
      ? text.split(key).join("[redacted]").split(encodeURIComponent(key)).join("[redacted]")
      : text;
    out = out.replace(/([?&]key=)[^&\s"']+/g, "$1[redacted]");
    return out.slice(0, 300);
  }

  private debug(message: string): void {
    this.opts.events.debug?.(message);
  }
}
