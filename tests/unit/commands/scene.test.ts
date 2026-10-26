/**
 * Scene workflow: two speakers across three scenes, rendered through the real
 * OpenAI and ElevenLabs adapters against a fake fetch that returns audio
 * derived from the request body (so equal requests give equal bytes).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SceneManifest,
  allLines,
  cacheKey,
  findLine,
  planScenes,
  summarize,
} from "../../../src/commands/scene/scene-manifest.js";
import { renderScenes } from "../../../src/commands/scene/scene-render.js";
import { chunkText, parseScript } from "../../../src/commands/scene/script-parser.js";
import {
  VOICE_PROFILE_SCHEMA,
  type VoiceProfile,
  loadProfiles,
  profileErrors,
  writeProfile,
} from "../../../src/commands/scene/voice-profile.js";

const HIRO: VoiceProfile = {
  schema: VOICE_PROFILE_SCHEMA,
  id: "hiro",
  aliases: ["Hiro"],
  version: 1,
  provider: "openai",
  model: "gpt-4o-mini-tts",
  voice: "marin",
  language: "vi",
  format: "mp3",
  style: "calm, low",
};
const MAI: VoiceProfile = {
  schema: VOICE_PROFILE_SCHEMA,
  id: "mai",
  version: 1,
  provider: "elevenlabs",
  model: "eleven_multilingual_v2",
  voice: "kdmDKE6EkgrWrrykO9Qt",
  language: "vi",
  format: "mp3_44100_128",
  settings: { stability: 0.4 },
};

const SCENES: Record<string, string> = {
  "s01.txt": "# title: Rooftop\nHIRO: Xin chào, Mai.\nMAI: Anh đến muộn.\nHIRO: Xin lỗi.\n",
  "s02.txt": "# scene: s02\nMAI: Lại nữa à?\nHIRO (tired): Lần cuối thôi.\nMAI: Được rồi.\n",
  "s03.txt": "HIRO: Đi thôi.\nMAI: Ừ.\n",
};

let tmp: string;
let calls: Array<{ url: string; body: string }>;
let failUrl: RegExp | undefined;
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };

function fakeFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    if (failUrl?.test(body)) return new Response("upstream exploded", { status: 500 });
    const audio = Buffer.concat([
      Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      createHash("sha256")
        .update(url + body)
        .digest(),
    ]);
    return new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });
  }) as typeof fetch;
}

function writeScripts(files: Record<string, string>): string[] {
  return Object.entries(files).map(([name, text]) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, text);
    return file;
  });
}

function plan(previous?: SceneManifest) {
  const scripts = Object.keys(SCENES).map((name) => ({
    path: name,
    source: fs.readFileSync(path.join(tmp, name), "utf8"),
  }));
  return planScenes({ scripts, profiles: loadProfiles(tmp), project: "demo", previous });
}

function selectedSha(manifest: SceneManifest): Record<string, string | undefined> {
  return Object.fromEntries(
    allLines(manifest).map((l) => [l.id, l.takes.find((t) => t.id === l.selected_take)?.sha256]),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-scene-"));
  calls = [];
  failUrl = undefined;
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.ELEVENLABS_API_KEY = "el-test-not-real";
  writeProfile(tmp, HIRO);
  writeProfile(tmp, MAI);
  writeScripts(SCENES);
  fakeFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scene render", () => {
  it("re-renders only the edited line and keeps every other take byte-identical", async () => {
    const first = plan().manifest;
    expect(first.scenes.map((s) => s.id)).toEqual(["s01", "s02", "s03"]);
    expect(allLines(first)).toHaveLength(8);
    const r1 = await renderScenes({
      projectDir: tmp,
      manifest: first,
      profiles: loadProfiles(tmp),
    });
    expect(r1.rendered).toHaveLength(8);
    expect(calls).toHaveLength(8);
    const before = selectedSha(first);

    // Nothing changed: no request at all.
    calls = [];
    const again = plan(first).manifest;
    const r2 = await renderScenes({
      projectDir: tmp,
      manifest: again,
      profiles: loadProfiles(tmp),
    });
    expect(r2.rendered).toEqual([]);
    expect(r2.cached).toBe(8);
    expect(calls).toHaveLength(0);

    // Edit one line of scene 2.
    writeScripts({
      "s02.txt": SCENES["s02.txt"]?.replace("Lần cuối thôi.", "Lần cuối, anh hứa.") ?? "",
    });
    const edited = plan(again);
    expect(edited.invalidated).toEqual(["s02/002"]);
    calls = [];
    const r3 = await renderScenes({
      projectDir: tmp,
      manifest: edited.manifest,
      profiles: loadProfiles(tmp),
    });
    expect(r3.rendered).toEqual(["s02/002"]);
    expect(calls).toHaveLength(1);
    const after = selectedSha(edited.manifest);
    for (const [id, sha] of Object.entries(before)) {
      if (id === "s02/002") expect(after[id]).not.toBe(sha);
      else expect(after[id]).toBe(sha);
    }
    // The old take stays in the line history for comparison.
    expect(findLine(edited.manifest, "s02/002").takes).toHaveLength(2);
  });

  it("sends each provider its own request shape with style, direction and settings", async () => {
    const { manifest } = plan();
    await renderScenes({ projectDir: tmp, manifest, profiles: loadProfiles(tmp), scene: "s01" });
    const openai = JSON.parse(calls[0]?.body ?? "{}");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(openai).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      instructions: "calm, low",
    });
    const eleven = JSON.parse(calls[1]?.body ?? "{}");
    expect(calls[1]?.url).toContain(
      "/text-to-speech/kdmDKE6EkgrWrrykO9Qt?output_format=mp3_44100_128",
    );
    expect(eleven).toMatchObject({
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4 },
    });
    expect(eleven.language_code).toBeUndefined(); // multilingual_v2 takes no language code
    expect(eleven.previous_text).toBeUndefined(); // context is opt-in
  });

  it("flags an invalid voice and unsupported markup before any request", () => {
    writeProfile(tmp, { ...MAI, voice: "not-a-voice" } as VoiceProfile);
    expect(() => loadProfiles(tmp)).toThrow(/not an ElevenLabs voice id/);
    writeProfile(tmp, MAI);
    writeScripts({ "s03.txt": "HIRO: Đi thôi [whispers].\nMAI: Ừ.\n" });
    expect(() => plan()).toThrow(/audio tags \[whispers\]/);
    writeScripts({ "s03.txt": 'HIRO: Đi <break time="1s"/> thôi.\nMAI: Ừ.\n' });
    expect(() => plan()).toThrow(/<break time="1s"\/> is not supported by gpt-4o-mini-tts/);
    writeScripts({ "s03.txt": 'HIRO: Đi thôi.\nMAI: Ừ <break time="1s"/> đi.\n' });
    expect(() => plan()).not.toThrow(); // ElevenLabs v2 models read break tags
    writeScripts({ "s03.txt": "HIRO: Đi thôi.\nMAI (whispering): Ừ.\n" });
    expect(() => plan()).toThrow(/delivery direction "\(whispering\)" is not supported/);
    writeScripts({ "s03.txt": "HIRO: Đi thôi.\nKAI: Ừ.\n" });
    expect(() => plan()).toThrow(/no voice profile for speaker "KAI"/);
    expect(calls).toHaveLength(0);
  });

  it("checks keys for every provider before the first request", async () => {
    process.env.ELEVENLABS_API_KEY = "";
    const { manifest } = plan();
    await expect(
      renderScenes({ projectDir: tmp, manifest, profiles: loadProfiles(tmp) }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("never retries a failed line and stops the run there", async () => {
    failUrl = /Anh đến muộn/;
    const { manifest } = plan();
    const result = await renderScenes({ projectDir: tmp, manifest, profiles: loadProfiles(tmp) });
    expect(result.rendered).toEqual(["s01/001"]);
    expect(result.failed).toEqual([expect.objectContaining({ line: "s01/002" })]);
    expect(result.remaining).toHaveLength(6);
    expect(calls).toHaveLength(2);
    expect(findLine(manifest, "s01/002").status).toBe("failed");
    // The manifest on disk already holds the paid take.
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "multix-scene.json"), "utf8"));
    expect(findLine(saved, "s01/001").status).toBe("rendered");
  });

  it("records per-take receipts and per-scene completion with unknown cost as null", async () => {
    const { manifest } = plan();
    await renderScenes({ projectDir: tmp, manifest, profiles: loadProfiles(tmp), limit: 3 });
    const take = findLine(manifest, "s01/001").takes[0];
    expect(take).toMatchObject({
      cache_key: findLine(manifest, "s01/001").cache_key,
      mime: "audio/mpeg",
      status: "candidate",
      usage: { characters: 14, cost_usd: null, credits: null, provenance: "unknown" },
    });
    expect(take?.sha256).toBe(
      createHash("sha256")
        .update(fs.readFileSync(path.join(tmp, take?.path ?? "")))
        .digest("hex"),
    );
    const [s01, s02] = summarize(manifest);
    expect(s01).toMatchObject({
      lines: 3,
      rendered: 3,
      pending: 0,
      complete: true,
      cost_usd: null,
      unknown_cost_takes: 3,
    });
    expect(s02).toMatchObject({ rendered: 0, pending: 3, complete: false });
  });

  it("renders a new variant on request and keeps approval with the chosen take", async () => {
    const { manifest } = plan();
    await renderScenes({ projectDir: tmp, manifest, profiles: loadProfiles(tmp) });
    const line = findLine(manifest, "s03/001");
    const firstTake = line.selected_take;
    // The fake provider is deterministic, so vary the request the way a seed would.
    calls = [];
    globalThis.fetch = (async () =>
      new Response(Buffer.from([0xff, 0xfb, 1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      })) as typeof fetch;
    const r = await renderScenes({
      projectDir: tmp,
      manifest,
      profiles: loadProfiles(tmp),
      lines: ["s03/001"],
      newTake: true,
    });
    expect(r.rendered).toEqual(["s03/001"]);
    expect(line.takes).toHaveLength(2);
    expect(line.selected_take).not.toBe(firstTake);
    // Re-planning keeps the chosen variant selected.
    const replanned = plan(manifest).manifest;
    expect(findLine(replanned, "s03/001").selected_take).toBe(line.selected_take);
  });

  it("invalidates neighbours only when context continuity is sent to the provider", async () => {
    writeProfile(tmp, { ...MAI, context: true });
    const first = plan().manifest;
    expect(findLine(first, "s02/001").request.params.next_text).toBe("Lần cuối thôi.");
    await renderScenes({ projectDir: tmp, manifest: first, profiles: loadProfiles(tmp) });
    writeScripts({
      "s02.txt": SCENES["s02.txt"]?.replace("Lần cuối thôi.", "Lần cuối, anh hứa.") ?? "",
    });
    const edited = plan(first);
    // Hiro's edited line plus Mai's two neighbours whose next/previous text changed.
    expect(edited.invalidated.sort()).toEqual(["s02/001", "s02/002", "s02/003"]);
  });
});

describe("scene scripts", () => {
  it("normalises Vietnamese text so composed and decomposed input hash alike", () => {
    const composed = parseScript("HIRO: Tiếng Việt", "s01").lines[0]?.text ?? "";
    const decomposed = parseScript("HIRO: Tiếng Việt", "s01").lines[0]?.text ?? "";
    expect(decomposed).toBe(composed);
    const req = { provider: "openai" as const, model: "tts-1", params: { voice: "marin" } };
    expect(cacheKey(req, decomposed)).toBe(cacheKey(req, composed));
  });

  it("parses directions, continuations and scene headers", () => {
    const parsed = parseScript(
      "# scene: intro\n# title: Mở đầu\nMAI (nhỏ nhẹ): Chào\n  mọi người.\n",
      "x",
    );
    expect(parsed).toEqual({
      scene: "intro",
      title: "Mở đầu",
      lines: [{ speaker: "MAI", direction: "nhỏ nhẹ", text: "Chào mọi người.", sourceLine: 3 }],
    });
    expect(() => parseScript("no speaker here\n", "x")).toThrow(/SPEAKER: text/);
  });

  it("splits long lines at sentence boundaries within the model limit", () => {
    const text = "Câu thứ nhất rất dài. Câu thứ hai cũng dài! Câu thứ ba? Hết.";
    const parts = chunkText(text, 25);
    expect(parts.join(" ")).toBe(text);
    for (const p of parts) expect(Array.from(p).length).toBeLessThanOrEqual(25);
    expect(chunkText("x".repeat(50), 20).map((p) => p.length)).toEqual([20, 20, 10]);
  });

  it("splits an over-long line into numbered parts in the manifest", () => {
    writeProfile(tmp, { ...HIRO, max_chars: 24 });
    writeScripts({ "s03.txt": "HIRO: Một hai ba bốn năm. Sáu bảy tám chín mười.\nMAI: Ừ.\n" });
    const ids = plan().manifest.scenes[2]?.lines.map((l) => l.id);
    expect(ids).toEqual(["s03/001.1", "s03/001.2", "s03/002"]);
  });
});

describe("voice profiles", () => {
  it("rejects credentials, cloned voices without consent and unknown settings", () => {
    expect(profileErrors({ ...HIRO, api_key: "x" })).toContainEqual(
      expect.stringContaining("credentials do not belong"),
    );
    expect(profileErrors({ ...HIRO, name: "sk-abc123" })).toContainEqual(
      expect.stringContaining("looks like a credential"),
    );
    expect(
      profileErrors({ ...MAI, clone: { consent: { granted_by: "", granted_at: "x" } } }),
    ).toEqual([
      "clone.consent.granted_by is required for a cloned voice",
      "clone.consent.granted_at must be an ISO date for a cloned voice",
    ]);
    expect(
      profileErrors({
        ...MAI,
        clone: { consent: { granted_by: "Mai's actor", granted_at: "2026-10-01" } },
      }),
    ).toEqual([]);
    expect(profileErrors({ ...MAI, settings: { warmth: 1 } })).toEqual([
      expect.stringContaining("settings.warmth is not supported by ElevenLabs"),
    ]);
    expect(profileErrors({ ...HIRO, model: "tts-1", style: "x" })).toEqual([
      "tts-1 takes no style",
    ]);
    expect(profileErrors({ ...HIRO, language: "Vietnamese" })).toEqual([
      expect.stringContaining("not a BCP 47 tag"),
    ]);
  });
});
