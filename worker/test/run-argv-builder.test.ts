import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import { limitsFrom } from "../src/config.js";
import { jobEnv } from "../src/jobs/job-runner.js";
import { type RunRequest, prepareRun } from "../src/jobs/run-argv-builder.js";
import { safeFileName } from "../src/jobs/run-input-files.js";
import { assertSpendGuard, normaliseResolution } from "../src/jobs/run-option-caps.js";
import type { ProviderKeys } from "../src/provider-secret-names.js";
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

  it("downloads the openrouter transcribe input and keeps its extension for the audio format", async () => {
    const prepared = run({
      command: "openrouter transcribe",
      options: { model: "openai/whisper-large-v3-turbo", language: "en" },
      inputs: { input: "https://cdn.example.com/talk.m4a" },
    });
    expect(prepared.inputs).toEqual([
      { url: "https://cdn.example.com/talk.m4a", path: "in/0-talk.m4a" },
    ]);
    const parsed = await parseWithCli(prepared.argv, "openrouter transcribe");
    expect(parsed.opts).toMatchObject({
      input: "in/0-talk.m4a",
      model: "openai/whisper-large-v3-turbo",
      language: "en",
    });
    rejects({ command: "openrouter transcribe", options: { input: "/etc/passwd" } }, /input/);
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

  it("passes fish tts voices and dictionary references once per value", async () => {
    const prepared = run({
      command: "fish tts",
      options: {
        text: "<|speaker:0|>Hi.<|speaker:1|>Hello.",
        voice: ["aaaabbbbccccddddeeeeffff00001111", "2222333344445555666677778888aaaa"],
        dictionary: ["dict_1@ver_2", "dict_3@ver_4"],
      },
    });
    const parsed = await parseWithCli(prepared.argv, "fish tts");
    expect(parsed.opts.voice).toEqual([
      "aaaabbbbccccddddeeeeffff00001111",
      "2222333344445555666677778888aaaa",
    ]);
    expect(parsed.opts.dictionary).toEqual(["dict_1@ver_2", "dict_3@ver_4"]);
    expect(parsed.opts.text).toBe("<|speaker:0|>Hi.<|speaker:1|>Hello.");
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

  it("runs the Gemini Omni video commands with downloaded inputs and capped duration", async () => {
    const generate = run({ command: "gemini generate-video", options: { prompt: "a fox" } });
    expect(generate.argv).toContain("--duration=5");
    // Omni only, and an allowed resolution is sent when the caller omits it.
    expect(generate.argv).toContain("--model=gemini-omni-1.1-flash");
    expect(generate.argv).toContain("--resolution=720p");
    rejects(
      {
        command: "gemini generate-video",
        options: { prompt: "p", model: "veo-3.1-generate-preview" },
      },
      /model must be gemini-omni-1.1-flash/,
    );
    const i2v = run({
      command: "gemini image-to-video",
      args: [],
      options: { prompt: "p", duration: 8, resolution: "1080p" },
      inputs: { imagePath: "https://cdn.example.com/still.png" },
    });
    expect(i2v.argv).toContain("--duration=8");
    expect(i2v.argv.slice(-2)).toEqual(["--", "in/0-still.png"]);

    const edit = run({
      command: "gemini edit-video",
      options: { prompt: "make it night" },
      inputs: {
        video: "https://cdn.example.com/clip.mp4",
        "reference-images": ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"],
      },
    });
    const parsedEdit = await parseWithCli(edit.argv, "gemini edit-video");
    expect(parsedEdit.opts.video).toBe("in/0-clip.mp4");
    expect(parsedEdit.opts.referenceImages).toEqual(["in/1-1.png", "in/2-2.png"]);
    // An edit keeps the source length: no duration is added.
    expect(edit.argv.some((a) => a.startsWith("--duration"))).toBe(false);
    // The source's resolution is not checked, so an allowed one is sent.
    expect(parsedEdit.opts.resolution).toBe("720p");
    expect(parsedEdit.opts.model).toBe("gemini-omni-1.1-flash");

    const extend = run({
      command: "gemini extend-video",
      options: { prompt: "keep going", "interaction-id": "int_123", "no-wait": true },
    });
    const parsedExtend = await parseWithCli(extend.argv, "gemini extend-video");
    expect(parsedExtend.opts.interactionId).toBe("int_123");
    expect(parsedExtend.opts.wait).toBe(false);
    expect(parsedExtend.opts.duration).toBe("5");
    expect(parsedExtend.opts.model).toBe("gemini-omni-1.1-flash");
    for (const command of ["gemini edit-video", "gemini extend-video"]) {
      rejects(
        {
          command,
          options: { prompt: "p", "interaction-id": "int_1", model: "gemini-omni-2-pro" },
        },
        /model must be gemini-omni-1.1-flash/,
      );
    }

    const status = run({
      command: "gemini video-status",
      args: ["int_123"],
      options: { wait: true, download: true, output: "clip.mp4" },
    });
    expect(status.argv).toContain("--download");
    expect(status.argv.find((a) => a.startsWith("--output="))).toMatch(/clip\.mp4$/);
    expect(run({ command: "gemini video-cancel", args: ["int_123"] }).argv.slice(0, 2)).toEqual([
      "gemini",
      "video-cancel",
    ]);
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
    [
      "fal run local file",
      { command: "fal run", args: ["a/b"], options: { file: "video_url=/etc/passwd" } },
      /not available/,
    ],
    [
      "fal run receipt path",
      { command: "fal run", args: ["a/b"], options: { input: "{}", receipt: "/tmp/r.json" } },
      /not available/,
    ],
    ["fal upload path as an arg", { command: "fal upload", args: ["/etc/hosts"] }, /inputs\.file/],
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
    [
      "Gemini video too long",
      { command: "gemini generate-video", options: { prompt: "p", duration: 60 } },
      /at most 10 seconds/,
    ],
    [
      "Gemini 4k video",
      { command: "gemini generate-video", options: { prompt: "p", resolution: "4k" } },
      /resolution must be one of/,
    ],
    [
      "Gemini 4k edit",
      { command: "gemini edit-video", options: { prompt: "p", resolution: "4K" } },
      /resolution must be one of/,
    ],
    [
      "Gemini extension too long",
      { command: "gemini extend-video", options: { prompt: "p", duration: 30 } },
      /at most 10 seconds/,
    ],
    [
      "caller path for a Gemini source video",
      { command: "gemini edit-video", options: { prompt: "p", video: "/etc/passwd" } },
      /video/,
    ],
    [
      "count in exponent form the CLI reads as 100",
      { command: "fal image", args: ["p"], options: { "num-images": "100e-2" } },
      /--num-images must be a plain decimal number of at least 1/,
    ],
    [
      "duration in exponent form the CLI reads as 60",
      { command: "byteplus video", options: { prompt: "p", duration: "60e-1" } },
      /--duration must be a plain decimal number of at least 1/,
    ],
    [
      "fractional duration the CLI reads as 0",
      { command: "byteplus video", options: { prompt: "p", duration: "0.5" } },
      /--duration must be a plain decimal number of at least 1/,
    ],
    [
      "hex count",
      { command: "fal image", args: ["p"], options: { "num-images": "0x2" } },
      /--num-images must be a plain decimal number/,
    ],
    [
      "signed count",
      { command: "fal image", args: ["p"], options: { "num-images": "+2" } },
      /--num-images must be a plain decimal number/,
    ],
  ])("rejects %s", (_label, request, message) => rejects(request, message));

  it("accepts padded and fractional values within the caps", () => {
    expect(() =>
      run({ command: "fal image", args: ["p"], options: { "num-images": " 2 " } }),
    ).not.toThrow();
    expect(() =>
      run({ command: "byteplus video", options: { prompt: "p", duration: "4.9" } }),
    ).not.toThrow();
  });
});

describe("prepareRun: speech", () => {
  const keys: ProviderKeys = {
    GEMINI_API_KEY: "g-test-key",
    OPENAI_API_KEY: "sk-test-openai",
    ELEVENLABS_API_KEY: "el-test-key",
    MINIMAX_API_KEY: "mm-test-key",
    ATLASCLOUD_API_KEY: "atlas-test-key",
    FAL_KEY: "fal-test-key",
  };

  it("needs a provider for speech generate", () => {
    rejects(
      { command: "speech generate", options: { text: "hi" } },
      /options\.provider is required for "speech generate"/,
    );
    rejects(
      { command: "speech generate", options: { model: "tts-1", text: "hi" } },
      /options\.provider is required/,
    );
  });

  it("gives the job the keys of its provider and fallbacks only", async () => {
    const prepared = run({
      command: "speech generate",
      options: {
        provider: "gemini",
        fallback: ["elevenlabs:eleven_v3:alexandra", "minimax"],
        text: "hi",
      },
    });
    expect(prepared.group).toBe("speech");
    expect(prepared.keyGroups).toEqual(["gemini", "elevenlabs", "minimax"]);
    expect(jobEnv(prepared.keyGroups, keys)).toEqual({
      GEMINI_API_KEY: "g-test-key",
      ELEVENLABS_API_KEY: "el-test-key",
      MINIMAX_API_KEY: "mm-test-key",
    });
    const parsed = await parseWithCli(prepared.argv, "speech generate");
    expect(parsed.opts).toMatchObject({
      provider: "gemini",
      fallback: ["elevenlabs:eleven_v3:alexandra", "minimax"],
    });
  }, 120_000);

  it("gives a provider-only request that provider's key and nothing else", () => {
    const prepared = run({
      command: "speech generate",
      options: { provider: "openai", fallback: ["openai:tts-1"], text: "hi" },
    });
    expect(prepared.keyGroups).toEqual(["openai"]);
    expect(jobEnv(prepared.keyGroups, keys)).toEqual({ OPENAI_API_KEY: "sk-test-openai" });
  });

  it("gives the OpenRouter and fal gateway routes their own keys", () => {
    const prepared = run({
      command: "speech generate",
      options: { provider: "fal", fallback: ["openrouter"], text: "hi" },
    });
    expect(prepared.keyGroups).toEqual(["fal", "openrouter"]);
  });

  it("rejects a provider or fallback that is not a speech provider", () => {
    rejects(
      { command: "speech generate", options: { provider: "acme", text: "hi" } },
      /--provider must name one of: gemini, openai, elevenlabs, minimax, atlas/,
    );
    rejects(
      { command: "speech generate", options: { provider: "openai,gemini", text: "hi" } },
      /--provider must name one of/,
    );
    rejects(
      { command: "speech generate", options: { provider: "openai", fallback: ["acme:flux"] } },
      /--fallback must name one of: gemini, openai, elevenlabs, minimax, atlas/,
    );
  });

  it("takes the text file as a downloaded input, never a local path", () => {
    const prepared = run({
      command: "speech generate",
      options: { provider: "openai" },
      inputs: { "text-file": "https://cdn.example.com/scene.txt" },
    });
    expect(prepared.inputs).toEqual([
      { url: "https://cdn.example.com/scene.txt", path: "in/0-scene.txt" },
    ]);
    expect(prepared.argv).toEqual([
      "speech",
      "generate",
      "--provider=openai",
      "--text-file=in/0-scene.txt",
    ]);
    rejects(
      { command: "speech generate", options: { provider: "openai", "text-file": "/etc/passwd" } },
      /--text-file is a file: pass its https URL in inputs\.text-file/,
    );
    rejects(
      {
        command: "speech generate",
        options: { provider: "openai" },
        inputs: { "text-file": "http://cdn.example.com/scene.txt" },
      },
      /https/,
    );
  });

  it("passes repeated --extra values once each and parses them as the CLI does", async () => {
    const prepared = run({
      command: "speech generate",
      options: {
        provider: "elevenlabs",
        extra: ["elevenlabs.stability=0.4", "elevenlabs.seed=7"],
        text: "hi",
      },
    });
    expect(prepared.argv).toEqual(
      expect.arrayContaining(["--extra=elevenlabs.stability=0.4", "--extra=elevenlabs.seed=7"]),
    );
    const parsed = await parseWithCli(prepared.argv, "speech generate");
    expect(parsed.opts.extra).toEqual({
      "elevenlabs.stability": "0.4",
      "elevenlabs.seed": "7",
    });
  }, 120_000);

  it("speech models gets no keys and rejects --ready", () => {
    const prepared = run({ command: "speech models", options: { provider: "openai" } });
    expect(prepared.keyGroups).toEqual([]);
    expect(prepared.argv).toEqual(["speech", "models", "--provider=openai"]);
    expect(jobEnv(prepared.keyGroups, keys)).toEqual({});
    rejects(
      { command: "speech models", options: { ready: true } },
      /--ready is not available on this server/,
    );
  });
});

describe("prepareRun: fixed video length", () => {
  const leonardo = (model: string) => ({
    command: "leonardo video",
    args: ["a cat"],
    options: { model },
  });

  it("runs leonardo video when the length cap is at least 8 seconds", () => {
    expect(
      prepareRun(leonardo("kling-2.6"), limitsFrom({ MULTIX_MCP_MAX_VIDEO_SECONDS: "8" })).argv,
    ).toEqual(["leonardo", "video", "--model=kling-2.6", "--", "a cat"]);
  });

  it("refuses leonardo video for any model when the length cap is below 8 seconds", () => {
    const short = limitsFrom({ MULTIX_MCP_MAX_VIDEO_SECONDS: "5" });
    for (const model of ["kling-2.6", "VEO3"]) {
      expect(() => prepareRun(leonardo(model), short)).toThrow(
        /renders up to 8 seconds, above this server's limit of 5/,
      );
    }
    expect(() => prepareRun({ command: "leonardo video", args: ["a cat"] }, short)).toThrow(
      ValidationError,
    );
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

describe("prepareRun: runs the caps cannot bound", () => {
  it("marks pass-through and source-length commands", () => {
    expect(run({ command: "fal run", args: ["a/b"], options: { input: "{}" } }).uncappedSpend).toBe(
      "the request body is passed to the provider as given",
    );
    expect(
      run({ command: "replicate run", args: ["a/b"], options: { input: "{}" } }).uncappedSpend,
    ).toBeDefined();
    expect(
      run({ command: "atlas run", args: ["a/b"], options: { input: "{}" } }).uncappedSpend,
    ).toBeDefined();
    expect(
      run({ command: "heygen run", args: ["/v3/videos"], options: { input: "{}" } }).uncappedSpend,
    ).toBeDefined();
    expect(
      run({
        command: "heygen translate",
        options: { languages: "es" },
        inputs: { source: "https://cdn.example.com/in.mp4" },
      }).uncappedSpend,
    ).toBe("billed by the length of the source media");
    expect(run({ command: "elevenlabs dub", options: { "target-lang": "es" } }).uncappedSpend).toBe(
      "billed by the length of the source media",
    );
  });

  it("marks a raw --input body merged under a convenience command", () => {
    expect(
      run({ command: "replicate image", args: ["a cat"], options: { "num-outputs": 1 } }),
    ).not.toHaveProperty("uncappedSpend");
    expect(
      run({
        command: "replicate image",
        args: ["a cat"],
        options: { "num-outputs": 1, input: '{"num_outputs": 8}' },
      }).uncappedSpend,
    ).toBe("with --input, the request reaches the provider as given");
    expect(
      run({
        command: "replicate video",
        args: ["a wave"],
        options: { input: "{}" },
      }).uncappedSpend,
    ).toBe("with --input, the request reaches the provider as given");
    expect(run({ command: "fal tts", options: { text: "hi" } })).not.toHaveProperty(
      "uncappedSpend",
    );
    expect(
      run({
        command: "fal tts",
        options: { text: "hi", model: "fal-ai/veo3", "text-field": "prompt" },
      }).uncappedSpend,
    ).toBe("with --text-field, the request reaches the provider as given");
  });

  it("marks an omitted count the model picks, and accepts one within the cap", () => {
    expect(run({ command: "atlas image", args: ["a cat"] }).uncappedSpend).toBe(
      "--num-images is omitted, so the model picks the number of outputs (pass --num-images, at most 4)",
    );
    expect(
      run({ command: "atlas image", args: ["a cat"], options: { "num-images": 2 } }),
    ).not.toHaveProperty("uncappedSpend");
    rejects(
      { command: "atlas image", args: ["a cat"], options: { "num-images": 5 } },
      /--num-images must be at most 4/,
    );
    expect(run({ command: "replicate image", args: ["a cat"] }).uncappedSpend).toContain(
      "--num-outputs is omitted",
    );
  });

  it("marks Sume and TopView runs the caps cannot bound", () => {
    expect(
      run({ command: "sume image", args: ["a cat"], options: { model: "m" } }).uncappedSpend,
    ).toContain("--num-images is omitted");
    expect(
      run({ command: "sume image", args: ["a cat"], options: { model: "m", "num-images": 2 } }),
    ).not.toHaveProperty("uncappedSpend");
    expect(
      run({
        command: "sume image",
        args: ["a cat"],
        options: { model: "m", "num-images": 1, param: ["seed=1"] },
      }).uncappedSpend,
    ).toBe("with --param, the request reaches the provider as given");
    const video = run({ command: "sume video", args: ["a wave"], options: { model: "m" } });
    expect(video.uncappedSpend).toContain("catalog row sets the price");
    expect(video.argv).not.toContain("--duration");
    expect(
      run({ command: "topview run", args: ["route"], options: { input: "{}" } }).uncappedSpend,
    ).toBe("the request body is passed to the provider as given");
    expect(
      run({
        command: "topview video-avatar",
        options: { "avatar-id": "a", "tts-text": "hi", "voice-id": "v" },
      }).uncappedSpend,
    ).toBe("billed by the length of the script or audio");
    expect(
      run({
        command: "topview product-anyshoot",
        options: { mode: "background", count: 2 },
      }),
    ).not.toHaveProperty("uncappedSpend");
  });

  it("leaves capped commands unmarked and caps the voice-design count", () => {
    expect(run({ command: "gemini generate", options: { prompt: "a cat" } })).not.toHaveProperty(
      "uncappedSpend",
    );
    rejects(
      { command: "fish voice-design", options: { instruction: "warm", count: 9 } },
      /--count must be at most 4/,
    );
  });

  it("applies MULTIX_MCP_UNCAPPED_SPEND, with budget for unknown values", () => {
    const why = "the request body is passed to the provider as given";
    const mode = (value?: string) => limitsFrom({ MULTIX_MCP_UNCAPPED_SPEND: value });
    expect(mode().uncappedSpend).toBe("budget");
    expect(mode(" DENY ").uncappedSpend).toBe("deny");
    expect(mode("yes please").uncappedSpend).toBe("budget");
    expect(() => assertSpendGuard("fal run", why, mode(), undefined)).toThrow(/Pass max_cost_usd/);
    expect(() => assertSpendGuard("fal run", why, mode(), 1)).not.toThrow();
    expect(() => assertSpendGuard("fal run", why, mode("deny"), 1)).toThrow(
      /does not run such commands/,
    );
    expect(() => assertSpendGuard("fal run", why, mode("allow"), undefined)).not.toThrow();
    expect(() => assertSpendGuard("gemini generate", undefined, mode(), undefined)).not.toThrow();
  });
});
