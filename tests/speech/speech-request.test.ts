/**
 * Speech request contract: what the façade rejects before any provider is
 * called. Fixtures span gemini, openai, elevenlabs, minimax and atlas. Pure
 * functions only; nothing here sends a request.
 */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import {
  MINIMAX_LANGUAGE_BOOST,
  type SpeechProvider,
  findSpeechModel,
  speechModels,
} from "../../src/speech/speech-catalog.js";
import {
  type SpeechInput,
  buildRoute,
  collectExtra,
  collectSpeaker,
  fallbackDifferences,
  parseRouteSpec,
  planSpeechRoutes,
  resolveFormat,
  resolveTarget,
} from "../../src/speech/speech-request.js";

const DEFAULT_MODEL: Record<SpeechProvider, string> = {
  gemini: "gemini-3.8-flash-lite-tts",
  openai: "gpt-4o-mini-tts",
  elevenlabs: "eleven_multilingual_v2",
  minimax: "speech-2.8-hd",
  atlas: "xai/tts-v1",
};
const defaultModel = (p: SpeechProvider) => DEFAULT_MODEL[p];

function input(over: Partial<SpeechInput> = {}): SpeechInput {
  return { text: "Hello there.", speakers: [], async: false, extras: {}, ...over };
}

/** Plan a single route (no fallbacks) and return it. */
function planOne(
  provider: string | undefined,
  model: string | undefined,
  over: Partial<SpeechInput> = {},
) {
  return planSpeechRoutes({
    provider,
    model,
    fallbacks: [],
    input: input(over),
    defaultModel,
  }).routes[0];
}

describe("contract fixtures: unsupported emotion", () => {
  it.each<[string, string | undefined, string, RegExp]>([
    ["gemini", undefined, "happy", /has no emotion parameter; describe it with --style instead/],
    ["openai", "gpt-4o-mini-tts", "happy", /has no emotion parameter; describe it with --style/],
    ["openai", "tts-1", "happy", /openai\/tts-1 has no emotion parameter$/],
    [
      "elevenlabs",
      undefined,
      "happy",
      /elevenlabs\/eleven_multilingual_v2 has no emotion parameter$/,
    ],
  ])("%s %s rejects --emotion %s", (provider, model, emotion, message) => {
    expect(() => planOne(provider, model, { emotion })).toThrow(ValidationError);
    expect(() => planOne(provider, model, { emotion })).toThrow(message);
  });

  it("names the allowed MiniMax emotions and accepts them on the 2.6 models only", () => {
    expect(() => planOne("minimax", "speech-02-hd", { emotion: "fluent" })).toThrow(
      /emotion must be one of: happy, sad, angry, fearful, disgusted, surprised, calm \(got "fluent"\)/,
    );
    expect(planOne("minimax", "speech-2.6-hd", { emotion: "fluent" }).model).toBe("speech-2.6-hd");
    expect(planOne("minimax", "speech-02-hd", { emotion: "calm" }).model).toBe("speech-02-hd");
  });
});

describe("contract fixtures: voice ids that belong to another provider", () => {
  it.each<[string, string | undefined, string, RegExp]>([
    [
      "elevenlabs",
      undefined,
      "marin",
      /"marin" is not an ElevenLabs voice id \(it is an OpenAI voice\)/,
    ],
    [
      "elevenlabs",
      undefined,
      "Kore",
      /"Kore" is not an ElevenLabs voice id \(it is a Gemini voice\)/,
    ],
    ["openai", "tts-1", "marin", /"marin" is not an OpenAI voice for tts-1/],
    [
      "openai",
      "gpt-4o-mini-tts",
      "Kore",
      /"Kore" is not an OpenAI voice for gpt-4o-mini-tts \(it is a Gemini voice\)/,
    ],
    [
      "gemini",
      undefined,
      "marin",
      /"marin" is not a Gemini voice for gemini-3.8-flash-lite-tts \(it is an OpenAI voice\)/,
    ],
    [
      "minimax",
      "speech-2.8-hd",
      "marin",
      /"marin" is not a MiniMax voice id \(it is an OpenAI voice\)/,
    ],
  ])("%s %s rejects voice %s", (provider, model, voice, message) => {
    expect(() => planOne(provider, model, { voice })).toThrow(message);
  });

  it("accepts the newer OpenAI voice marin on gpt-4o-mini-tts but not on tts-1", () => {
    expect(planOne("openai", "gpt-4o-mini-tts", { voice: "marin" }).voice).toBe("marin");
    expect(() => planOne("openai", "tts-1", { voice: "marin" })).toThrow(ValidationError);
    expect(() => planOne("openai", "tts-1-hd", { voice: "cedar" })).toThrow(
      /not an OpenAI voice for tts-1-hd/,
    );
  });

  it("accepts a Gemini custom voice id only on the Interactions 3.8 models", () => {
    expect(planOne("gemini", "gemini-3.8-flash-lite-tts", { voice: "voice_abc123" }).voice).toBe(
      "voice_abc123",
    );
    expect(() =>
      planOne("gemini", "gemini-2.5-flash-preview-tts", { voice: "voice_abc123" }),
    ).toThrow(/not a Gemini voice/);
    expect(planOne("gemini", undefined, { voice: "Kore" }).voice).toBe("Kore");
  });

  it("maps a recommended ElevenLabs name to its id and accepts a 20-character id", () => {
    expect(planOne("elevenlabs", undefined, { voice: "alexandra" }).voice).toBe(
      "kdmDKE6EkgrWrrykO9Qt",
    );
    expect(planOne("elevenlabs", undefined, { voice: "kdmDKE6EkgrWrrykO9Qt" }).voice).toBe(
      "kdmDKE6EkgrWrrykO9Qt",
    );
  });

  it("defaults the voice to the provider default and marks it defaulted", () => {
    const route = planOne("minimax", "speech-2.8-hd");
    expect(route.voice).toBe("English_expressive_narrator");
    expect(route.voice_defaulted).toBe(true);
    expect(planOne("openai", "gpt-4o-mini-tts", { voice: "alloy" }).voice_defaulted).toBe(false);
  });

  it("sends no voice for Atlas Cloud when none is given", () => {
    const route = planOne("atlas", undefined);
    expect(route.voice).toBeUndefined();
    expect(route.voice_defaulted).toBe(false);
  });
});

describe("contract fixtures: language, style, format, async, speakers", () => {
  it("rejects a language the model does not document", () => {
    expect(() => planOne("elevenlabs", "eleven_flash_v2", { language: "vi" })).toThrow(
      'elevenlabs/eleven_flash_v2 does not list language "vi" (documented: en)',
    );
    expect(() => planOne("openai", "tts-1", { language: "xx" })).toThrow(
      /openai\/tts-1 does not list language "xx"/,
    );
  });

  it("checks Gemini languages per model: ba is Flash-only", () => {
    expect(() => planOne("gemini", "gemini-3.8-flash-lite-tts", { language: "ba" })).toThrow(
      /does not list language "ba"/,
    );
    expect(planOne("gemini", "gemini-3.8-flash-tts", { language: "ba" }).model).toBe(
      "gemini-3.8-flash-tts",
    );
    expect(planOne("gemini", undefined, { language: "vi" }).model).toBe(
      "gemini-3.8-flash-lite-tts",
    );
  });

  it("drops MiniMax languages speech-02 does not take", () => {
    expect(() => planOne("minimax", "speech-02-hd", { language: "fa" })).toThrow(
      /minimax\/speech-02-hd does not list language "fa"/,
    );
    expect(planOne("minimax", "speech-2.8-hd", { language: "fa" }).model).toBe("speech-2.8-hd");
    expect(planOne("minimax", "speech-02-turbo", { language: "vi" }).model).toBe("speech-02-turbo");
  });

  it("accepts any language for an unknown Atlas Cloud model, since the provider checks it", () => {
    expect(planOne("atlas", "acme/custom-tts", { language: "xx" }).model).toBe("acme/custom-tts");
  });

  it("rejects --style on a model without style support", () => {
    expect(() => planOne("elevenlabs", undefined, { style: "warm" })).toThrow(
      /elevenlabs\/eleven_multilingual_v2 takes no delivery style/,
    );
    expect(planOne("gemini", undefined, { style: "warm, unhurried" }).model).toBe(
      "gemini-3.8-flash-lite-tts",
    );
  });

  it("rejects a format the model does not write", () => {
    expect(() => planOne("elevenlabs", undefined, { format: "opus" })).toThrow(
      /elevenlabs\/eleven_multilingual_v2 writes mp3\|pcm, not opus/,
    );
  });

  it("rejects --async on a model that returns audio in the same request", () => {
    expect(() => planOne("openai", undefined, { async: true })).toThrow(
      /openai\/gpt-4o-mini-tts returns audio in the same request; drop --async/,
    );
    expect(() => planOne("minimax", undefined, { async: true })).toThrow(/drop --async/);
    expect(planOne("atlas", undefined, { async: true }).provider).toBe("atlas");
  });

  it("allows several speakers only on Gemini and at most two of them", () => {
    expect(() =>
      planOne("openai", undefined, { speakers: [{ speaker: "A", voice: "alloy" }] }),
    ).toThrow(/openai\/gpt-4o-mini-tts speaks with one voice; --speaker needs gemini/);
    const three = [
      { speaker: "A", voice: "Kore" },
      { speaker: "B", voice: "Puck" },
      { speaker: "C", voice: "Zephyr" },
    ];
    expect(() => planOne("gemini", undefined, { speakers: three })).toThrow(
      /gemini\/gemini-3.8-flash-lite-tts takes at most 2 speakers/,
    );
    const two = planOne("gemini", undefined, { speakers: three.slice(0, 2) });
    expect(two.voice).toBeUndefined();
    expect(two.voice_defaulted).toBe(false);
  });

  it("checks every speaker voice against the provider", () => {
    expect(() =>
      planOne("gemini", undefined, {
        speakers: [
          { speaker: "A", voice: "Kore" },
          { speaker: "B", voice: "alloy" },
        ],
      }),
    ).toThrow(/"alloy" is not a Gemini voice/);
  });
});

describe("routing: which provider and model a request uses", () => {
  it("requires a provider or a model", () => {
    expect(() => resolveTarget(undefined, undefined, defaultModel)).toThrow(
      /Choose a provider: --provider <gemini\|openai\|elevenlabs\|minimax\|atlas\|fish\|openrouter\|fal>/,
    );
  });

  it("infers the provider from a model that exactly one provider serves", () => {
    expect(resolveTarget(undefined, "tts-1", defaultModel)).toEqual({
      provider: "openai",
      model: "tts-1",
      inferred: true,
    });
    expect(resolveTarget(undefined, "eleven_v3", defaultModel).provider).toBe("elevenlabs");
  });

  it("rejects an unknown model when no provider is named", () => {
    expect(() => resolveTarget(undefined, "no-such-model", defaultModel)).toThrow(
      /Unknown speech model "no-such-model": pass --provider too/,
    );
  });

  it("rejects a provider's model name given for a different provider", () => {
    expect(() => planOne("gemini", "tts-1")).toThrow(
      /gemini has no speech model "tts-1" \(it is a openai model\)/,
    );
  });

  it("rejects an unknown provider", () => {
    expect(() => resolveTarget("acme", undefined, defaultModel)).toThrow(
      /Unknown speech provider "acme"/,
    );
  });

  it("uses the provider default model when only the provider is given", () => {
    expect(planOne("openai", undefined).model).toBe("gpt-4o-mini-tts");
    expect(planOne("atlas", undefined).model).toBe("xai/tts-v1");
  });

  it("only the gateways (OpenRouter, fal) share a model id, and a bare --model for it asks for --provider", () => {
    const owners = new Map<string, Set<string>>();
    for (const m of speechModels()) {
      owners.set(m.model, (owners.get(m.model) ?? new Set()).add(m.provider));
    }
    for (const [model, providers] of owners) {
      if (providers.size > 1)
        expect([...providers], `model ${model}`).toEqual(["openrouter", "fal"]);
    }
    expect(() => resolveTarget(undefined, "google/gemini-3.8-flash-tts", defaultModel)).toThrow(
      /Model "google\/gemini-3.8-flash-tts" is served by openrouter and fal; pass --provider to choose/,
    );
  });
});

describe("fallback routes", () => {
  it("plans a fallback with its own model and voice", () => {
    const { routes, inferred } = planSpeechRoutes({
      provider: "gemini",
      fallbacks: ["openai:tts-1:alloy"],
      input: input(),
      defaultModel,
    });
    expect(inferred).toBe(false);
    expect(routes.map((r) => `${r.provider}/${r.model}/${r.voice ?? ""}`)).toEqual([
      "gemini/gemini-3.8-flash-lite-tts/Kore",
      "openai/tts-1/alloy",
    ]);
  });

  it("rejects a fallback that repeats a route already in the plan", () => {
    expect(() =>
      planSpeechRoutes({ provider: "openai", fallbacks: ["openai"], input: input(), defaultModel }),
    ).toThrow(/--fallback openai repeats a route already in the plan/);
  });

  it("allows a fallback on the same provider with a different model", () => {
    const { routes } = planSpeechRoutes({
      provider: "openai",
      fallbacks: ["openai:tts-1"],
      input: input({ voice: "alloy" }),
      defaultModel,
    });
    expect(routes).toHaveLength(2);
  });

  it("gives tts-1 a default voice that tts-1 accepts when --voice is omitted", () => {
    expect(() => planOne("openai", "tts-1")).not.toThrow();
  });

  it("validates a fallback now, not when it is needed", () => {
    expect(() =>
      planSpeechRoutes({
        provider: "gemini",
        fallbacks: ["elevenlabs:eleven_flash_v2:alexandra:extra"],
        input: input({ language: "vi" }),
        defaultModel,
      }),
    ).toThrow(/does not list language "vi"|is not an ElevenLabs voice id/);
    expect(() =>
      planSpeechRoutes({
        provider: "gemini",
        fallbacks: ["acme"],
        input: input(),
        defaultModel,
      }),
    ).toThrow(/Unknown speech provider "acme"/);
  });

  it("rejects an extra whose provider is on no route", () => {
    expect(() =>
      planSpeechRoutes({
        provider: "openai",
        fallbacks: [],
        input: input({ extras: { "elevenlabs.stability": "0.4" } }),
        defaultModel,
      }),
    ).toThrow(
      /--extra elevenlabs\.stability names a provider this request does not use \(openai\)/,
    );
  });

  it("accepts an extra for a provider that is a fallback route", () => {
    const { routes } = planSpeechRoutes({
      provider: "openai",
      fallbacks: ["elevenlabs"],
      input: input({ extras: { "elevenlabs.stability": "0.4" } }),
      defaultModel,
    });
    expect(routes[1]?.extras).toEqual({ stability: 0.4 });
    expect(routes[0]?.extras).toEqual({});
  });

  it("parses provider[:model[:voice]] and keeps colons inside a voice", () => {
    expect(parseRouteSpec("minimax:speech-2.6-hd:English_expressive_narrator")).toEqual({
      provider: "minimax",
      model: "speech-2.6-hd",
      voice: "English_expressive_narrator",
    });
    expect(parseRouteSpec("openai")).toEqual({ provider: "openai" });
    expect(parseRouteSpec("atlas::v:1")).toEqual({ provider: "atlas", voice: "v:1" });
    expect(() => parseRouteSpec("")).toThrow(/--fallback must be provider\[:model\[:voice\]\]/);
    expect(() => parseRouteSpec(":tts-1")).toThrow(ValidationError);
  });

  it("describes what changes from the primary route", () => {
    const primary = planOne("gemini", undefined, { format: "wav" });
    const fallback = planOne("openai", undefined, { format: "mp3" });
    const text = fallbackDifferences(primary, fallback);
    expect(text).toContain("voice Kore → marin");
    expect(text).toContain("billing per character");
    expect(text).toContain("format wav → mp3");
  });
});

describe("--extra and --speaker parsing", () => {
  it("collects provider.key=value pairs and keeps = inside the value", () => {
    expect(collectExtra("elevenlabs.stability=0.4", {})).toEqual({
      "elevenlabs.stability": "0.4",
    });
    expect(collectExtra("minimax.speed=1=2", {})).toEqual({ "minimax.speed": "1=2" });
  });

  it.each([
    "stability=0.4",
    "elevenlabs.stability",
    "=0.4",
    "Elevenlabs.stability=0.4",
    "elevenlabs.use-speaker=true",
  ])("rejects malformed --extra %s", (value) => {
    expect(() => collectExtra(value, {})).toThrow(/--extra must be <provider>\.<key>=<value>/);
  });

  it("types extras per provider and rejects bad values", () => {
    expect(() =>
      planOne("elevenlabs", undefined, { extras: { "elevenlabs.stability": "abc" } }),
    ).toThrow('--extra elevenlabs.stability must be a number (got "abc")');
    expect(() =>
      planOne("elevenlabs", undefined, { extras: { "elevenlabs.stability": "" } }),
    ).toThrow(/must be a number/);
    expect(() =>
      planOne("elevenlabs", undefined, { extras: { "elevenlabs.stability": "1e999" } }),
    ).toThrow(/must be a number/);
    expect(() =>
      planOne("elevenlabs", undefined, { extras: { "elevenlabs.use_speaker_boost": "yes" } }),
    ).toThrow('--extra elevenlabs.use_speaker_boost must be true or false (got "yes")');
    expect(() => planOne("elevenlabs", undefined, { extras: { "elevenlabs.nope": "1" } })).toThrow(
      /--extra elevenlabs\.nope is not a elevenlabs option\. Valid: elevenlabs\.stability/,
    );
    expect(() => planOne("openai", undefined, { extras: { "openai.seed": "1" } })).toThrow(
      "--extra openai.seed is not a openai option. openai takes no extras",
    );
  });

  it("types ElevenLabs and MiniMax extras", () => {
    const eleven = planOne("elevenlabs", undefined, {
      extras: { "elevenlabs.use_speaker_boost": "false", "elevenlabs.seed": "42" },
    });
    expect(eleven.extras).toEqual({ use_speaker_boost: false, seed: 42 });
    const minimax = planOne("minimax", undefined, { extras: { "minimax.speed": "1.2" } });
    expect(minimax.extras).toEqual({ speed: 1.2 });
  });

  it("collects repeated speakers and rejects a malformed one", () => {
    expect(collectSpeaker("Alex: Kore", [])).toEqual([{ speaker: "Alex", voice: "Kore" }]);
    expect(() => collectSpeaker("Alex", [])).toThrow(/--speaker must be "name:voice"/);
    expect(() => collectSpeaker(":Kore", [])).toThrow(/--speaker must be "name:voice"/);
    expect(() => collectSpeaker("Alex:", [])).toThrow(/--speaker must be "name:voice"/);
  });
});

describe("output format and --output extension", () => {
  it.each<[string | undefined, string | undefined, string | undefined]>([
    ["mp3", undefined, "mp3"],
    [undefined, "clip.opus", "opus"],
    ["mp3", "out/clip.MP3", "mp3"],
    [undefined, undefined, undefined],
    [undefined, "clip", undefined],
  ])("format %s with output %s resolves to %s", (format, output, expected) => {
    expect(resolveFormat(format, output)).toBe(expected);
  });

  it("rejects an --output extension that is not an audio container", () => {
    expect(() => resolveFormat(undefined, "notes.txt")).toThrow(ValidationError);
  });

  it("rejects a --format that disagrees with the --output extension", () => {
    expect(() => resolveFormat("wav", "clip.mp3")).toThrow(
      "--format wav does not match --output clip.mp3; use a .wav file name",
    );
  });

  it("rejects a --format the façade does not name", () => {
    expect(() => resolveFormat("ogg", undefined)).toThrow(
      /--format must be one of: mp3, wav, pcm, flac, opus, aac/,
    );
  });

  it("writes the routed format and rejects a mismatch through buildRoute", () => {
    const route = buildRoute(
      { provider: "gemini", model: "gemini-3.8-flash-lite-tts" },
      input({ format: "pcm" }),
    );
    expect(route.format).toBe("pcm");
    expect(() =>
      buildRoute(
        { provider: "gemini", model: "gemini-3.8-flash-lite-tts" },
        input({ format: "mp3" }),
      ),
    ).toThrow(/gemini\/gemini-3.8-flash-lite-tts writes wav\|pcm, not mp3/);
  });
});

describe("MiniMax language mapping", () => {
  it("maps Vietnamese to the language_boost value MiniMax documents", () => {
    expect(MINIMAX_LANGUAGE_BOOST.vi).toBe("Vietnamese");
    expect(findSpeechModel("minimax", "speech-2.8-hd")?.language_param).toBe("language_boost");
  });
});

describe("review hardening", () => {
  it("does not carry --voice to a fallback on another provider", () => {
    const { routes } = planSpeechRoutes({
      provider: "elevenlabs",
      fallbacks: ["minimax"],
      input: input({ voice: "JBFqnCBsd6RMkjVDRZzb" }),
      defaultModel,
    });
    expect(routes[1]).toMatchObject({
      provider: "minimax",
      voice: "English_expressive_narrator",
      voice_defaulted: true,
    });
  });

  it("uses the voice a fallback route names", () => {
    const { routes } = planSpeechRoutes({
      provider: "openai",
      fallbacks: ["minimax::Vietnamese_kindhearted_girl"],
      input: input({ voice: "nova" }),
      defaultModel,
    });
    expect(routes[1]?.voice).toBe("Vietnamese_kindhearted_girl");
  });

  it("rejects an ElevenLabs-shaped voice id on MiniMax", () => {
    expect(() => planOne("minimax", undefined, { voice: "JBFqnCBsd6RMkjVDRZzb" })).toThrow(
      /not a MiniMax voice id \(it looks like an ElevenLabs voice id\)/,
    );
  });

  it.each(["../../v1/user", "abc?x=1", "a/b"])(
    "rejects ElevenLabs voice %s that would change the request path",
    (voice) => {
      expect(() => planOne("elevenlabs", undefined, { voice })).toThrow(ValidationError);
    },
  );

  it("rejects text longer than the model's documented limit instead of cutting it", () => {
    expect(() => planOne("minimax", undefined, { text: "a".repeat(10_001) })).toThrow(
      /takes at most 10000 characters per request \(got 10001\)/,
    );
    expect(() => planOne("openai", "tts-1", { text: "a".repeat(4097) })).toThrow(/at most 4096/);
    expect(() => planOne("minimax", undefined, { text: "a".repeat(10_000) })).not.toThrow();
  });

  it("rejects --voice together with --speaker", () => {
    expect(() =>
      planOne("gemini", undefined, {
        voice: "Kore",
        speakers: [
          { speaker: "Lan", voice: "Kore" },
          { speaker: "Minh", voice: "Puck" },
        ],
      }),
    ).toThrow(/--voice and --speaker cannot be combined/);
  });

  it("gives a dated snapshot its family's capabilities", () => {
    const route = planOne("openai", "gpt-4o-mini-tts-2025-12-15", { style: "warm" });
    expect(route?.model).toBe("gpt-4o-mini-tts-2025-12-15");
    expect(route?.capability.style).toBe(true);
    expect(findSpeechModel("openai", "tts-1-hd-2024")?.max_chars).toBe(4096);
    expect(findSpeechModel("openai", "gpt-5-tts")).toBeUndefined();
  });
});
