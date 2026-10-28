/**
 * `multix models` through commander: the default JSON stays the plain row
 * array, `--model` inspects a verified model (or says it is unknown), and
 * `--live` merges cached provider catalogs without claiming unread ones.
 * fetch is stubbed; no network calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../src/agent/run-state.js";
import { registerCommands } from "../../../src/commands/index.js";
import { ValidationError } from "../../../src/core/errors.js";

// Loose view of the printed JSON; the assertions check its shape.
interface Json {
  verified: (Json & { inputs: Record<string, unknown> }) | null;
  listed?: unknown;
  schema: string;
  commands: unknown[];
  sources: Array<{ state: string; provider: string }>;
  models: Array<{ model: string; verified: boolean; listed: boolean | null }>;
}

let tmp: string;
let stdout: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-models-cmd-"));
  vi.stubEnv("MULTIX_CACHE_DIR", tmp);
  vi.stubEnv("FAL_KEY", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  run.json = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function models(...args: string[]): Promise<unknown> {
  run.json = true;
  const program = new Command().name("multix").enablePositionalOptions();
  program.exitOverride();
  registerCommands(program);
  stdout = [];
  await program.parseAsync(["node", "multix", "models", ...args]);
  return JSON.parse(stdout.join("\n"));
}

/** A one-model Sume catalogue (the shape of https://api.sume.com/v1/open/catalog). */
const SUME_CATALOG = {
  data: {
    currency: "USD",
    models: [
      {
        id: "gpt-image-2",
        name: "ChatGPT Image 2",
        kind: "image",
        modes: ["text-to-image", "image-edit"],
        pricing: { currency: "USD", unit: "image", from_usd: "0.0060", to_usd: "0.2110" },
        capabilities: { text_to_image: true, image_edit: true },
        constraints: [],
      },
    ],
  },
};

/** Answers fal, OpenRouter and Sume catalog reads; `down` providers fail like a lost connection. */
function stubCatalogs(down: string[] = []) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const host = new URL(url).host;
    if (down.some((d) => host.includes(d))) throw new TypeError("fetch failed");
    const body = host.includes("sume.com")
      ? SUME_CATALOG
      : host.includes("fal.ai")
        ? {
            models: [
              { endpoint_id: "elevenlabs/tts/eleven-v4", metadata: { status: "active" } },
              { endpoint_id: "vendor/new-tts", metadata: { display_name: "New TTS" } },
            ],
            has_more: false,
          }
        : { data: [{ id: "vendor/or-tts", name: "OR TTS", supported_voices: ["a"] }] };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

describe("multix models --json", () => {
  it("keeps the default output a plain array of rows", async () => {
    const rows = (await models("--task", "speech")) as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((r) => r.task === "speech")).toBe(true);
    for (const r of rows) {
      expect(r).toEqual(
        expect.objectContaining({
          task: "speech",
          command: expect.any(String),
          provider: expect.any(String),
          ready: expect.any(Boolean),
        }),
      );
    }
    const fal = rows.find((r) => r.command === "fal run");
    expect(fal).toMatchObject({ provider: "fal", ready: false, keys: ["FAL_KEY"] });
    expect(fal?.any_model).toBeUndefined();
  });

  it("inspects a verified model and says when its key is not set", async () => {
    const result = (await models("--model", "elevenlabs/tts/eleven-v4")) as Json;
    expect(result).toMatchObject({
      schema: "multix.capabilities/v1",
      model: "elevenlabs/tts/eleven-v4",
      ready: false,
      keys: ["FAL_KEY"],
      verified: { provider: "fal", command: "fal tts", tasks: ["speech"] },
    });
    expect(result.verified.inputs.text).toMatchObject({ required: true, max_length: 5000 });
    expect(result.listed).toBeUndefined();
  });

  it("reports an unknown model as unverified instead of guessing", async () => {
    expect(await models("--model", "someone/unknown")).toEqual({
      schema: "multix.capabilities/v1",
      model: "someone/unknown",
      verified: null,
    });
  });

  it("matches a verified model only under its own provider", async () => {
    const other = (await models(
      "--model",
      "google/gemini-3.8-flash-tts",
      "--provider",
      "openrouter",
    )) as Json;
    expect(other.verified).toBeNull();
    const fal = (await models(
      "--model",
      "google/gemini-3.8-flash-tts",
      "--provider",
      "fal",
    )) as Json;
    expect(fal.verified).not.toBeNull();
  });

  it("rejects --live without a task and an unknown task", async () => {
    await expect(models("--live")).rejects.toBeInstanceOf(ValidationError);
    await expect(models("--model", "someone/unknown", "--live")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(models("--task", "telepathy")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("multix models --live", () => {
  it("merges both catalogs, marks verified and unverified models, then serves the cache", async () => {
    const calls = stubCatalogs();
    const live = (await models("--task", "speech", "--live")) as Json;
    expect(live.schema).toBe("multix.capabilities/v1");
    expect(Array.isArray(live.commands)).toBe(true);
    expect(live.sources.map((s: { state: string }) => s.state)).toEqual([
      "fresh",
      "fresh",
      "unsupported",
    ]);
    const byId = Object.fromEntries(live.models.map((m: { model: string }) => [m.model, m]));
    expect(byId["elevenlabs/tts/eleven-v4"]).toMatchObject({
      verified: true,
      listed: true,
      status: "active",
      ready: false,
    });
    expect(byId["elevenlabs/tts/eleven-v4-turbo"]).toMatchObject({
      listed: false,
      status: "missing",
    });
    expect(byId["vendor/new-tts"]).toMatchObject({ verified: false, command: "fal tts" });
    expect(byId["vendor/or-tts"]).toMatchObject({
      verified: false,
      command: "openrouter tts",
      voices: 1,
    });
    expect(calls).toHaveLength(2);

    const again = (await models("--task", "speech", "--live")) as Json;
    expect(again.sources.map((s: { state: string }) => s.state)).toEqual([
      "cached",
      "cached",
      "unsupported",
    ]);
    expect(calls).toHaveLength(2);
    await models("--task", "speech", "--refresh");
    expect(calls).toHaveLength(4);
  });

  it("offline with no cache: catalogs are unavailable and nothing is claimed listed", async () => {
    stubCatalogs(["fal.ai", "openrouter.ai"]);
    const live = (await models("--task", "speech", "--live")) as Json;
    expect(live.sources.map((s: { state: string }) => s.state)).toEqual([
      "unavailable",
      "unavailable",
      "unsupported",
    ]);
    expect(live.models.length).toBeGreaterThan(0);
    expect(
      live.models.every(
        (m: { verified: boolean; listed: null }) => m.verified && m.listed === null,
      ),
    ).toBe(true);
  });

  it("reads the Sume catalogue for image tasks and lists its models with prices", async () => {
    const calls = stubCatalogs();
    const live = (await models("--task", "image", "--live")) as Json;
    const sume = live.sources.find((src) => src.provider === "sume");
    expect(sume?.state).toBe("fresh");
    expect(calls.some((u) => u.startsWith("https://api.sume.com/v1/open/catalog"))).toBe(true);
    expect(live.models).toContainEqual(
      expect.objectContaining({ provider: "sume", model: "gpt-image-2" }),
    );
  });

  it("limits --provider to that catalog and --model --live to the model's entries", async () => {
    const calls = stubCatalogs();
    const live = (await models("--task", "speech", "--provider", "fal", "--live")) as Json;
    expect(live.sources).toEqual([expect.objectContaining({ provider: "fal" })]);
    expect(calls.every((u) => u.includes("fal.ai"))).toBe(true);
    const inspect = (await models(
      "--model",
      "vendor/new-tts",
      "--task",
      "speech",
      "--live",
    )) as Json;
    expect(inspect.verified).toBeNull();
    expect(inspect.listed).toEqual([expect.objectContaining({ model: "vendor/new-tts" })]);
  });
});
