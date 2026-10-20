import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { registerGeminiVideoStatusCommands } from "../../../../src/providers/gemini/commands/video-status.js";
import { _resetGeminiKeyCooldowns } from "../../../../src/providers/gemini/key-pool.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const KEY = "test-key-1";
const ID = "v1_done1";

interface Call {
  method: string;
  url: string;
  key?: string;
}

let calls: Call[];
let stdout: string[];
const savedEnv: Record<string, string | undefined> = {};

function stubFetch(status: string): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url,
      key: new Headers(init.headers ?? {}).get("x-goog-api-key") ?? undefined,
    };
    calls.push(call);
    if (call.method === "POST" && url.endsWith("/cancel")) {
      return new Response(JSON.stringify({ id: ID, status: "cancelled" }), { status: 200 });
    }
    if (call.method === "GET" && url === `${API}/interactions/${ID}`) {
      return new Response(
        JSON.stringify({
          id: ID,
          status,
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "video",
                  mime_type: "video/mp4",
                  uri: `${API}/files/vid1:download?alt=media`,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected ${call.method} ${url}`);
  });
}

function program(): Command {
  const root = new Command();
  root.exitOverride();
  registerGeminiVideoStatusCommands(root);
  return root;
}

beforeEach(() => {
  calls = [];
  stdout = [];
  _resetGeminiKeyCooldowns();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY")) {
      savedEnv[k] = process.env[k];
      Reflect.deleteProperty(process.env, k);
    }
  }
  process.env.GEMINI_API_KEY = KEY;
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    stdout.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("GEMINI_API_KEY")) Reflect.deleteProperty(process.env, k);
  }
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

describe("video-cancel", () => {
  it("does not POST cancel when the interaction is already completed", async () => {
    stubFetch("completed");
    await program().parseAsync(["video-cancel", ID], { from: "user" });

    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary).toMatchObject({ interaction_id: ID, status: "completed" });
    expect(stdout.join("\n")).not.toContain("generativelanguage");
  });

  it("leaves failed and cancelled interactions alone too", async () => {
    for (const status of ["failed", "cancelled"]) {
      calls = [];
      stubFetch(status);
      await program().parseAsync(["video-cancel", ID], { from: "user" });
      expect(
        calls.some((c) => c.method === "POST"),
        status,
      ).toBe(false);
    }
  });

  it("POSTs cancel with the key that owns a running interaction", async () => {
    stubFetch("in_progress");
    await program().parseAsync(["video-cancel", ID], { from: "user" });

    const cancel = calls.find((c) => c.method === "POST");
    expect(cancel?.url).toBe(`${API}/interactions/${ID}/cancel`);
    expect(cancel?.key).toBe(KEY);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "cancelled" });
  });

  it("rejects an unsafe interaction id before any request", async () => {
    stubFetch("in_progress");
    await expect(
      program().parseAsync(["video-cancel", "../models/x"], { from: "user" }),
    ).rejects.toThrow(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("video-status", () => {
  it("prints a completed interaction without media URIs and does not cancel it", async () => {
    stubFetch("completed");
    await program().parseAsync(["video-status", ID], { from: "user" });

    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const out = stdout.join("\n");
    expect(JSON.parse(out)).toMatchObject({
      interaction_id: ID,
      status: "completed",
      video: { delivery: "uri", media_file: "files/vid1" },
    });
    expect(out).not.toContain("generativelanguage");
  });
});
