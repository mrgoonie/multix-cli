import { describe, expect, it } from "vitest";
import { buildTranscriptionForm } from "../../../../src/providers/openai/openai-audio.js";

describe("OpenAI transcription validation", () => {
  it("maps text CLI output to json API format for gpt-4o-transcribe", async () => {
    const form = await buildTranscriptionForm({
      input: new File([new Uint8Array([1, 2])], "audio.mp3"),
      model: "gpt-4o-transcribe",
      cliFormat: "text",
    });
    expect(form.get("response_format")).toBe("json");
  });

  it("allows diarized_json with diarize model", async () => {
    const form = await buildTranscriptionForm({
      input: new File([new Uint8Array([1, 2])], "audio.mp3"),
      model: "gpt-4o-transcribe-diarize",
      cliFormat: "diarized_json",
      chunkingStrategy: "auto",
    });
    expect(form.get("response_format")).toBe("diarized_json");
    expect(form.get("chunking_strategy")).toBe("auto");
  });

  it("requires equal known speaker names and references", async () => {
    await expect(
      buildTranscriptionForm({
        input: new File([new Uint8Array([1, 2])], "audio.mp3"),
        model: "gpt-4o-transcribe-diarize",
        cliFormat: "json",
        knownSpeakerNames: ["A"],
        knownSpeakerReferences: [],
      }),
    ).rejects.toThrow(/equal counts/);
  });
});
