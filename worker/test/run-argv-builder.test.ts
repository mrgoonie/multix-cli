import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { limitsFrom } from "../src/config.js";
import { type RunRequest, prepareRun } from "../src/jobs/run-argv-builder.js";
import { safeFileName } from "../src/jobs/run-input-files.js";
import { normaliseResolution } from "../src/jobs/run-option-caps.js";
import { parseWithCli } from "./cli-program.js";

const limits = limitsFrom({});
const run = (request: RunRequest) => prepareRun(request, limits);
const rejects = (request: RunRequest, message: RegExp) => {
  expect(() => run(request)).toThrow(ValidationError);
  expect(() => run(request)).toThrow(message);
};

describe("prepareRun: argv", () => {
  it("attaches values with = and keeps a prompt that starts with a dash a value", async () => {
    const prepared = run({
      command: " gemini   generate ",
      options: { prompt: "--help me draw a cat", "--aspect-ratio": "16:9", "num-images": 2 },
    });
    expect(prepared.command).toBe("gemini generate");
    expect(prepared.group).toBe("gemini");
    expect(prepared.argv).toEqual([
      "gemini",
      "generate",
      "--prompt=--help me draw a cat",
      "--aspect-ratio=16:9",
      "--num-images=2",
    ]);
    const parsed = await parseWithCli(prepared.argv, "gemini generate");
    expect(parsed.opts).toMatchObject({
      prompt: "--help me draw a cat",
      aspectRatio: "16:9",
      numImages: "2",
    });
  }, 120_000);

  it("puts free-text positionals after -- so commander never reads them as flags", async () => {
    const prepared = run({ command: "leonardo generate", args: ["-v --version cats"] });
    expect(prepared.argv).toEqual(["leonardo", "generate", "--", "-v --version cats"]);
    const parsed = await parseWithCli(prepared.argv, "leonardo generate");
    expect(parsed.args).toEqual(["-v --version cats"]);
    expect(parsed.opts.verbose).toBeUndefined();
  }, 120_000);

  it("downloads file inputs to server-chosen paths and passes repeatable options once per file", async () => {
    const prepared = run({
      command: "gemini analyze",
      inputs: {
        files: ["https://cdn.example.com/a/My%20Clip.mp4", "https://cdn.example.com/b.png"],
      },
    });
    expect(prepared.inputs).toEqual([
      { url: "https://cdn.example.com/a/My%20Clip.mp4", path: "in/0-My_Clip.mp4" },
      { url: "https://cdn.example.com/b.png", path: "in/1-b.png" },
    ]);
    expect(prepared.argv).toEqual([
      "gemini",
      "analyze",
      "--files=in/0-My_Clip.mp4",
      "--files=in/1-b.png",
    ]);
    const parsed = await parseWithCli(prepared.argv, "gemini analyze");
    expect(parsed.opts.files).toEqual(["in/0-My_Clip.mp4", "in/1-b.png"]);
  }, 120_000);

  it("fills a file positional from inputs and keeps it after --", () => {
    const prepared = run({
      command: "byteplus image-to-video",
      options: { prompt: "zoom in" },
      inputs: { image: "https://cdn.example.com/still.jpg" },
    });
    expect(prepared.argv.slice(-2)).toEqual(["--", "in/0-still.jpg"]);
  });

  it("downloads a directory input into its own folder", () => {
    const prepared = run({
      command: "media batch",
      inputs: { "input-dir": ["https://cdn.example.com/1.mp3", "https://cdn.example.com/2.mp3"] },
    });
    expect(prepared.inputs.map((f) => f.path)).toEqual([
      "in/input-dir/0-1.mp3",
      "in/input-dir/1-2.mp3",
    ]);
    expect(prepared.argv).toEqual([
      "media",
      "batch",
      "--input-dir=in/input-dir",
      "--output-dir=out",
    ]);
  });

  it("forces the OpenAI API driver and places a named output in the output directory", () => {
    const prepared = run({
      command: "openai generate",
      options: { prompt: "a fox", output: "fox.png" },
    });
    expect(prepared.argv).toEqual([
      "openai",
      "generate",
      "--prompt=a fox",
      "--output=out/fox.png",
      "--driver=api",
    ]);
    rejects({ command: "openai generate", options: { prompt: "x", driver: "codex" } }, /api/);
  });

  it("emits boolean flags only when true, including --no-* flags", () => {
    const prepared = run({
      command: "gemini generate",
      options: { prompt: "p", "no-webp": true, verbose: false },
    });
    expect(prepared.argv).toEqual(["gemini", "generate", "--prompt=p", "--no-webp"]);
  });

  it("sends the server default duration when the CLI default is unknown", () => {
    const prepared = run({ command: "atlas video", args: ["waves"] });
    expect(prepared.argv).toContain("--duration=5");
  });

  it("passes repeatable options the CLI collects with its own parser once per value", async () => {
    const refs = run({
      command: "heygen video-agent",
      args: ["a product tour"],
      options: { file: ["asset:a1", "asset:b2"] },
    });
    expect(refs.argv).toEqual([
      "heygen",
      "video-agent",
      "--file=asset:a1",
      "--file=asset:b2",
      "--",
      "a product tour",
    ]);
    const parsed = await parseWithCli(refs.argv, "heygen video-agent");
    expect(parsed.opts.file).toEqual(["asset:a1", "asset:b2"]);

    const downloads = run({
      command: "heygen model-video",
      args: ["walk"],
      inputs: {
        "reference-image": ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"],
      },
    });
    expect(downloads.argv.filter((a) => a.startsWith("--reference-image="))).toEqual([
      "--reference-image=in/0-1.png",
      "--reference-image=in/1-2.png",
    ]);
  }, 120_000);

  it("runs runway video and image with downloaded inputs, repeated references and capped duration", async () => {
    const video = run({
      command: "runway video",
      args: ["camera pans"],
      options: { model: "gen4_turbo", ratio: "960:960" },
      inputs: { image: "https://cdn.example.com/still.png" },
    });
    expect(video.group).toBe("runway");
    expect(video.argv).toContain("--image=in/0-still.png");
    expect(video.argv).toContain("--duration=5");
    rejects(
      { command: "runway video", args: ["p"], options: { duration: 60 } },
      /at most 10 seconds/,
    );

    const image = run({
      command: "runway image",
      args: ["a photo of @hero at sea"],
      options: { "reference-tag": ["hero", "boat"] },
      inputs: { reference: ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"] },
    });
    const parsed = await parseWithCli(image.argv, "runway image");
    expect(parsed.opts.reference).toEqual(["in/0-1.png", "in/1-2.png"]);
    expect(parsed.opts.referenceTag).toEqual(["hero", "boat"]);
    rejects(
      { command: "runway image", args: ["p"], options: { reference: "/etc/passwd" } },
      /reference/,
    );
  }, 120_000);

  it("accepts plain file-name parts such as a language code or prefix", () => {
    const prepared = run({
      command: "elevenlabs voices design",
      options: { description: "warm narrator", "output-prefix": "narrator_v2" },
    });
    expect(prepared.argv).toContain("--output-prefix=narrator_v2");
    expect(
      run({ command: "elevenlabs dub-status", args: ["dub123"], options: { download: "pt-BR" } })
        .argv,
    ).toContain("--download=pt-BR");
  });

  it("accepts a provider asset reference where the provider supports one", () => {
    const prepared = run({
      command: "heygen translate",
      args: ["asset:abc123"],
      options: { languages: "vi" },
    });
    expect(prepared.argv.slice(-2)).toEqual(["--", "asset:abc123"]);
  });
});

describe("prepareRun: rejections", () => {
  it.each<[string, RunRequest, RegExp]>([
    ["unknown command", { command: "gemini nope" }, /Unknown command/],
    ["excluded command", { command: "update" }, /cannot run/],
    [
      "unknown option",
      { command: "gemini generate", options: { prompt: "p", shell: "x" } },
      /Unknown option --shell/,
    ],
    [
      "@file value",
      { command: "replicate run", args: ["a/b"], options: { input: "@/etc/passwd" } },
      /@/,
    ],
    ["@file positional", { command: "leonardo generate", args: ["@secrets.txt"] }, /@/],
    [
      "file option as a value",
      { command: "gemini analyze", options: { files: "/etc/passwd" } },
      /inputs\.files/,
    ],
    [
      "file positional as an arg",
      { command: "atlas upload", args: ["/etc/hosts"] },
      /inputs\.file/,
    ],
    [
      "http input",
      { command: "gemini analyze", inputs: { files: "http://cdn.example.com/a.mp3" } },
      /https/,
    ],
    [
      "private input",
      { command: "gemini analyze", inputs: { files: "https://10.0.0.1/a.mp3" } },
      /public host/,
    ],
    [
      "internal input",
      { command: "gemini analyze", inputs: { files: "https://db.internal/a.mp3" } },
      /private/,
    ],
    [
      "inputs for a plain option",
      {
        command: "gemini generate",
        options: { prompt: "p" },
        inputs: { prompt: "https://a.example.com/x" },
      },
      /not a file input/,
    ],
    [
      "several URLs for a single file",
      {
        command: "openai transcribe",
        inputs: { input: ["https://a.example.com/1.mp3", "https://a.example.com/2.mp3"] },
      },
      /single URL/,
    ],
    [
      "output path",
      { command: "gemini generate", options: { prompt: "p", output: "../x.png" } },
      /plain file name/,
    ],
    [
      "output dir",
      {
        command: "media split",
        options: { "output-dir": "/tmp" },
        inputs: { input: "https://a.example.com/x.mp3" },
      },
      /not available/,
    ],
    [
      "unsupported option",
      { command: "replicate run", args: ["a/b"], options: { input: "{}", file: "image=x.png" } },
      /not available/,
    ],
    ["missing required option", { command: "gemini generate" }, /options\.prompt is required/],
    ["missing required file", { command: "openai transcribe" }, /inputs\.input is required/],
    ["too many args", { command: "leonardo generate", args: ["a", "b"] }, /Too many args/],
    [
      "flag given a value",
      { command: "gemini generate", options: { prompt: "p", "no-webp": "yes" } },
      /flag/,
    ],
    [
      "array for a single value",
      { command: "gemini generate", options: { prompt: ["a", "b"] } },
      /single value/,
    ],
    [
      "url option to a private host",
      {
        command: "minimax generate-video",
        options: { prompt: "p", "first-frame": "https://localhost/x.png" },
      },
      /private|public/,
    ],
    [
      "path in a file-name prefix",
      {
        command: "elevenlabs voices design",
        options: { description: "d", "output-prefix": "../../../../tmp/pwn" },
      },
      /--output-prefix may contain only/,
    ],
    [
      "path in a dub language",
      { command: "elevenlabs dub", options: { "target-lang": "es/../../x" } },
      /--target-lang may contain only/,
    ],
    [
      "path in a download language",
      { command: "elevenlabs dub-status", args: ["d1"], options: { download: "../x" } },
      /--download may contain only/,
    ],
    [
      "too many outputs",
      { command: "gemini generate", options: { prompt: "p", "num-images": 9 } },
      /at most 4/,
    ],
    [
      "video too long",
      { command: "byteplus video", options: { prompt: "p", duration: 60 } },
      /at most 10 seconds/,
    ],
    [
      "resolution not allowed",
      { command: "byteplus video", options: { prompt: "p", resolution: "4k" } },
      /resolution must be one of/,
    ],
  ])("rejects %s", (_label, request, message) => rejects(request, message));
});

describe("prepareRun: implicit video resolution", () => {
  const only720 = limitsFrom({ MULTIX_MCP_ALLOWED_RESOLUTIONS: "720p" });

  it("checks the CLI's model-dependent default when --resolution is omitted", () => {
    const request = { command: "gemini generate-video", options: { prompt: "p" } };
    expect(() => prepareRun(request, only720)).toThrow(/resolution must be one of 720p/);
    expect(() => prepareRun(request, limits)).not.toThrow();
    expect(() =>
      prepareRun({ ...request, options: { prompt: "p", resolution: "720p" } }, only720),
    ).not.toThrow();
  });

  it("checks Omni follow-ups against their 720p default", () => {
    expect(() =>
      prepareRun(
        { command: "gemini video-status", args: ["v1_abc"], options: { wait: true } },
        only720,
      ),
    ).not.toThrow();
    expect(() =>
      prepareRun(
        { command: "gemini edit-video", options: { prompt: "p", "interaction-id": "v1_abc" } },
        only720,
      ),
    ).not.toThrow();
  });
});

describe("helpers", () => {
  it("normalises provider resolution spellings", () => {
    expect(normaliseResolution("1080P")).toBe("1080p");
    expect(normaliseResolution("RESOLUTION_720")).toBe("720p");
    expect(normaliseResolution("4k")).toBe("4k");
  });

  it("derives safe local file names from URLs", () => {
    expect(safeFileName("https://a.example.com/x/..%2F..%2Fetc%2Fpasswd")).toBe("_.._etc_passwd");
    expect(safeFileName("https://a.example.com/")).toBe("input");
    expect(safeFileName("https://a.example.com/..")).toBe("input");
  });
});
