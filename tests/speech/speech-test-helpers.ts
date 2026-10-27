/**
 * Shared helpers for the `multix speech` tests: an env sandbox that hides any
 * speech key the developer has set, a recording fetch mock that can answer with
 * binary audio, and an in-process runner for the speech command tree.
 * Nothing here reaches the network.
 */

import { Command } from "commander";
import { vi } from "vitest";
import { run } from "../../src/agent/run-state.js";
import { registerSpeechCommands } from "../../src/commands/speech/index.js";

/** Env names that select a speech provider, its key or its output directory. */
const SPEECH_ENV =
  /^(GEMINI_|GOOGLE_|OPENAI_|ELEVENLABS_|MINIMAX_|ATLASCLOUD_|FISH_|MULTIX_OUTPUT_DIR$)/;

/**
 * Replace the speech-related env with exactly `vars` (undefined values unset).
 * Returns the restore function to call in afterEach.
 */
export function setSpeechEnv(vars: Record<string, string | undefined> = {}): () => void {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (SPEECH_ENV.test(name)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[name] = value;
  }
  return () => {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    Object.assign(process.env, saved);
  };
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON body; the raw string when it is not JSON; undefined without a body. */
  body: unknown;
}

export type FetchHandler = (call: RecordedCall) => Response;

/**
 * Replace globalThis.fetch with `handler`, recording every call. Every test that
 * installs it must call `restore` so no later test sees the mock.
 */
export function recordFetch(handler: FetchHandler): {
  calls: RecordedCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const call: RecordedCall = { method, url, headers, body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function audioReply(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

export interface SpeechRun {
  /** `data` the command recorded for the result envelope. */
  data: unknown;
  /** Provider group and model of the request that was routed. */
  group: string;
  model: string | undefined;
  stdout: string[];
  stderr: string[];
}

/**
 * Run `multix speech <args>` in-process with a fresh command tree. Console output
 * is captured; a rejected action (ValidationError, ConfigError, ...) propagates.
 */
export async function runSpeech(args: string[]): Promise<SpeechRun> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSpeechCommands(program);
  run.data = undefined;
  run.group = "";
  run.requestModel = undefined;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    stdout.push(parts.map(String).join(" "));
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
  try {
    await program.parseAsync(["speech", ...args], { from: "user" });
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
  return { data: run.data, group: run.group, model: run.requestModel, stdout, stderr };
}
