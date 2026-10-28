import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCommand, loadCliProgram } from "./cli-program.js";
import { callTool, fullEnv } from "./helpers.js";

const GEMINI_KEY = "AIza-gemini-secret-value-1234";
const env = fullEnv({ GEMINI_API_KEY: GEMINI_KEY });

// biome-ignore lint/suspicious/noExplicitAny: JSON response bodies are untyped in tests
type Json = Record<string, any>;

const price = async (args: Record<string, unknown>) =>
  (await callTool(env, "multix_price_book", args)) as Json;

const testFileUrl = (import.meta as unknown as { url: string }).url;
const fromRepo = (rel: string) => decodeURIComponent(new URL(`../../${rel}`, testFileUrl).pathname);

/** Run `multix <argv> --json` with the real CLI program and return what it printed. */
async function cliJson(argv: string[]): Promise<unknown> {
  const { run } = (await import(/* @vite-ignore */ fromRepo("src/agent/run-state.ts"))) as {
    run: { json: boolean };
  };
  const program = await loadCliProgram();
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  const previous = run.json;
  run.json = true;
  try {
    findCommand(program, "catalog").exitOverride();
    await program.parseAsync(argv, { from: "user" });
  } finally {
    run.json = previous;
    log.mockRestore();
  }
  return JSON.parse(lines.join("\n"));
}

const withoutAt = <T extends Json>(value: T) => {
  const { at: _at, ...rest } = value;
  return rest;
};

describe("multix_price_book", () => {
  beforeEach(() => {
    // The CLI's `show` also reads local history and feedback; point both at nothing.
    vi.stubEnv("MULTIX_HISTORY_FILE", "/nonexistent/multix-history.jsonl");
    vi.stubEnv("MULTIX_CATALOG_FEEDBACK_FILE", "/nonexistent/multix-feedback.json");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("compares Seedance 2.0 at 720p for 10 s like for like, cheapest first", async () => {
    const result = await price({
      view: "compare",
      family: "seedance-2.0",
      resolution: "720p",
      duration: 10,
    });
    const { comparison } = result.structuredContent;
    expect(comparison.comparable.map((q: Json) => [q.provider, q.amount, q.rank])).toEqual([
      ["byteplus", 1.5, 1],
      ["fal", 3.034, 2],
      ["fal", 3.034, 3],
    ]);
    const byteplus = comparison.comparable[0];
    expect(byteplus.assumed).toContain("aspect ratio 16:9");
    expect(byteplus.source).toMatch(/^https:\/\/docs\.byteplus\.com\//);
    // The fast model is another family, never a cheaper "seedance-2.0".
    for (const q of [...comparison.comparable, ...comparison.not_comparable]) {
      expect(q.model).not.toMatch(/fast/);
    }
    // Nothing is ranked at $0 or without a price.
    for (const q of comparison.comparable) expect(q.amount).toBeGreaterThan(0);
  });

  it("does not rank a price whose conditions differ from the request", async () => {
    const { comparison } = (
      await price({ view: "compare", family: "seedance-2.0", resolution: "8k", duration: 10 })
    ).structuredContent;
    expect(comparison.comparable).toEqual([]);
    expect(comparison.not_comparable.length).toBeGreaterThan(0);
    for (const q of comparison.not_comparable) {
      expect(q.status).toBe("not_equivalent");
      expect(q.amount).toBeNull();
    }
  });

  it("reports key readiness per provider and never a key value", async () => {
    const result = await price({ view: "providers" });
    const providers = result.structuredContent.providers as Json[];
    const gemini = providers.find((p) => p.provider === "gemini");
    expect(gemini?.ready).toBe(true);
    expect(gemini?.keys).toContain("GEMINI_API_KEY");
    expect(providers.find((p) => p.provider === "openai")?.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain(GEMINI_KEY);
  });

  it("keeps unknown prices unknown in the model list", async () => {
    const { offerings } = (await price({ view: "models", task: "video" })).structuredContent;
    expect(offerings.length).toBeGreaterThan(0);
    for (const o of offerings) {
      expect(["priced", "stale", "unverified", "unknown"]).toContain(o.price_status);
      if (o.rates === 0) expect(o.price_status).toBe("unknown");
    }
  });

  it("rejects bad arguments as a tool error", async () => {
    const missing = await price({ view: "compare" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/family is required/);
    const unknown = await price({ view: "show", ref: "nope:nothing" });
    expect(unknown.isError).toBe(true);
    const badRatio = await price({ view: "compare", family: "seedance-2.0", aspect_ratio: "wide" });
    expect(badRatio.isError).toBe(true);
  });

  it("answers exactly what `multix catalog … --json` prints", async () => {
    const config = ["--resolution", "720p", "--duration", "10"];
    const cliCompare = (await cliJson(["catalog", "compare", "seedance-2.0", ...config])) as Json;
    const toolCompare = (
      await price({ view: "compare", family: "seedance-2.0", resolution: "720p", duration: 10 })
    ).structuredContent.comparison;
    expect(withoutAt(toolCompare)).toEqual(withoutAt(cliCompare));

    const cliModels = await cliJson(["catalog", "models", "--family", "seedance", "--priced"]);
    const toolModels = (await price({ view: "models", family: "seedance", priced: true }))
      .structuredContent.offerings;
    expect(toolModels).toEqual(cliModels);

    const ref = "fal:bytedance/seedance-2.0/text-to-video";
    const cliShow = (await cliJson(["catalog", "show", ref, ...config])) as Json;
    const toolShow = (await price({ view: "show", ref, resolution: "720p", duration: 10 }))
      .structuredContent.detail;
    const { usage: _u, ratings: _r, feedback: _f, ...cliShared } = cliShow;
    expect(toolShow).toEqual(cliShared);

    // Readiness depends on where the keys live (process env vs saved keys).
    const strip = (list: Json[]) => list.map(({ ready: _ready, ...rest }) => rest);
    const cliProviders = (await cliJson(["catalog", "providers"])) as Json[];
    const toolProviders = (await price({ view: "providers" })).structuredContent.providers;
    expect(strip(toolProviders)).toEqual(strip(cliProviders));
  });
});
