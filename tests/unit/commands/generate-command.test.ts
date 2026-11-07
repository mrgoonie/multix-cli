/**
 * `multix generate`: every provider adapter maps a request onto a provider
 * command and flags that really exist, refuses what that command cannot take
 * before any request, and `--output` copies a file the command saved under its
 * own name. No network calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../src/agent/run-state.js";
import {
  GENERATE_ADAPTERS,
  GENERATE_TASKS,
  type GenerateInput,
  type GenerateTask,
  providersFor,
  resolveRoute,
} from "../../../src/commands/generate/generate-adapters.js";
import { copyOutput, planGenerate } from "../../../src/commands/generate/index.js";
import { registerCommands } from "../../../src/commands/index.js";
import { ConfigError } from "../../../src/core/errors.js";

function program(): Command {
  const p = new Command().name("multix").enablePositionalOptions();
  registerCommands(p);
  return p;
}

function leaf(root: Command, names: string[]): Command | undefined {
  let cmd: Command | undefined = root;
  for (const n of names) cmd = cmd?.commands.find((c) => c.name() === n);
  return cmd && cmd.commands.length === 0 ? cmd : undefined;
}

const URL_IMG = "https://example.com/a.png";
const URL_VIDEO = "https://example.com/a.mp4";
const URL_AUDIO = "https://example.com/a.wav";
const LEO_ID = "11111111-2222-3333-4444-555555555555";

/** A minimal request each provider can take for a task. */
function sample(provider: string, task: GenerateTask): GenerateInput {
  const image = provider === "leonardo" ? LEO_ID : URL_IMG;
  const base: GenerateInput = { task, images: [], async: false };
  if (provider === "openrouter" && task === "video") {
    return { ...base, prompt: "a red fox", images: [URL_IMG] };
  }
  if (task === "image" || task === "video") return { ...base, prompt: "a red fox" };
  if (provider === "heygen") return { ...base, video: URL_VIDEO, audio: URL_AUDIO };
  if (task === "upscale") return { ...base, images: [image] };
  return { ...base, images: [URL_IMG], audio: URL_AUDIO };
}

describe("generate adapters", () => {
  const root = program();
  const pairs = GENERATE_TASKS.flatMap((t) => providersFor(t).map((p) => [p, t] as const));

  it.each(pairs)("%s %s maps to a real command and real flags", (provider, task) => {
    const adapter = GENERATE_ADAPTERS[provider];
    const input = sample(provider, task);
    const model = adapter?.defaultModel?.(task);
    if (model) input.model = model;
    const plan = adapter?.plan(input);
    expect(plan).toBeDefined();
    if (!plan) return;
    const target = leaf(root, plan.command.split(" "));
    expect(target, plan.command).toBeDefined();
    const longs = new Set(target?.options.map((o) => o.long));
    for (const arg of plan.args.filter((a) => a.startsWith("--"))) {
      expect(longs.has(arg.split("=")[0]), `${plan.command} ${arg}`).toBe(true);
    }
  });

  it("covers every task with at least one provider", () => {
    for (const task of GENERATE_TASKS) expect(providersFor(task).length).toBeGreaterThan(0);
  });
});

describe("planGenerate", () => {
  beforeEach(() => vi.stubEnv("MULTIX_WAIT_TIMEOUT", ""));
  afterEach(() => vi.unstubAllEnvs());
  const opts = { image: [] as string[] };

  it("takes the provider from a <provider>:<model> --model", () => {
    const r = planGenerate("video", ["waves"], {
      ...opts,
      model: "atlas:bytedance/seedance-v1-pro-fast/text-to-video",
    });
    expect(r.provider).toBe("atlas");
    expect(r.model).toBe("bytedance/seedance-v1-pro-fast/text-to-video");
    expect(r.plan.args).toContain("bytedance/seedance-v1-pro-fast/text-to-video");
  });

  it("keeps a Replicate owner/name:version model whole", () => {
    expect(resolveRoute(undefined, "replicate:owner/name:abc123")).toEqual({
      provider: "replicate",
      model: "owner/name:abc123",
    });
    expect(resolveRoute("replicate", "owner/name:abc123").model).toBe("owner/name:abc123");
  });

  it("maps a fal aspect ratio onto its image-size preset", () => {
    const r = planGenerate("image", ["fox"], { ...opts, provider: "fal", aspectRatio: "16:9" });
    expect(r.plan.args.join(" ")).toContain("landscape_16_9");
  });

  it.each([
    ["no provider", "image", { ...opts }],
    ["an unknown task", "audio", { ...opts, provider: "fal" }],
    ["an unknown provider", "image", { ...opts, provider: "nope" }],
    ["a task the provider does not serve", "upscale", { ...opts, provider: "fal" }],
    ["video on openai", "video", { ...opts, provider: "openai" }],
    ["--end-image without --image", "video", { ...opts, provider: "atlas", endImage: URL_IMG }],
    [
      "--output with --async",
      "video",
      { ...opts, provider: "atlas", output: "a.mp4", async: true },
    ],
    ["a non-positive --duration", "video", { ...opts, provider: "atlas", duration: "0" }],
    [
      "lipsync on heygen without audio",
      "lipsync",
      { ...opts, provider: "heygen", video: URL_VIDEO },
    ],
    [
      "a local leonardo upscale source",
      "upscale",
      { ...opts, provider: "leonardo", image: ["a.png"] },
    ],
  ])("refuses %s with a ConfigError", (_name, task, o) => {
    expect(() => planGenerate(task, ["x"], o)).toThrow(ConfigError);
  });

  it("names each field the provider command cannot take", () => {
    expect(() =>
      planGenerate("image", ["fox"], { ...opts, provider: "openai", duration: "5" }),
    ).toThrow(/duration/);
  });

  it("does not refuse a wait timeout that came from the environment", () => {
    vi.stubEnv("MULTIX_WAIT_TIMEOUT", "60000");
    expect(() => planGenerate("image", ["fox"], { ...opts, provider: "openai" })).not.toThrow();
  });
});

describe("copyOutput", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-generate-"));
    run.written.clear();
    vi.stubEnv("MULTIX_OUTPUT_DIR", tmp);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    run.written.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("copies the saved media file to --output", () => {
    const saved = path.join(tmp, "provider-name.mp4");
    fs.writeFileSync(saved, "video");
    run.written.add(saved);
    const out = path.join(tmp, "out", "clip.mp4");
    copyOutput("video", out);
    expect(fs.readFileSync(out, "utf8")).toBe("video");
  });

  it("fails when the command saved no matching media", () => {
    expect(() => copyOutput("image", path.join(tmp, "x.png"))).toThrow(/saved no image/);
  });
});
