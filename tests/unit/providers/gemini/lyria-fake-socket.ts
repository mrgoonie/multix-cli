/**
 * In-memory stand-in for the Lyria RealTime WebSocket server, used by the
 * music-live tests. No network: the "server" side is driven by the test or by
 * the auto-responder (setupComplete on setup, audio frames after PLAY).
 */

import type { LyriaSocket, LyriaSocketEvent } from "../../../../src/providers/gemini/lyria-live.js";

type Listener = (event: LyriaSocketEvent) => void;

export interface AutoServerScript {
  /** Reply to setup with setupComplete (default true). */
  completeSetup?: boolean;
  /** PCM bytes per audio chunk (default 960 = 240 stereo frames). */
  chunkBytes?: number;
  /** Max chunks to stream after PLAY (default unlimited until closed). */
  maxChunks?: number;
  /** Send audio as binary (ArrayBuffer) JSON frames instead of text. */
  binary?: boolean;
  /** Close code sent once maxChunks were streamed (default: none, stream stops). */
  closeAfterChunks?: { code: number; reason: string };
  mimeType?: string;
}

export function pcmBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7 + seed) & 0xff;
  return out;
}

export function audioFrame(pcm: Uint8Array, mimeType = "audio/l16;rate=48000;channels=2"): object {
  return {
    serverContent: {
      audioChunks: [{ data: Buffer.from(pcm).toString("base64"), mimeType }],
    },
  };
}

export class FakeLyriaSocket implements LyriaSocket {
  static instances: FakeLyriaSocket[] = [];
  static script: AutoServerScript | undefined;

  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  private readonly listeners = new Map<string, Listener[]>();
  private streamed = 0;

  constructor(readonly url: string) {
    FakeLyriaSocket.instances.push(this);
    if (FakeLyriaSocket.script) setTimeout(() => this.open(), 0);
  }

  static reset(script?: AutoServerScript): void {
    FakeLyriaSocket.instances = [];
    FakeLyriaSocket.script = script;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
    const script = FakeLyriaSocket.script;
    if (!script) return;
    const msg = JSON.parse(data) as Record<string, unknown>;
    if (msg.setup && script.completeSetup !== false) {
      setTimeout(() => this.serverSend({ setupComplete: {} }), 0);
    }
    if (msg.playbackControl === "PLAY") setTimeout(() => this.streamNext(script), 0);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    setTimeout(() => this.emit("close", { code: code ?? 1005, reason: reason ?? "" }), 0);
  }

  /** Messages sent by the client, parsed. */
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit("open", {});
  }

  serverSend(message: object, binary = false): void {
    if (this.readyState !== 1) return;
    const text = JSON.stringify(message);
    const data = binary ? new TextEncoder().encode(text).buffer : text;
    this.emit("message", { data });
  }

  serverClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  emitError(): void {
    this.emit("error", {});
  }

  private streamNext(script: AutoServerScript): void {
    if (this.readyState !== 1) return;
    if (script.maxChunks !== undefined && this.streamed >= script.maxChunks) {
      if (script.closeAfterChunks) {
        this.serverClose(script.closeAfterChunks.code, script.closeAfterChunks.reason);
      }
      return;
    }
    this.streamed++;
    this.serverSend(
      audioFrame(pcmBytes(script.chunkBytes ?? 960, this.streamed), script.mimeType),
      script.binary,
    );
    setTimeout(() => this.streamNext(script), 0);
  }

  private emit(type: string, event: LyriaSocketEvent): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}
