/**
 * Live model lists for `multix generate`: a provider's catalog is read and
 * cached, a failed read or a missing key falls back to the static models with
 * the reason, and every provider serving the task is listed. fetch is stubbed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providersFor } from "../../../src/commands/generate/generate-adapters.js";
import { generateProviderModels } from "../../../src/commands/generate/generate-models.js";

let tmp: string;
let calls: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-gen-models-"));
  vi.stubEnv("MULTIX_CACHE_DIR", tmp);
  vi.stubEnv("MULTIX_DISABLE_HOME_ENV", "1");
  vi.stubEnv("REPLICATE_API_TOKEN", "");
  vi.stubEnv("REPLICATE_API_KEY", "");
  vi.stubEnv("ATLASCLOUD_API_KEY", "");
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubAtlas(down = false) {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (down) throw new TypeError("fetch failed");
    const data = [
      { model: "vendor/t2v", displayName: "T2V", categories: ["TEXT-TO-VIDEO"] },
      { model: "vendor/i2v", categories: ["IMAGE-TO-VIDEO"] },
      { model: "vendor/img", categories: ["TEXT-TO-IMAGE"] },
    ];
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

describe("generateProviderModels", () => {
  it("lists a provider's live catalog by task and caches it", async () => {
    stubAtlas();
    const [atlas] = await generateProviderModels("video", { provider: "atlas" });
    expect(atlas?.source.kind).toBe("live");
    expect(atlas?.command).toBe("multix generate video --provider atlas --model <id>");
    expect(atlas?.models).toEqual(
      expect.arrayContaining([
        { id: "vendor/t2v", label: "T2V", tasks: ["video"] },
        { id: "vendor/i2v", tasks: ["image-to-video"] },
      ]),
    );
    expect(atlas?.models.some((m) => m.id === "vendor/img")).toBe(false);
    const read = calls.length;
    const again = await generateProviderModels("video", { provider: "atlas" });
    expect(calls.length).toBe(read);
    expect(again[0]?.source.state).toBe("cached");
  });

  it("falls back to the static models when the catalog cannot be read", async () => {
    stubAtlas(true);
    const [atlas] = await generateProviderModels("video", { provider: "atlas" });
    expect(atlas?.source.kind).toBe("static");
    expect(atlas?.source.error).toBeTruthy();
    expect(atlas?.models.length).toBeGreaterThan(0);
  });

  it("lists a keyless provider's static models with the key it needs", async () => {
    stubAtlas();
    const [replicate] = await generateProviderModels("image", { provider: "replicate" });
    expect(replicate?.ready).toBe(false);
    expect(replicate?.keys?.length).toBeGreaterThan(0);
    expect(replicate?.source).toMatchObject({ kind: "static" });
    expect(replicate?.source.error).toMatch(/REPLICATE_API_TOKEN/);
    expect(calls.some((u) => u.includes("replicate"))).toBe(false);
  });

  it("lists every provider serving the task and never throws", async () => {
    stubAtlas(true);
    const all = await generateProviderModels("lipsync");
    expect(all.map((p) => p.provider).sort()).toEqual([...providersFor("lipsync")].sort());
  });
});
