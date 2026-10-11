/**
 * Atlas commands driven through commander with the real logger and the real
 * env-based client (global fetch stubbed with the fake Atlas API). Covers
 * stdout contracts, option parsing, upload guards and download outcomes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { _resetEnvLoader } from "../../../../src/core/env-loader.js";
import { ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerAtlasCloudCommands } from "../../../../src/providers/atlascloud/commands/index.js";
import {
  BASE,
  FLUX_SCHNELL_SCHEMA,
  TEST_KEY,
  catalog,
  createFakeAtlas,
  envelope,
  prediction,
} from "./fake-atlas.js";

let tmp: string;
let stdout: string[];
let stderr: string[];
const originalEnv = { ...process.env };

function program(): Command {
  const p = new Command();
  p.exitOverride();
  registerAtlasCloudCommands(p);
  return p;
}

async function run(...args: string[]): Promise<void> {
  await program().parseAsync(["node", "multix", "atlas", ...args]);
}

/** Route the CLI's global fetch to the fake API plus raw media downloads. */
function stubAtlas(
  routes: Parameters<typeof createFakeAtlas>[0],
  media: Record<string, { status?: number; body?: string; type?: string }> = {},
) {
  const fake = createFakeAtlas(routes);
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const m = media[input];
    if (m) {
      return new Response(m.body ?? "", {
        status: m.status ?? 200,
        headers: m.type ? { "content-type": m.type } : {},
      });
    }
    return fake.fetch(input, init);
  });
  return fake;
}

const FLUX_CATALOG = {
  "GET /models": {
    body: catalog([
      {
        model: "black-forest-labs/flux-schnell",
        type: "Image",
        schema: "https://static.test/flux.json",
      },
    ]),
  },
  "GET /flux.json": { body: FLUX_SCHNELL_SCHEMA },
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cli-"));
  process.env.MULTIX_OUTPUT_DIR = tmp;
  process.env.ATLASCLOUD_API_KEY = TEST_KEY;
  process.env.ATLASCLOUD_BASE_URL = BASE;
  process.env.NO_COLOR = "1";
  _resetEnvLoader();
  _resetOutputDir();
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  for (const fn of ["error", "warn"] as const) {
    vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => {
      stderr.push(a.join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  _resetEnvLoader();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("stdout carries only the machine-readable result", () => {
  it("--async prints just the prediction id; progress and the resume hint go to stderr", async () => {
    stubAtlas({
      ...FLUX_CATALOG,
      "POST /model/generateImage": { body: prediction("async01", "processing") },
    });
    await run("image", "a fox", "--async", "-v");
    expect(stdout).toEqual(["async01"]);
    expect(stderr.join("\n")).toContain("Submitting to black-forest-labs/flux-schnell");
    expect(stderr.join("\n")).toContain("multix atlas status async01 --wait --download");
  });

  it("--async with a local --ref keeps the upload progress off stdout", async () => {
    const ref = path.join(tmp, "frame.png");
    fs.writeFileSync(ref, "PNG");
    stubAtlas({
      "GET /models": { body: catalog([]) },
      "POST /model/uploadMedia": { body: envelope({ download_url: "https://cdn.test/u/f.png" }) },
      "POST /model/generateVideo": { body: prediction("i2v01", "processing") },
    });
    await run("image-to-video", "--ref", ref, "--async");
    expect(stdout).toEqual(["i2v01"]);
    expect(stderr.join("\n")).toContain("Uploading frame.png");
  });

  it("upload prints just the URL", async () => {
    const file = path.join(tmp, "photo.png");
    fs.writeFileSync(file, "PNG");
    stubAtlas({
      "POST /model/uploadMedia": { body: envelope({ download_url: "https://cdn.test/u/p.png" }) },
    });
    await run("upload", file, "-v");
    expect(stdout).toEqual(["https://cdn.test/u/p.png"]);
  });
});

describe("--ref parsing", () => {
  it("is a repeatable single-value option, so a following prompt stays positional", async () => {
    const parse3d = async (...args: string[]) => {
      const p = program();
      const atlas = p.commands.find((c) => c.name() === "atlas") as Command;
      const threeD = atlas.commands.find((c) => c.name() === "3d") as Command;
      let seen: { prompt?: string; ref?: string[] } = {};
      threeD.action((prompt: string | undefined, opts: { ref?: string[] }) => {
        seen = { prompt, ref: opts.ref };
      });
      await p.parseAsync(["node", "multix", "atlas", "3d", ...args]);
      return seen;
    };
    expect(await parse3d("--ref", "a.png", "a treasure chest")).toEqual({
      prompt: "a treasure chest",
      ref: ["a.png"],
    });
    expect((await parse3d("--ref", "a.png", "--ref", "b.png")).ref).toEqual(["a.png", "b.png"]);
  });

  it("image-to-image still requires at least one --ref", async () => {
    stubAtlas({});
    await expect(run("image-to-image", "--prompt", "dusk")).rejects.toThrow(/--ref/);
  });
});

describe("upload guards", () => {
  it("refuses non-media files before any request", async () => {
    const secret = path.join(tmp, ".env");
    fs.writeFileSync(secret, "KEY=1");
    const fake = stubAtlas({});
    await expect(run("upload", secret)).rejects.toThrow(/not a supported media file/);
    expect(fake.calls).toHaveLength(0);
  });

  it("enforces ATLASCLOUD_MAX_UPLOAD_MB before reading the file", async () => {
    const big = path.join(tmp, "big.mp4");
    fs.writeFileSync(big, Buffer.alloc(2048));
    process.env.ATLASCLOUD_MAX_UPLOAD_MB = "0.001";
    const fake = stubAtlas({});
    await expect(run("upload", big)).rejects.toThrow(/upload limit.*ATLASCLOUD_MAX_UPLOAD_MB/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("downloads", () => {
  it("a partial download exits non-zero, lists saved files and gives the resume command", async () => {
    const urls = ["https://m.test/a.jpg", "https://m.test/b.jpg"];
    stubAtlas(
      {
        "GET /model/prediction/multi01": {
          body: prediction("multi01", "completed", { outputs: urls }),
        },
      },
      { [urls[0] as string]: { body: "A" }, [urls[1] as string]: { status: 403 } },
    );
    const err = await run("status", "multi01", "--download", "--image-format", "original").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("downloaded 1 of 2");
    expect(err.message).toContain("multix atlas status multi01 --wait --download");
    const saved = path.join(tmp, "atlas-multi01-01.jpg");
    expect(err.message).toContain(saved);
    expect(fs.readFileSync(saved, "utf8")).toBe("A");
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("a failed download never deletes a file the user already had at --output", async () => {
    const out = path.join(tmp, "hero.png");
    fs.writeFileSync(out, "ORIGINAL");
    const url = "https://m.test/x.png";
    stubAtlas(
      {
        "GET /model/prediction/keep01": {
          body: prediction("keep01", "completed", { outputs: [url] }),
        },
      },
      { [url]: { status: 403 } },
    );
    await expect(
      run("status", "keep01", "--download", "--output", out, "--image-format", "original"),
    ).rejects.toThrow(ProviderError);
    expect(fs.readFileSync(out, "utf8")).toBe("ORIGINAL");
  });

  it("on resume, names extensionless outputs from the response Content-Type", async () => {
    const url = "https://m.test/result/abc";
    stubAtlas(
      {
        "GET /model/prediction/ct01": { body: prediction("ct01", "completed", { outputs: [url] }) },
      },
      { [url]: { body: "MP4", type: "video/mp4" } },
    );
    await run("status", "ct01", "--download", "--no-thumb");
    expect(fs.existsSync(path.join(tmp, "atlas-ct01-01.mp4"))).toBe(true);
  });
});

describe("status --wait", () => {
  it("times out with the resume command", async () => {
    stubAtlas({ "GET /model/prediction/slow01": { body: prediction("slow01", "processing") } });
    const err = await run("status", "slow01", "--wait", "--wait-timeout", "1").catch((e) => e);
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("multix atlas status slow01 --wait --download");
  });

  it("rejects a malformed id before any request", async () => {
    const fake = stubAtlas({});
    await expect(run("status", "../models")).rejects.toThrow(ValidationError);
    expect(fake.calls).toHaveLength(0);
  });
});
