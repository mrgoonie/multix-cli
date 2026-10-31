/**
 * Lyria RealTime recording (Node side): runs one headless session and streams
 * its PCM into a WAV file. The header is written first with placeholder sizes
 * and finalised when the session ends: on completion, on a dropped connection,
 * on an error after audio arrived, and on SIGINT/SIGTERM/SIGHUP (the socket is
 * closed and the signal re-raised). Writes are synchronous, so no chunk is
 * buffered in memory and nothing is lost on a signal.
 */

import fs from "node:fs";
import path from "node:path";
import { run } from "../../../agent/run-state.js";
import { ConfigError } from "../../../core/errors.js";
import { guardExternalRun } from "../../../core/external-run-guard.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import { withGeminiKey } from "../key-pool.js";
import {
  LYRIA_REALTIME_MODEL,
  LYRIA_REALTIME_URL,
  LyriaRealtimeSession,
  REALTIME_BITS_PER_SAMPLE,
  REALTIME_BYTES_PER_SECOND,
  REALTIME_CHANNELS,
  REALTIME_SAMPLE_RATE,
  type SessionPlan,
  type StopReason,
  type WebSocketFactory,
  type WebSocketLike,
} from "../lyria-realtime.js";
import { wrapPcmInWav } from "./speech.js";

const WAV_HEADER_BYTES = 44;

/** A WAV file written as PCM arrives; `finish()` fixes the sizes in the header. */
export class StreamingWavWriter {
  private fd: number | undefined;
  private dataBytes = 0;

  constructor(
    readonly file: string,
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly bitsPerSample: number,
  ) {
    this.fd = fs.openSync(file, "w");
    fs.writeSync(this.fd, this.header());
  }

  get bytes(): number {
    return this.dataBytes;
  }

  write(pcm: Uint8Array): void {
    if (this.fd === undefined) return;
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  /** Rewrite the header with the final sizes and close the file; safe to call twice. */
  finish(): void {
    if (this.fd === undefined) return;
    const fd = this.fd;
    this.fd = undefined;
    try {
      fs.writeSync(fd, this.header(), 0, WAV_HEADER_BYTES, 0);
    } finally {
      fs.closeSync(fd);
    }
  }

  private header(): Buffer {
    const header = wrapPcmInWav(
      Buffer.alloc(0),
      this.sampleRate,
      this.channels,
      this.bitsPerSample,
    );
    header.writeUInt32LE(36 + this.dataBytes, 4);
    header.writeUInt32LE(this.dataBytes, 40);
    return header;
  }
}

/** The runtime's WebSocket (Node 22+, Deno, Bun); Node 20 has none without a flag. */
export function nodeWebSocketFactory(): WebSocketFactory {
  const Ctor = (
    globalThis as { WebSocket?: new (url: string) => WebSocketLike & { binaryType: string } }
  ).WebSocket;
  if (typeof Ctor !== "function") {
    throw new ConfigError(
      "gemini music-live needs a runtime with a global WebSocket (Node.js 22 or newer)",
    );
  }
  return (url) => {
    const ws = new Ctor(url);
    ws.binaryType = "arraybuffer";
    return ws;
  };
}

export interface MusicLiveOpts {
  plan: SessionPlan;
  output?: string;
  logger?: Logger;
  /** Test seam; defaults to the runtime's WebSocket. */
  createWebSocket?: WebSocketFactory;
  /** Test seam: signals to stop on (default SIGINT, SIGTERM, SIGHUP). */
  signals?: NodeJS.Signals[];
  /** Test seam: how a signal ends the process (default process.exit, through the agent runtime). */
  exit?: (code: number) => void;
  idleTimeoutMs?: number;
  setupTimeoutMs?: number;
}

export interface MusicLiveResult {
  generatedAudio: string;
  output?: string;
  reason: StopReason;
  seconds: number;
}

const SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
/** Shell exit status for a run stopped by each signal: 128 + the signal number. */
const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

function copyToOutput(dest: string, output: string): void {
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.copyFileSync(dest, output);
}

export async function recordGeminiMusicLive(opts: MusicLiveOpts): Promise<MusicLiveResult> {
  const { logger } = opts;
  // The session is a WebSocket, not a fetch: a --dry-run stops here, before connecting.
  guardExternalRun({
    program: LYRIA_REALTIME_URL,
    args: [
      JSON.stringify({ setup: { model: `models/${LYRIA_REALTIME_MODEL}` } }),
      JSON.stringify({ clientContent: { weightedPrompts: opts.plan.prompts } }),
      ...(opts.plan.config ? [JSON.stringify({ musicGenerationConfig: opts.plan.config })] : []),
      JSON.stringify({ playbackControl: "PLAY" }),
      `duration_seconds=${opts.plan.durationSeconds}`,
      `changes=${opts.plan.changes?.length ?? 0}`,
    ],
  });
  const createWebSocket = opts.createWebSocket ?? nodeWebSocketFactory();
  const dest = path.join(getOutputDir(), `gemini_music_live_${outputStamp()}.wav`);

  return withGeminiKey(
    async (apiKey) => {
      const writer = new StreamingWavWriter(
        dest,
        REALTIME_SAMPLE_RATE,
        REALTIME_CHANNELS,
        REALTIME_BITS_PER_SAMPLE,
      );
      const session = new LyriaRealtimeSession({
        apiKey,
        plan: opts.plan,
        createWebSocket,
        idleTimeoutMs: opts.idleTimeoutMs,
        setupTimeoutMs: opts.setupTimeoutMs,
        events: {
          onAudio: (pcm) => writer.write(pcm),
          onFilteredPrompt: (text, reason) =>
            logger?.warn(
              `Lyria filtered a prompt (${reason})${text ? `: ${text.slice(0, 80)}` : ""}`,
            ),
          onChange: (change) =>
            logger?.info(
              `At ${change.at}s: ${[change.prompts ? "prompts" : "", change.config ? "config" : ""].filter(Boolean).join(" + ")} updated`,
            ),
          debug: (message) => logger?.debug(message),
        },
      });

      // A signal ends the session cleanly: close the socket, finalise the WAV,
      // copy it to --output, then exit with 128 + n through the agent runtime
      // so the envelope and history still record the run.
      const signals = opts.signals ?? SIGNALS;
      const exit = opts.exit ?? ((code: number) => process.exit(code));
      const onSignal = (signal: NodeJS.Signals) => {
        removeHandlers();
        session.stop();
        writer.finish();
        const seconds = (writer.bytes / REALTIME_BYTES_PER_SECOND).toFixed(1);
        let saved = dest;
        if (opts.output && writer.bytes > 0) {
          try {
            copyToOutput(dest, opts.output);
            saved = opts.output;
          } catch (e) {
            logger?.warn(`Could not copy to ${opts.output}: ${(e as Error).message}`);
          }
        }
        if (writer.bytes === 0) fs.rmSync(dest, { force: true });
        process.stderr.write(
          writer.bytes > 0
            ? `${signal}: recording stopped at ${seconds}s; saved ${saved}\n`
            : `${signal}: recording stopped before any audio arrived\n`,
        );
        run.interrupted = {
          hint:
            writer.bytes > 0
              ? `The recording was stopped by ${signal} after ${seconds}s and saved to ${saved}.`
              : `The recording was stopped by ${signal} before any audio arrived.`,
          retryable: false,
        };
        exit(SIGNAL_EXIT[signal] ?? 130);
      };
      const removeHandlers = () => {
        for (const s of signals) process.removeListener(s, onSignal);
      };
      for (const s of signals) process.once(s, onSignal);

      try {
        logger?.info(
          `Recording ${opts.plan.durationSeconds}s of Lyria RealTime (instrumental, 48 kHz stereo)...`,
        );
        const result = await session.start();
        writer.finish();
        if (result.reason !== "complete") {
          logger?.warn(
            `Session ended early (${result.reason}) after ${result.seconds.toFixed(1)}s; it was not restarted.`,
          );
        }
        logger?.success(`Saved: ${dest} (${(writer.bytes / 1024 / 1024).toFixed(1)} MB)`);
        let output: string | undefined;
        if (opts.output) {
          copyToOutput(dest, opts.output);
          output = opts.output;
          logger?.success(`Copied to: ${opts.output}`);
        }
        return {
          generatedAudio: dest,
          ...(output ? { output } : {}),
          reason: result.reason,
          seconds: result.seconds,
        };
      } catch (e) {
        writer.finish();
        if (writer.bytes === 0) {
          fs.rmSync(dest, { force: true });
        } else {
          logger?.warn(`Partial recording kept: ${dest}`);
        }
        throw e;
      } finally {
        removeHandlers();
      }
    },
    { logger },
  );
}
