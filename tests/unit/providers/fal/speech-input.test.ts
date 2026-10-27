/**
 * `fal tts` input mapping against fal's own schemas. The fixtures are the
 * input/output schemas of fal's live OpenAPI for each verified endpoint
 * (trimmed), so a profile that drifts from what fal accepts fails here.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import { buildSpeechRequest } from "../../../../src/providers/fal/speech-input.js";
import {
  FAL_SPEECH_MODELS,
  expectedAudioExt,
  findSpeechModel,
  listFalSpeechCatalog,
} from "../../../../src/providers/fal/speech-models.js";

interface SchemaFixture {
  endpoint_id: string;
  input: {
    properties: Record<string, { enum?: string[]; maxLength?: number }>;
    required?: string[];
  };
  output: { properties: Record<string, unknown>; required?: string[] };
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtures: SchemaFixture[] = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".schema.json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")));

describe("verified speech profiles match fal's schemas", () => {
  it("has a schema fixture for every verified model", () => {
    expect(fixtures.map((f) => f.endpoint_id).sort()).toEqual(
      FAL_SPEECH_MODELS.map((m) => m.id).sort(),
    );
  });

  for (const fixture of fixtures) {
    it(`${fixture.endpoint_id}: every mapped field exists with the same constraints`, () => {
      const m = findSpeechModel(fixture.endpoint_id);
      if (!m) throw new Error("profile missing");
      const props = fixture.input.properties;
      for (const field of [
        m.textField,
        m.voiceField,
        m.styleField,
        m.languageField,
        m.formatField,
        m.dialogueField,
      ]) {
        if (field) expect(props, field).toHaveProperty(field);
      }
      expect(props[m.voiceField]?.enum).toEqual(m.voices ? [...m.voices] : undefined);
      if (m.formatField)
        expect(props[m.formatField]?.enum).toEqual(m.formats ? [...m.formats] : []);
      expect(props[m.textField]?.maxLength).toBe(m.maxTextChars);
      // Nothing the CLI does not send may be required.
      for (const req of fixture.input.required ?? []) expect(req).toBe(m.textField);
      expect(fixture.output.required).toEqual(["audio"]);
    });
  }
});

describe("buildSpeechRequest", () => {
  it("maps Gemini flags onto prompt / voice / style_instructions, canonicalising the voice", () => {
    const r = buildSpeechRequest({
      model: "google/gemini-3.8-flash-tts",
      text: "Xin chào",
      voice: "puck",
      style: "warm",
    });
    expect(r.input).toEqual({ prompt: "Xin chào", voice: "Puck", style_instructions: "warm" });
    expect(r.format).toBeUndefined();
  });

  it("maps ElevenLabs flags onto text / voice / output_format / language_code", () => {
    const r = buildSpeechRequest({
      model: "elevenlabs/tts/eleven-v4-turbo",
      text: "Hello",
      voice: "my-cloned-voice-id",
      format: "pcm_16000",
      language: "vi",
    });
    expect(r.input).toEqual({
      text: "Hello",
      voice: "my-cloned-voice-id",
      output_format: "pcm_16000",
      language_code: "vi",
    });
    expect(expectedAudioExt(r.profile, r.format)).toBe("pcm");
  });

  it("refuses flags the model has no field for, and values outside its lists", () => {
    const cases: Array<Parameters<typeof buildSpeechRequest>[0]> = [
      { model: "elevenlabs/tts/eleven-v4", text: "x", style: "warm" },
      { model: "google/gemini-3.8-flash-tts", text: "x", format: "mp3_44100_128" },
      { model: "google/gemini-3.8-flash-tts", text: "x", language: "en" },
      { model: "google/gemini-3.8-flash-tts", text: "x", voice: "Rachel" },
      { model: "elevenlabs/tts/eleven-v4", text: "x", format: "wav" },
      { model: "elevenlabs/tts/eleven-v4", text: "   " },
      { model: "elevenlabs/tts/eleven-v4", text: "é".repeat(5001) },
      { model: "google/gemini-3.8-flash-tts" },
      { model: "google/gemini-3.8-flash-tts", text: "x", extra: { prompt: "y" } },
    ];
    for (const c of cases)
      expect(() => buildSpeechRequest(c), JSON.stringify(c)).toThrow(ValidationError);
  });

  it("counts the text limit in code points", () => {
    expect(() =>
      buildSpeechRequest({ model: "elevenlabs/tts/eleven-v4", text: "😀".repeat(5000) }),
    ).not.toThrow();
  });

  it("takes Gemini dialogue through --input without a text, canonicalising speaker voices", () => {
    const turns = [
      { speaker_id: "a", text: "Hi" },
      { speaker_id: "b", text: "Hello", style_instructions: "warm" },
    ];
    const speakers = [
      { speaker_id: "a", voice: "kore" },
      { speaker_id: "b", voice: "Puck" },
    ];
    const r = buildSpeechRequest({
      model: "google/gemini-3.8-flash-tts",
      extra: { turns, speakers },
    });
    expect(r.input).toEqual({
      turns,
      speakers: [
        { speaker_id: "a", voice: "Kore" },
        { speaker_id: "b", voice: "Puck" },
      ],
    });
  });

  it("refuses a malformed Gemini dialogue before anything is submitted", () => {
    const model = "google/gemini-3.8-flash-tts";
    const a = { speaker_id: "a", voice: "Kore" };
    const b = { speaker_id: "b", voice: "Puck" };
    const turn = { speaker_id: "a", text: "Hi" };
    const cases: Array<[Parameters<typeof buildSpeechRequest>[0], RegExp]> = [
      [{ model, extra: { turns: [turn] } }, /needs "speakers"/],
      [{ model, extra: { turns: [], speakers: [a, b] } }, /must not be empty/],
      [{ model, extra: { turns: "hi", speakers: [a, b] } }, /array of objects/],
      [{ model, extra: { turns: [turn], speakers: [a] } }, /exactly 2 entries/],
      [{ model, extra: { turns: [turn], speakers: [a, b, a] } }, /exactly 2 entries/],
      [{ model, extra: { turns: [turn], speakers: [a, a] } }, /is repeated/],
      [{ model, extra: { turns: [turn], speakers: [a, { speaker_id: "b" }] } }, /voice/],
      [
        { model, extra: { turns: [turn], speakers: [a, { ...b, voice: "Rachel" }] } },
        /Unknown voice "Rachel"/,
      ],
      [
        { model, extra: { turns: [{ speaker_id: "c", text: "x" }], speakers: [a, b] } },
        /not one of/,
      ],
      [{ model, extra: { turns: [{ speaker_id: "a", text: " " }], speakers: [a, b] } }, /text/],
      [{ model, text: "Hi", extra: { turns: [turn], speakers: [a, b] } }, /Omit the text/],
      [{ model, extra: { prompt: "Hi", turns: [turn], speakers: [a, b] } }, /Omit the text/],
      [
        { model, voice: "Kore", extra: { turns: [turn], speakers: [a, b] } },
        /each speaker's voice/,
      ],
      [
        { model, extra: { voice: "Kore", turns: [turn], speakers: [a, b] } },
        /each speaker's voice/,
      ],
      [{ model, text: "Hi", extra: { speakers: [a, b] } }, /needs "turns"/],
      [{ model, extra: { turns: [turn], speakers: null } }, /needs "speakers"/],
      [{ model, extra: { turns: [turn], speakers: [a, { ...b, style: "x" }] } }, /unknown field/],
      [
        { model, extra: { turns: [{ ...turn, voice: "Kore" }], speakers: [a, b] } },
        /unknown field/,
      ],
    ];
    for (const [c, pattern] of cases) {
      expect(() => buildSpeechRequest(c), JSON.stringify(c)).toThrow(pattern);
    }
  });

  it("holds --input values to the same rules as the flags", () => {
    const eleven = "elevenlabs/tts/eleven-v4";
    const gemini = "google/gemini-3.8-flash-tts";
    const cases: Array<[Parameters<typeof buildSpeechRequest>[0], RegExp]> = [
      [{ model: eleven, extra: { text: "é".repeat(5001) } }, /at most 5000/],
      [{ model: eleven, extra: { text: 42 } }, /must be a string/],
      [{ model: gemini, text: "x", extra: { voice: "Rachel" } }, /Unknown voice/],
      [{ model: gemini, text: "x", extra: { voice: 3 } }, /non-empty string/],
      [{ model: eleven, text: "x", extra: { output_format: "wav" } }, /Unknown --input/],
      [{ model: eleven, text: "x", extra: { language_code: "english!" } }, /language code/],
      [{ model: eleven, text: "x", language: "english!" }, /language code/],
    ];
    for (const [c, pattern] of cases) {
      expect(() => buildSpeechRequest(c), JSON.stringify(c)).toThrow(pattern);
    }
    expect(
      buildSpeechRequest({ model: gemini, extra: { prompt: "x", voice: "puck" } }).input,
    ).toEqual({ prompt: "x", voice: "Puck" });
    expect(
      buildSpeechRequest({ model: eleven, text: "x", extra: { language_code: "pt-BR" } }).input,
    ).toEqual({ text: "x", language_code: "pt-BR" });
    // null is how fal's playground writes an unset optional field.
    expect(
      buildSpeechRequest({
        model: gemini,
        extra: { prompt: "Hi", speakers: null, turns: null, voice: null },
      }).input,
    ).toEqual({ prompt: "Hi", speakers: null, turns: null, voice: null });
    expect(
      buildSpeechRequest({
        model: eleven,
        text: "x",
        extra: { language_code: null, output_format: null },
      }).format,
    ).toBeUndefined();
    expect(() => buildSpeechRequest({ model: gemini, extra: { prompt: null } })).toThrow(
      /Provide the text/,
    );
    expect(
      buildSpeechRequest({ model: eleven, text: "x", language: "zh-Hant-TW" }).input,
    ).toMatchObject({ language_code: "zh-Hant-TW" });
    // Unlisted models keep their own voice names.
    expect(
      buildSpeechRequest({
        model: "fal-ai/other-tts",
        textField: "input",
        voiceField: "speaker",
        extra: { input: "x", speaker: "anything" },
      }).input,
    ).toEqual({ input: "x", speaker: "anything" });
  });

  it("passes extra fields through and reads the format they set", () => {
    const r = buildSpeechRequest({
      model: "elevenlabs/tts/eleven-v4",
      text: "x",
      extra: { stability: 0.3, output_format: "opus_48000_64" },
    });
    expect(r.input).toMatchObject({ text: "x", stability: 0.3 });
    expect(expectedAudioExt(r.profile, r.format)).toBe("ogg");
  });

  it("needs --text-field for an unlisted model and never guesses its schema", () => {
    expect(() => buildSpeechRequest({ model: "fal-ai/other-tts", text: "x" })).toThrow(
      /--text-field/,
    );
    expect(() =>
      buildSpeechRequest({ model: "fal-ai/other-tts", text: "x", textField: "input", voice: "a" }),
    ).toThrow(/--voice-field/);
    expect(() =>
      buildSpeechRequest({ model: "fal-ai/other-tts", text: "x", textField: "a.b" }),
    ).toThrow(ValidationError);
    const r = buildSpeechRequest({
      model: "fal-ai/other-tts",
      text: "x",
      textField: "input",
      voiceField: "speaker",
      voice: "anna",
    });
    expect(r.input).toEqual({ input: "x", speaker: "anna" });
    expect(r.profile).toBeUndefined();
  });
});

describe("listFalSpeechCatalog control characters", () => {
  it("drops terminal control characters from catalog text", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { endpoint_id: "fal-ai/x\u001b[2J-tts", metadata: { display_name: "A\u0007B" } },
          ],
        }),
      )) as typeof fetch;
    expect(await listFalSpeechCatalog(fetchFn)).toEqual([
      { endpoint_id: "fal-ai/x[2J-tts", display_name: "AB" },
    ]);
  });
});

describe("listFalSpeechCatalog", () => {
  it("follows the cursor and keeps only well-formed entries; sends no key", async () => {
    const seen: Array<{ url: string; headers: unknown }> = [];
    const pages = [
      {
        models: [
          { endpoint_id: "google/gemini-3.8-flash-tts", metadata: { display_name: "G" } },
          { metadata: {} },
        ],
        has_more: true,
        next_cursor: "c2",
      },
      {
        models: [{ endpoint_id: "fal-ai/x-tts", metadata: { status: "active" } }],
        has_more: false,
      },
    ];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers });
      return new Response(JSON.stringify(pages.shift()));
    }) as typeof fetch;
    const list = await listFalSpeechCatalog(fetchFn);
    expect(list).toEqual([
      { endpoint_id: "google/gemini-3.8-flash-tts", display_name: "G" },
      { endpoint_id: "fal-ai/x-tts", status: "active" },
    ]);
    expect(seen[0]?.url).toContain("category=text-to-speech");
    expect(seen[1]?.url).toContain("cursor=c2");
    expect(JSON.stringify(seen)).not.toMatch(/authorization/i);
  });
});

describe("listFalSpeechCatalog paging guard", () => {
  it("stops on an empty page or a repeated cursor", async () => {
    const run = async (pages: unknown[]) => {
      let calls = 0;
      const fetchFn = (async () => {
        calls++;
        return new Response(JSON.stringify(pages.shift() ?? { models: [], has_more: false }));
      }) as typeof fetch;
      const list = await listFalSpeechCatalog(fetchFn, { maxPages: 10 });
      return { ids: list.map((m) => m.endpoint_id), calls };
    };
    expect(
      await run([
        { models: [{ endpoint_id: "a" }], has_more: true, next_cursor: "c1" },
        { models: [], has_more: true, next_cursor: "c2" },
        { models: [{ endpoint_id: "never" }], has_more: false },
      ]),
    ).toEqual({ ids: ["a"], calls: 2 });
    expect(
      await run([
        { models: [{ endpoint_id: "a" }], has_more: true, next_cursor: "c1" },
        { models: [{ endpoint_id: "b" }], has_more: true, next_cursor: "c1" },
        { models: [{ endpoint_id: "never" }], has_more: false },
      ]),
    ).toEqual({ ids: ["a", "b"], calls: 2 });
  });
});
