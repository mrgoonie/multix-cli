/**
 * End-to-end command tests against a fake HeyGen API (global fetch stubbed).
 * Covers create -> poll -> download flows, multi-ID translation, status by
 * type, pagination output, failure exit paths, and secret redaction in output.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerHeygenCommands } from "../../../../src/providers/heygen/commands/index.js";
import { HeygenJobFailedError } from "../../../../src/providers/heygen/heygen-errors.js";
import { type FakeHeygen, type FakeReply, fakeHeygen } from "./fake-heygen.js";

const KEY = "hg-live-secret-999";
const API = "https://api.heygen.test";
const FILES = "https://files.heygen.test";
const SIG = "Signature=TOPSECRETSIG";

let tmp: string;
let output: string[];
let fake: FakeHeygen;

function useApi(routes: Record<string, FakeReply | FakeReply[]>) {
  fake = fakeHeygen(routes);
  vi.stubGlobal("fetch", fake.fetch);
}

async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerHeygenCommands(program);
  await program.parseAsync(["node", "multix", "heygen", ...args]);
}

const printed = () => output.join("\n");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-heygen-"));
  vi.stubEnv("HEYGEN_API_KEY", KEY);
  vi.stubEnv("HEYGEN_BASE_URL", API);
  vi.stubEnv("MULTIX_OUTPUT_DIR", tmp);
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  const capture = (...a: unknown[]) => {
    output.push(a.map(String).join(" "));
  };
  for (const m of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation(capture);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("heygen video-agent", () => {
  it("creates a session, follows it to the video, and downloads video + thumbnail", async () => {
    useApi({
      "POST /v3/video-agents": { body: { data: { session_id: "s1", status: "thinking" } } },
      "GET /v3/video-agents/s1": [
        { body: { data: { session_id: "s1", status: "thinking" } } },
        { body: { data: { session_id: "s1", status: "generating", video_id: "v9" } } },
      ],
      "GET /v3/videos/v9": [
        { body: { data: { id: "v9", status: "processing" } } },
        {
          body: {
            data: {
              id: "v9",
              status: "completed",
              video_url: `${FILES}/out/v9.mp4?${SIG}`,
              thumbnail_url: `${FILES}/out/v9.jpg?${SIG}`,
            },
          },
        },
      ],
      "GET /out/v9.mp4": { raw: "VIDEO-BYTES", headers: { "Content-Type": "video/mp4" } },
      "GET /out/v9.jpg": { raw: "JPEG-BYTES", headers: { "Content-Type": "image/jpeg" } },
    });

    await run(
      "video-agent",
      "Private launch script about Project Falcon",
      "--orientation",
      "portrait",
      "--poll-interval",
      "1",
      "--json",
    );

    const create = fake.callsTo("POST /v3/video-agents")[0];
    expect(create?.headers["x-api-key"]).toBe(KEY);
    expect(create?.headers["idempotency-key"]).toBeUndefined();
    expect(create?.body).toEqual({
      prompt: "Private launch script about Project Falcon",
      mode: "generate",
      orientation: "portrait",
    });

    const video = path.join(tmp, "heygen-agent-s1.mp4");
    expect(fs.readFileSync(video, "utf8")).toBe("VIDEO-BYTES");
    const summary = JSON.parse(output.find((l) => l.trim().startsWith("{")) ?? "{}");
    expect(summary).toMatchObject({ kind: "agent", id: "s1", video_id: "v9", status: "completed" });
    expect(summary.files[0]).toBe(video);

    // Never print the key, the signed query string, or the prompt.
    const text = printed();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("TOPSECRETSIG");
    expect(text).not.toContain("Project Falcon");
  });

  it("rejects bad flags before any network call", async () => {
    useApi({});
    await expect(run("video-agent", "x", "--orientation", "square")).rejects.toThrow(
      /--orientation/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("fails without HEYGEN_API_KEY and makes no request", async () => {
    vi.stubEnv("HEYGEN_API_KEY", "");
    useApi({});
    const err = await run("video-agent", "hello").catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toMatch(/HEYGEN_API_KEY is not set.*billed separately/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("heygen video", () => {
  it("uploads a local audio file and submits with --async", async () => {
    const audio = path.join(tmp, "voice.mp3");
    fs.writeFileSync(audio, "ID3-AUDIO");
    useApi({
      "POST /v3/assets": { body: { data: { asset_id: "as1", mime_type: "audio/mpeg" } } },
      "POST /v3/videos": { body: { data: { video_id: "v1", status: "waiting" } } },
    });

    await run("video", "--avatar", "look1", "--audio", audio, "--async", "--json");

    const upload = fake.callsTo("POST /v3/assets")[0];
    expect((upload?.body as FormData).get("file")).toBeTruthy();
    const create = fake.callsTo("POST /v3/videos")[0];
    expect(create?.body).toEqual({
      type: "avatar",
      avatar_id: "look1",
      audio_asset_id: "as1",
      aspect_ratio: "auto",
    });
    expect(create?.headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.parse(printed().slice(printed().indexOf("{")))).toMatchObject({
      kind: "video",
      id: "v1",
      status: "submitted",
      resume: "multix heygen status v1 --type video --wait --download",
    });
  });

  it("exits non-zero with failure_code/message when the render fails", async () => {
    useApi({
      "POST /v3/videos": { body: { data: { video_id: "v2", status: "waiting" } } },
      "GET /v3/videos/v2": {
        body: {
          data: {
            id: "v2",
            status: "failed",
            failure_code: "voice_unavailable",
            failure_message: "Voice is not available",
          },
        },
      },
    });
    const err = await run("video", "Hello", "--avatar", "look1", "--poll-interval", "1").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(HeygenJobFailedError);
    expect(err.message).toMatch(/voice_unavailable.*Voice is not available/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("surfaces 402 insufficient credit with billing guidance", async () => {
    useApi({
      "POST /v3/videos": {
        status: 402,
        body: { error: { code: "insufficient_credit", message: "Insufficient credit" } },
      },
    });
    const err = await run("video", "Hello", "--avatar", "look1").catch((e) => e);
    expect(err.message).toMatch(/402.*insufficient_credit.*billed separately/s);
  });

  it("explains an expired download URL without leaking the signature", async () => {
    useApi({
      "POST /v3/videos": { body: { data: { video_id: "v3", status: "waiting" } } },
      "GET /v3/videos/v3": {
        body: { data: { id: "v3", status: "completed", video_url: `${FILES}/out/v3.mp4?${SIG}` } },
      },
      "GET /out/v3.mp4": { status: 403, raw: "expired" },
    });
    const err = await run(
      "video",
      "Hello",
      "--avatar",
      "look1",
      "--poll-interval",
      "1",
      "--no-thumb",
    ).catch((e) => e);
    expect(err.message).toMatch(/may have expired/);
    expect(err.message).toMatch(/multix heygen status v3 --type video --wait --download/);
    expect(err.message).not.toContain("TOPSECRETSIG");
    expect(fs.existsSync(path.join(tmp, "heygen-video-v3.mp4"))).toBe(false);
  });
});

describe("heygen translate", () => {
  it("submits several languages and downloads every translation", async () => {
    useApi({
      "POST /v3/video-translations": {
        body: { data: { video_translation_ids: ["t1", "t2"] } },
      },
      "GET /v3/video-translations/t1": {
        body: {
          data: {
            id: "t1",
            status: "completed",
            output_language: "Spanish",
            video_url: `${FILES}/tr/t1.mp4?${SIG}`,
          },
        },
      },
      "GET /v3/video-translations/t2": [
        { body: { data: { id: "t2", status: "running" } } },
        {
          body: {
            data: {
              id: "t2",
              status: "completed",
              output_language: "Chinese (Cantonese, Traditional)",
              video_url: `${FILES}/tr/t2.mp4?${SIG}`,
              srt_caption_url: `${FILES}/tr/t2.srt?${SIG}`,
            },
          },
        },
      ],
      "GET /tr/t1.mp4": { raw: "ES" },
      "GET /tr/t2.mp4": { raw: "ZH" },
      "GET /tr/t2.srt": { raw: "1\n00:00:00,000 --> 00:00:01,000\nhi\n" },
    });
    const outDir = path.join(tmp, "dubs");

    await run(
      "translate",
      "https://cdn.test/source.mp4",
      "--languages",
      "Spanish, Chinese (Cantonese, Traditional)",
      "--output",
      outDir,
      "--captions",
      "--poll-interval",
      "1",
    );

    expect(fake.callsTo("POST /v3/video-translations")[0]?.body).toMatchObject({
      video: { type: "url", url: "https://cdn.test/source.mp4" },
      output_languages: ["Spanish", "Chinese (Cantonese, Traditional)"],
    });
    const files = fs.readdirSync(outDir).sort();
    expect(files).toEqual([
      "heygen-translation-Chinese-Cantonese-Traditional-t2.mp4",
      "heygen-translation-Chinese-Cantonese-Traditional-t2.srt",
      "heygen-translation-Spanish-t1.mp4",
    ]);
    expect(printed()).not.toContain("TOPSECRETSIG");
  });

  it("derives per-language file names when --output has a media extension", async () => {
    const translation = (id: string, language: string) => ({
      body: {
        data: {
          id,
          status: "completed",
          output_language: language,
          video_url: `${FILES}/tr/${id}.mp4`,
        },
      },
    });
    useApi({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["t1", "t2"] } } },
      "GET /v3/video-translations/t1": translation("t1", "Spanish"),
      "GET /v3/video-translations/t2": translation("t2", "French (France)"),
      "GET /tr/t1.mp4": { raw: "ES" },
      "GET /tr/t2.mp4": { raw: "FR" },
    });
    const outDir = path.join(tmp, "out");

    await run(
      "translate",
      "asset:src1",
      "--languages",
      "Spanish,French (France)",
      "--output",
      path.join(outDir, "dub.mp4"),
      "--poll-interval",
      "1",
    );

    expect(fs.readdirSync(outDir).sort()).toEqual(["dub-French-France.mp4", "dub-Spanish.mp4"]);
    expect(fs.readFileSync(path.join(outDir, "dub-Spanish.mp4"), "utf8")).toBe("ES");
  });

  it("downloads successes but still fails when one language fails", async () => {
    useApi({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["t1", "t2"] } } },
      "GET /v3/video-translations/t1": {
        body: {
          data: {
            id: "t1",
            status: "completed",
            output_language: "French",
            video_url: `${FILES}/tr/a.mp4`,
          },
        },
      },
      "GET /v3/video-translations/t2": {
        body: { data: { id: "t2", status: "failed", failure_message: "No speech detected" } },
      },
      "GET /tr/a.mp4": { raw: "FR" },
    });
    const err = await run(
      "translate",
      "asset:src1",
      "--languages",
      "French,German",
      "--poll-interval",
      "1",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HeygenJobFailedError);
    expect(err.message).toMatch(/translation t2.*No speech detected/);
    expect(fs.existsSync(path.join(tmp, "heygen-translation-French-t1.mp4"))).toBe(true);
    expect(fake.callsTo("POST /v3/video-translations")[0]?.body).toMatchObject({
      video: { type: "asset_id", asset_id: "src1" },
    });
  });
});

describe("heygen status", () => {
  it("reads by --type and reports a pending job without failing", async () => {
    useApi({
      "GET /v3/lipsyncs/l1": { body: { data: { id: "l1", status: "running" } } },
    });
    await run("status", "l1", "--type", "lipsync", "--json");
    expect(JSON.parse(printed().slice(printed().indexOf("{")))).toEqual({
      kind: "lipsync",
      id: "l1",
      status: "running",
    });
  });

  it("exits non-zero for a failed job", async () => {
    useApi({
      "GET /v3/models/videos/m1": {
        body: { data: { video_id: "m1", status: "failed", failure_message: "Content policy" } },
      },
    });
    await expect(run("status", "m1", "--type", "model-video")).rejects.toThrow(/Content policy/);
  });

  it("rejects an unknown --type", async () => {
    useApi({});
    await expect(run("status", "x", "--type", "image")).rejects.toThrow(/--type/);
  });

  it("resumes an agent session with --download", async () => {
    useApi({
      "GET /v3/video-agents/s5": {
        body: { data: { session_id: "s5", status: "completed", video_id: "v5" } },
      },
      "GET /v3/videos/v5": {
        body: { data: { id: "v5", status: "completed", video_url: `${FILES}/out/v5.mp4` } },
      },
      "GET /out/v5.mp4": { raw: "V5" },
    });
    const dest = path.join(tmp, "final.mp4");
    await run("status", "s5", "--type", "agent", "--download", "--output", dest, "--no-thumb");
    expect(fs.readFileSync(dest, "utf8")).toBe("V5");
  });
});

describe("heygen delivery safety", () => {
  const completed = (extra: Record<string, unknown>) => ({
    body: { data: { id: "v7", status: "completed", ...extra } },
  });

  it("downloads captioned_video_url when --burn-captions is set", async () => {
    useApi({
      "POST /v3/videos": { body: { data: { video_id: "v7", status: "waiting" } } },
      "GET /v3/videos/v7": completed({
        video_url: `${FILES}/out/clean.mp4`,
        captioned_video_url: `${FILES}/out/burned.mp4`,
      }),
      "GET /out/burned.mp4": { raw: "BURNED" },
      "GET /out/clean.mp4": { raw: "CLEAN" },
    });
    const dest = path.join(tmp, "out.mp4");
    await run(
      "video",
      "Hello",
      "--avatar",
      "look1",
      "--burn-captions",
      "--output",
      dest,
      "--poll-interval",
      "1",
      "--no-thumb",
    );
    expect(fs.readFileSync(dest, "utf8")).toBe("BURNED");
    expect(fake.callsTo("GET /out/clean.mp4")).toHaveLength(0);
  });

  it("fails clearly when --burn-captions is set but no captioned render exists", async () => {
    useApi({
      "POST /v3/videos": { body: { data: { video_id: "v7", status: "waiting" } } },
      "GET /v3/videos/v7": completed({ video_url: `${FILES}/out/clean.mp4` }),
    });
    const err = await run(
      "video",
      "Hello",
      "--avatar",
      "look1",
      "--burn-captions",
      "--poll-interval",
      "1",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HeygenJobFailedError);
    expect(err.message).toMatch(/captioned_video_missing/);
    expect(fake.callsTo("GET /out/clean.mp4")).toHaveLength(0);
  });

  it("keeps an existing --output file when the download fails", async () => {
    useApi({
      "GET /v3/videos/v7": completed({ video_url: `${FILES}/out/v7.mp4?${SIG}` }),
      "GET /out/v7.mp4": { status: 403, raw: "expired" },
    });
    const dest = path.join(tmp, "keep.mp4");
    fs.writeFileSync(dest, "PRECIOUS");
    const err = await run(
      "status",
      "v7",
      "--type",
      "video",
      "--download",
      "--output",
      dest,
      "--no-thumb",
    ).catch((e) => e);
    expect(err.message).toMatch(/may have expired/);
    expect(fs.readFileSync(dest, "utf8")).toBe("PRECIOUS");
    expect(fs.readdirSync(tmp)).toEqual(["keep.mp4"]);
  });

  it("prints the usable output URL with --no-download --json", async () => {
    const url = `${FILES}/out/v7.mp4?${SIG}`;
    useApi({
      "POST /v3/videos": { body: { data: { video_id: "v7", status: "waiting" } } },
      "GET /v3/videos/v7": completed({ video_url: url }),
    });
    await run(
      "video",
      "Hello",
      "--avatar",
      "look1",
      "--no-download",
      "--json",
      "--poll-interval",
      "1",
    );
    const summary = JSON.parse(printed().slice(printed().indexOf("{")));
    expect(summary).toMatchObject({ kind: "video", id: "v7", output_url: url });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("delivers remaining translations after one download fails, then exits non-zero", async () => {
    useApi({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["t1", "t2"] } } },
      "GET /v3/video-translations/t1": {
        body: {
          data: {
            id: "t1",
            status: "completed",
            output_language: "Spanish",
            video_url: `${FILES}/tr/t1.mp4?${SIG}`,
          },
        },
      },
      "GET /v3/video-translations/t2": {
        body: {
          data: {
            id: "t2",
            status: "completed",
            output_language: "French",
            video_url: `${FILES}/tr/t2.mp4`,
          },
        },
      },
      "GET /tr/t1.mp4": { status: 403, raw: "expired" },
      "GET /tr/t2.mp4": { raw: "FR" },
    });
    const err = await run(
      "translate",
      "asset:src1",
      "--languages",
      "Spanish,French",
      "--poll-interval",
      "1",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(HeygenJobFailedError);
    expect(err.message).toMatch(/1 of 2 translation jobs delivered; 1 failed/);
    expect(err.message).toMatch(/translation t1:.*may have expired/s);
    expect(err.message).not.toContain("TOPSECRETSIG");
    expect(fs.readFileSync(path.join(tmp, "heygen-translation-French-t2.mp4"), "utf8")).toBe("FR");
    expect(printed()).toContain("heygen-translation-French-t2.mp4");
  });

  it("refuses an http:// HEYGEN_BASE_URL for a non-loopback host before any request", async () => {
    vi.stubEnv("HEYGEN_BASE_URL", "http://proxy.example/heygen");
    useApi({});
    const err = await run("video", "Hello", "--avatar", "look1").catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toMatch(/HEYGEN_BASE_URL must use https:\/\//);
    expect(err.message).not.toContain(KEY);
    expect(fake.calls).toHaveLength(0);
  });

  it("allows an http:// HEYGEN_BASE_URL on loopback for local mocks", async () => {
    vi.stubEnv("HEYGEN_BASE_URL", "http://127.0.0.1:8787");
    useApi({ "POST /v3/videos": { body: { data: { video_id: "v1", status: "waiting" } } } });
    await run("video", "Hello", "--avatar", "look1", "--async", "--json");
    expect(fake.calls[0]?.url).toBe("http://127.0.0.1:8787/v3/videos");
  });

  it("refuses to download a non-https output URL and redacts it", async () => {
    useApi({
      "GET /v3/videos/v7": completed({ video_url: `http://files.heygen.test/out/v7.mp4?${SIG}` }),
    });
    const err = await run("status", "v7", "--type", "video", "--download", "--no-thumb").catch(
      (e) => e,
    );
    expect(err.message).toMatch(/non-https URL \(http:\/\/files\.heygen\.test\/out\/v7\.mp4/);
    expect(err.message).not.toContain("TOPSECRETSIG");
    expect(fake.callsTo("GET /out/v7.mp4")).toHaveLength(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("refuses a non-https caption URL", async () => {
    useApi({
      "GET /v3/videos/v7": completed({
        video_url: `${FILES}/out/v7.mp4`,
        subtitle_url: `http://files.heygen.test/out/v7.srt?${SIG}`,
      }),
      "GET /out/v7.mp4": { raw: "V7" },
    });
    const err = await run(
      "status",
      "v7",
      "--type",
      "video",
      "--download",
      "--captions",
      "--no-thumb",
    ).catch((e) => e);
    expect(err.message).toMatch(/non-https URL/);
    expect(err.message).not.toContain("TOPSECRETSIG");
    expect(fake.callsTo("GET /out/v7.srt")).toHaveLength(0);
  });

  it("skips a non-https thumbnail with a warning but keeps the video", async () => {
    useApi({
      "GET /v3/videos/v7": completed({
        video_url: `${FILES}/out/v7.mp4`,
        thumbnail_url: `http://files.heygen.test/out/v7.jpg?${SIG}`,
      }),
      "GET /out/v7.mp4": { raw: "V7" },
    });
    await run("status", "v7", "--type", "video", "--download");
    expect(fs.readdirSync(tmp)).toEqual(["heygen-video-v7.mp4"]);
    expect(fake.callsTo("GET /out/v7.jpg")).toHaveLength(0);
    expect(printed()).toMatch(/Skipping thumbnail from a non-https URL/);
    expect(printed()).not.toContain("TOPSECRETSIG");
  });

  it("reports a create response without a job ID instead of polling", async () => {
    useApi({ "POST /v3/videos": { body: { data: { status: "waiting" } } } });
    const err = await run("video", "Hello", "--avatar", "look1").catch((e) => e);
    expect(err.message).toMatch(/returned no video_id/);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("heygen https-only redirects", () => {
  const completed = (extra: Record<string, unknown>) => ({
    body: { data: { id: "v7", status: "completed", ...extra } },
  });

  it("refuses an output URL that redirects to plain http before writing anything", async () => {
    useApi({
      "GET /v3/videos/v7": completed({ video_url: `${FILES}/out/v7.mp4?${SIG}` }),
      "GET /out/v7.mp4": {
        status: 302,
        headers: { Location: `http://files.heygen.test/plain/v7.mp4?${SIG}` },
      },
      "GET /plain/v7.mp4": { raw: "CLEARTEXT" },
    });
    const err = await run("status", "v7", "--type", "video", "--download", "--no-thumb").catch(
      (e) => e,
    );
    expect(err.message).toMatch(/non-https URL/);
    expect(err.message).not.toContain("TOPSECRETSIG");
    expect(fake.callsTo("GET /plain/v7.mp4")).toHaveLength(0);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("follows an https -> https redirect", async () => {
    useApi({
      "GET /v3/videos/v7": completed({ video_url: `${FILES}/out/v7.mp4` }),
      "GET /out/v7.mp4": { status: 307, headers: { Location: "/cdn/v7.mp4" } },
      "GET /cdn/v7.mp4": { raw: "V7" },
    });
    await run("status", "v7", "--type", "video", "--download", "--no-thumb");
    expect(fs.readFileSync(path.join(tmp, "heygen-video-v7.mp4"), "utf8")).toBe("V7");
    expect(fake.callsTo("GET /out/v7.mp4")[0]?.url).toBe(`${FILES}/out/v7.mp4`);
  });

  it("refuses a response whose final URL is not https", async () => {
    useApi({ "GET /v3/videos/v7": completed({ video_url: `${FILES}/out/v7.mp4?${SIG}` }) });
    const apiFetch = fake.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/out/v7.mp4")) return apiFetch(input, init);
      const res = new Response("CLEARTEXT");
      Object.defineProperty(res, "url", { value: `http://files.heygen.test/out/v7.mp4?${SIG}` });
      return res;
    });
    const err = await run("status", "v7", "--type", "video", "--download", "--no-thumb").catch(
      (e) => e,
    );
    expect(err.message).toMatch(/redirected to a non-https URL/);
    expect(err.message).not.toContain("TOPSECRETSIG");
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("skips a thumbnail that redirects to plain http but keeps the video", async () => {
    useApi({
      "GET /v3/videos/v7": completed({
        video_url: `${FILES}/out/v7.mp4`,
        thumbnail_url: `${FILES}/out/v7.jpg?${SIG}`,
      }),
      "GET /out/v7.mp4": { raw: "V7" },
      "GET /out/v7.jpg": {
        status: 301,
        headers: { Location: "http://files.heygen.test/plain/v7.jpg" },
      },
      "GET /plain/v7.jpg": { raw: "JPEG" },
    });
    await run("status", "v7", "--type", "video", "--download");
    expect(fs.readdirSync(tmp)).toEqual(["heygen-video-v7.mp4"]);
    expect(fake.callsTo("GET /plain/v7.jpg")).toHaveLength(0);
    expect(printed()).toMatch(/Thumb download failed/);
    expect(printed()).not.toContain("TOPSECRETSIG");
  });
});

describe("heygen output naming", () => {
  const translation = (id: string, data: Record<string, unknown>) => ({
    body: { data: { id, status: "completed", ...data } },
  });

  async function translate(languages: string, ...extra: string[]) {
    await run(
      "translate",
      "asset:src1",
      "--languages",
      languages,
      "--poll-interval",
      "1",
      ...extra,
    );
  }

  it("never lets two outputs share a template name (case-insensitive)", async () => {
    useApi({
      "POST /v3/video-translations": {
        body: { data: { video_translation_ids: ["t1", "t2", "t3"] } },
      },
      "GET /v3/video-translations/t1": translation("t1", {
        output_language: "Spanish",
        video_url: `${FILES}/tr/t1.mp4`,
      }),
      "GET /v3/video-translations/t2": translation("t2", {
        output_language: "Spanish",
        video_url: `${FILES}/tr/t2.mp4`,
      }),
      "GET /v3/video-translations/t3": translation("t3", {
        output_language: "spanish",
        video_url: `${FILES}/tr/t3.mp4`,
      }),
      "GET /tr/t1.mp4": { raw: "ONE" },
      "GET /tr/t2.mp4": { raw: "TWO" },
      "GET /tr/t3.mp4": { raw: "THREE" },
    });
    const outDir = path.join(tmp, "out");
    await translate("Spanish,spanish,Spanish (Spain)", "--output", path.join(outDir, "dub.mp4"));
    const read = (f: string) => fs.readFileSync(path.join(outDir, f), "utf8");
    expect(fs.readdirSync(outDir).sort()).toEqual([
      "dub-Spanish-t2.mp4",
      "dub-Spanish.mp4",
      "dub-spanish-t3.mp4",
    ]);
    expect([
      read("dub-Spanish.mp4"),
      read("dub-Spanish-t2.mp4"),
      read("dub-spanish-t3.mp4"),
    ]).toEqual(["ONE", "TWO", "THREE"]);
  });

  it("saves template captions next to each video", async () => {
    useApi({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["t1", "t2"] } } },
      "GET /v3/video-translations/t1": translation("t1", {
        output_language: "Spanish",
        video_url: `${FILES}/tr/t1.mp4`,
        srt_caption_url: `${FILES}/tr/t1.srt`,
      }),
      "GET /v3/video-translations/t2": translation("t2", {
        output_language: "French",
        video_url: `${FILES}/tr/t2.mp4`,
        vtt_caption_url: `${FILES}/tr/t2.vtt`,
      }),
      "GET /tr/t1.mp4": { raw: "ES" },
      "GET /tr/t1.srt": { raw: "ES-SUBS" },
      "GET /tr/t2.mp4": { raw: "FR" },
      "GET /tr/t2.vtt": { raw: "FR-SUBS" },
    });
    await translate("Spanish,French", "--output", path.join(tmp, "dub.mp4"), "--captions");
    expect(fs.readdirSync(tmp).sort()).toEqual([
      "dub-French.mp4",
      "dub-French.vtt",
      "dub-Spanish.mp4",
      "dub-Spanish.srt",
    ]);
  });

  it("does not save captions over a video whose --output has a subtitle extension", async () => {
    useApi({
      "GET /v3/videos/v7": translation("v7", {
        video_url: `${FILES}/out/v7.mp4`,
        subtitle_url: `${FILES}/out/v7.srt`,
      }),
      "GET /out/v7.mp4": { raw: "VIDEO" },
      "GET /out/v7.srt": { raw: "SUBS" },
    });
    const dest = path.join(tmp, "x.srt");
    await run(
      "status",
      "v7",
      "--type",
      "video",
      "--download",
      "--captions",
      "--no-thumb",
      "--output",
      dest,
    );
    expect(fs.readFileSync(dest, "utf8")).toBe("VIDEO");
    expect(fs.readFileSync(path.join(tmp, "x.captions.srt"), "utf8")).toBe("SUBS");
  });

  it("treats a trailing separator, an existing directory, or no extension as a directory", async () => {
    useApi({
      "GET /v3/videos/v7": translation("v7", { video_url: `${FILES}/out/v7.mp4` }),
      "GET /out/v7.mp4": { raw: "V7" },
    });
    const download = (output: string) =>
      run("status", "v7", "--type", "video", "--download", "--no-thumb", "--output", output);

    await download(`${path.join(tmp, "renders.mp4")}${path.sep}`);
    expect(fs.readdirSync(path.join(tmp, "renders.mp4"))).toEqual(["heygen-video-v7.mp4"]);

    const existing = path.join(tmp, "final.mov");
    fs.mkdirSync(existing);
    await download(existing);
    expect(fs.readdirSync(existing)).toEqual(["heygen-video-v7.mp4"]);

    await download(path.join(tmp, "outdir"));
    expect(fs.readdirSync(path.join(tmp, "outdir"))).toEqual(["heygen-video-v7.mp4"]);
  });

  it("names audio-only translations with the audio extension", async () => {
    useApi({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["t1", "t2"] } } },
      "GET /v3/video-translations/t1": translation("t1", {
        output_language: "Spanish",
        audio_url: `${FILES}/tr/t1.mp3`,
      }),
      "GET /v3/video-translations/t2": translation("t2", {
        output_language: "French",
        audio_url: `${FILES}/tr/t2`,
      }),
      "GET /tr/t1.mp3": { raw: "ES" },
      "GET /tr/t2": { raw: "FR" },
    });
    await translate("Spanish,French", "--audio-only", "--output", path.join(tmp, "dub.mp4"));
    expect(fs.readdirSync(tmp).sort()).toEqual(["dub-French.mp3", "dub-Spanish.mp3"]);

    fs.rmSync(path.join(tmp, "dub-French.mp3"));
    fs.rmSync(path.join(tmp, "dub-Spanish.mp3"));
    await run("status", "t2", "--type", "translation", "--download");
    expect(fs.readdirSync(tmp)).toEqual(["heygen-translation-French-t2.mp3"]);
  });
});

describe("heygen catalog", () => {
  it("pages avatars with --cursor and prints has_more/next_token in JSON", async () => {
    useApi({
      "GET /v3/avatars/looks": {
        body: {
          data: [{ id: "look1", name: "Anna", avatar_type: "studio_avatar" }],
          has_more: true,
          next_token: "next-2",
        },
      },
    });
    await run("avatars", "--limit", "1", "--cursor", "tok-1", "--json");
    const call = fake.calls[0];
    expect(call?.query.get("limit")).toBe("1");
    expect(call?.query.get("token")).toBe("tok-1");
    expect(JSON.parse(printed())).toMatchObject({
      data: [{ id: "look1" }],
      has_more: true,
      next_token: "next-2",
    });
  });

  it("prints a next-page hint for voices in table mode", async () => {
    useApi({
      "GET /v3/voices": {
        body: {
          data: [{ voice_id: "v1", name: "Ava", language: "English", gender: "female" }],
          has_more: true,
          next_token: "vtok",
        },
      },
    });
    await run("voices", "--language", "English");
    expect(fake.calls[0]?.query.get("language")).toBe("English");
    expect(printed()).toContain("--cursor vtok");
  });

  it("rejects an out-of-range --limit before calling the API", async () => {
    useApi({});
    await expect(run("avatars", "--limit", "500")).rejects.toThrow(/--limit/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("heygen tts and run", () => {
  it("synthesizes speech and saves the audio", async () => {
    useApi({
      "POST /v3/voices/speech": {
        body: {
          data: {
            audio_url: `${FILES}/tts/a.mp3?${SIG}`,
            duration: 1.5,
            request_id: "r1",
            engine: "starfish",
          },
        },
      },
      "GET /tts/a.mp3": { raw: "MP3" },
    });
    const dest = path.join(tmp, "hello.mp3");
    await run("tts", "Hello world", "--voice", "voice1", "--output", dest);
    expect(fake.callsTo("POST /v3/voices/speech")[0]?.body).toEqual({
      text: "Hello world",
      voice_id: "voice1",
    });
    expect(fs.readFileSync(dest, "utf8")).toBe("MP3");
  });

  it("sends a raw payload and tracks every returned job ID", async () => {
    useApi({
      "POST /v3/video-translations": { body: { data: { video_translation_ids: ["a", "b"] } } },
    });
    await run(
      "run",
      "video-translation",
      "--input",
      '{"video":{"type":"url","url":"https://cdn.test/v.mp4"},"output_languages":["Spanish","French"]}',
      "--async",
      "--json",
    );
    const call = fake.calls[0];
    expect(call?.headers["idempotency-key"]).toBeTruthy();
    const jobs = JSON.parse(printed().slice(printed().indexOf("[")));
    expect(jobs.map((j: { id: string }) => j.id)).toEqual(["a", "b"]);
  });

  it("rejects an unknown operation", async () => {
    useApi({});
    await expect(run("run", "photo-avatar", "--input", "{}")).rejects.toThrow(/Unknown operation/);
  });
});
