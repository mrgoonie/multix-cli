import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSpeechBody,
  buildTranscriptionForm,
} from "../../../../src/providers/openai/openai-audio.js";

describe("OpenAI audio payloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds speech body with optional instructions", () => {
    expect(
      buildSpeechBody({
        text: "hello",
        model: undefined,
        voice: "marin",
        outputFormat: "mp3",
        instructions: "speak warmly",
      }),
    ).toEqual({
      model: "gpt-4o-mini-tts",
      input: "hello",
      voice: "marin",
      response_format: "mp3",
      instructions: "speak warmly",
    });
  });

  it("downloads known speaker URL refs into data URLs", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    const form = await buildTranscriptionForm({
      input: new File([new Uint8Array([4])], "meeting.mp3", { type: "audio/mpeg" }),
      cliFormat: "json",
      knownSpeakerNames: ["Alice"],
      knownSpeakerReferences: ["https://example.com/alice.mp3"],
    });

    expect(form.getAll("known_speaker_names[]")).toEqual(["Alice"]);
    expect(form.getAll("known_speaker_references[]")).toEqual(["data:audio/mpeg;base64,AQID"]);
  });
});
