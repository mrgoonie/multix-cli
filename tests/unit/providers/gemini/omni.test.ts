import { describe, expect, it } from "vitest";
import { ValidationError } from "../../../../src/core/errors.js";
import {
  base64DecodedBytes,
  buildOmniRequest,
  estimateOmniCost,
  extractOmniText,
  extractOmniVideo,
  followUpPrompt,
  interactionFailureMessage,
  isTerminalInteraction,
  parseOmniDuration,
  summarizeInteraction,
  validateOmniFormat,
} from "../../../../src/providers/gemini/omni.js";

const MODEL = "gemini-omni-1.1-flash";
const GEMINI_URI =
  "https://generativelanguage.googleapis.com/v1beta/files/vid123:download?alt=media";

describe("buildOmniRequest", () => {
  it("sends a plain string input and a stored background request when there is no media", () => {
    const body = buildOmniRequest({
      model: MODEL,
      prompt: "a cat on a roof",
      aspectRatio: "9:16",
      resolution: "1080p",
      durationSeconds: 5,
    });
    expect(body).toEqual({
      model: MODEL,
      input: "a cat on a roof",
      response_format: {
        type: "video",
        delivery: "uri",
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration: "5s",
      },
      store: true,
      background: true,
    });
    expect(body).not.toHaveProperty("previous_interaction_id");
    expect(body).not.toHaveProperty("generation_config");
  });

  it("sends media parts before the text prompt, in the order given", () => {
    const media = [
      { type: "image" as const, data: "AAAA", mime_type: "image/png" },
      {
        type: "image" as const,
        uri: "https://generativelanguage.googleapis.com/v1beta/files/f1",
        mime_type: "image/jpeg",
      },
    ];
    const body = buildOmniRequest({ model: MODEL, prompt: "walk forward", media });
    expect(body.input).toEqual([...media, { type: "text", text: "walk forward" }]);
  });

  it("omits duration and format keys that were not set", () => {
    const body = buildOmniRequest({ model: MODEL, prompt: "x" });
    expect(body.response_format).toEqual({ type: "video", delivery: "uri" });
  });

  it("sends store false as a synchronous request (background false)", () => {
    const body = buildOmniRequest({ model: MODEL, prompt: "x", store: false });
    expect(body.store).toBe(false);
    expect(body.background).toBe(false);
  });

  it("sends the video task on a first turn", () => {
    const body = buildOmniRequest({ model: MODEL, prompt: "dance", task: "text_to_video" });
    expect(body.generation_config).toEqual({ video_config: { task: "text_to_video" } });
    expect(body).not.toHaveProperty("previous_interaction_id");
  });

  it("sends previous_interaction_id for a follow-up and drops the task the API rejects beside it", () => {
    const body = buildOmniRequest({
      model: MODEL,
      prompt: "make it night",
      previousInteractionId: "v1_parent",
      task: "edit",
      durationSeconds: 3,
    });
    expect(body.previous_interaction_id).toBe("v1_parent");
    expect(body).not.toHaveProperty("generation_config");
    expect(body.response_format).toMatchObject({ duration: "3s" });
  });

  it("puts the edit or extend intent in a follow-up prompt, since the task cannot be sent", () => {
    const extend = buildOmniRequest({
      model: MODEL,
      prompt: "the ball turns blue",
      previousInteractionId: "v1_parent",
      task: "extend",
    });
    expect(extend.input).toBe("Extend this video: the ball turns blue");
    const edit = buildOmniRequest({
      model: MODEL,
      prompt: "the ball falls off the table",
      previousInteractionId: "v1_parent",
      task: "edit",
      media: [{ type: "image", data: "AAAA", mime_type: "image/png" }],
    });
    expect(edit.input).toEqual([
      { type: "image", data: "AAAA", mime_type: "image/png" },
      { type: "text", text: "Edit this video: the ball falls off the table" },
    ]);
  });

  it("keeps a first-turn prompt as given, since the task travels in generation_config", () => {
    const body = buildOmniRequest({ model: MODEL, prompt: "continue", task: "extend" });
    expect(body.input).toBe("continue");
    expect(body.generation_config).toEqual({ video_config: { task: "extend" } });
  });

  it("strips a models/ prefix from the model id", () => {
    expect(buildOmniRequest({ model: `models/${MODEL}`, prompt: "x" }).model).toBe(MODEL);
  });

  it("defaults delivery to uri for a stored request and inline for an unstored one", () => {
    const stored = buildOmniRequest({ model: MODEL, prompt: "x" });
    expect(stored.response_format).toMatchObject({ delivery: "uri" });
    const unstored = buildOmniRequest({ model: MODEL, prompt: "x", store: false });
    expect(unstored.response_format).toMatchObject({ delivery: "inline" });
  });

  it("sends an explicit delivery mode even when it differs from the store default", () => {
    const body = buildOmniRequest({ model: MODEL, prompt: "x", delivery: "inline" });
    expect(body.response_format).toMatchObject({ delivery: "inline" });
    const unstoredUri = buildOmniRequest({
      model: MODEL,
      prompt: "x",
      store: false,
      delivery: "uri",
    });
    expect(unstoredUri.response_format).toMatchObject({ delivery: "uri" });
  });

  it("validates the format before building anything", () => {
    expect(() => buildOmniRequest({ model: MODEL, prompt: "x", durationSeconds: 11 })).toThrow(
      ValidationError,
    );
  });
});

describe("validateOmniFormat", () => {
  it("accepts every documented aspect ratio, resolution and duration bound", () => {
    for (const aspectRatio of ["16:9", "9:16"]) {
      expect(() => validateOmniFormat({ aspectRatio })).not.toThrow();
    }
    for (const resolution of ["360p", "720p", "1080p", "4k"]) {
      expect(() => validateOmniFormat({ resolution })).not.toThrow();
    }
    expect(() => validateOmniFormat({ durationSeconds: 3 })).not.toThrow();
    expect(() => validateOmniFormat({ durationSeconds: 10 })).not.toThrow();
    expect(() => validateOmniFormat({})).not.toThrow();
  });

  it("rejects durations outside 3-10 seconds and non-integers", () => {
    for (const durationSeconds of [0, 2, 11, 3.5, 10.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateOmniFormat({ durationSeconds })).toThrow(ValidationError);
    }
  });

  it("rejects unknown aspect ratios and resolutions with the supported values listed", () => {
    expect(() => validateOmniFormat({ aspectRatio: "4:3" })).toThrow(/16:9 or 9:16/);
    expect(() => validateOmniFormat({ resolution: "1440p" })).toThrow(/360p, 720p, 1080p, 4k/);
    // Case is normalised by the CLI (omniFormat), not by the validator.
    expect(() => validateOmniFormat({ resolution: "4K" })).toThrow(ValidationError);
  });
});

describe("parseOmniDuration", () => {
  it("returns undefined when no duration is given", () => {
    expect(parseOmniDuration(undefined)).toBeUndefined();
  });

  it("parses whole seconds with or without an s suffix", () => {
    expect(parseOmniDuration("5")).toBe(5);
    expect(parseOmniDuration("5s")).toBe(5);
    expect(parseOmniDuration(" 7S ")).toBe(7);
    expect(parseOmniDuration("3")).toBe(3);
    expect(parseOmniDuration("10s")).toBe(10);
  });

  it("rejects values outside the bounds or not made of digits", () => {
    for (const bad of ["2", "11", "11s", "2.5", "1e1", "abc", "", "-3", "5 seconds"]) {
      expect(() => parseOmniDuration(bad), `input ${JSON.stringify(bad)}`).toThrow(ValidationError);
    }
  });
});

describe("extractOmniVideo", () => {
  it("returns the video of the model_output step", () => {
    const resp = {
      steps: [
        {
          type: "model_output",
          content: [{ type: "video", mime_type: "video/mp4", uri: GEMINI_URI }],
        },
      ],
    };
    expect(extractOmniVideo(resp)).toEqual({ mimeType: "video/mp4", uri: GEMINI_URI });
  });

  it("skips user_input steps, so an uploaded source clip is never taken for the result", () => {
    const resp = {
      steps: [
        {
          type: "user_input",
          content: [
            {
              type: "video",
              mime_type: "video/mp4",
              uri: "https://generativelanguage.googleapis.com/v1beta/files/source",
            },
          ],
        },
        {
          type: "model_output",
          content: [{ type: "video", mime_type: "video/mp4", uri: GEMINI_URI }],
        },
      ],
    };
    expect(extractOmniVideo(resp)?.uri).toBe(GEMINI_URI);
  });

  it("returns null when only input steps carry a video", () => {
    const resp = {
      steps: [{ type: "user_input", content: [{ type: "video", uri: GEMINI_URI }] }],
    };
    expect(extractOmniVideo(resp)).toBeNull();
  });

  it("returns inline base64 data with its mime type", () => {
    const resp = {
      steps: [
        {
          type: "model_output",
          content: [{ type: "video", mime_type: "video/webm", data: "QUJD" }],
        },
      ],
    };
    expect(extractOmniVideo(resp)).toEqual({ mimeType: "video/webm", data: "QUJD" });
  });

  it("defaults the mime type to video/mp4 when the part omits it", () => {
    const resp = {
      steps: [{ type: "model_output", content: [{ type: "video", uri: GEMINI_URI }] }],
    };
    expect(extractOmniVideo(resp)?.mimeType).toBe("video/mp4");
  });

  it("returns null for missing, malformed or empty steps and for empty URIs", () => {
    expect(extractOmniVideo(null)).toBeNull();
    expect(extractOmniVideo({})).toBeNull();
    expect(extractOmniVideo({ steps: "nope" })).toBeNull();
    expect(
      extractOmniVideo({
        steps: [{ type: "model_output", content: [{ type: "video", uri: "" }] }],
      }),
    ).toBeNull();
    expect(extractOmniVideo({ steps: [{ type: "model_output", content: "text" }] })).toBeNull();
  });
});

describe("extractOmniText", () => {
  it("returns model text only, not user or thought text", () => {
    const resp = {
      steps: [
        { type: "user_input", content: [{ type: "text", text: "my prompt" }] },
        { type: "thought", content: [{ type: "text", text: "private reasoning" }] },
        { type: "model_output", content: [{ type: "text", text: "I cannot make that video." }] },
      ],
    };
    expect(extractOmniText(resp)).toBe("I cannot make that video.");
  });
});

describe("summarizeInteraction", () => {
  const completed = {
    id: "v1_abc123",
    status: "completed",
    model: MODEL,
    created: "2026-10-20T10:00:00Z",
    updated: "2026-10-20T10:01:00Z",
    previous_interaction_id: "v1_parent",
    steps: [
      { type: "user_input", content: [{ type: "text", text: "prompt" }] },
      {
        type: "thought",
        content: [{ type: "thought_signature", signature: "SIG_SECRET_VALUE" }],
      },
      {
        type: "model_output",
        content: [{ type: "video", mime_type: "video/mp4", uri: GEMINI_URI }],
      },
    ],
    usage: {
      total_input_tokens: 1000,
      total_output_tokens: 2000,
      total_thought_tokens: 0,
      output_tokens_by_modality: [{ modality: "video", tokens: 2000 }],
    },
  };

  it("keeps identifiers, usage and a cost estimate, and never the URI, bytes or thought signature", () => {
    const summary = summarizeInteraction(completed);
    const text = JSON.stringify(summary);
    expect(text).not.toContain("generativelanguage");
    expect(text).not.toContain("alt=media");
    expect(text).not.toContain("SIG_SECRET_VALUE");
    expect(text).not.toContain("thought_signature");
    expect(summary).toMatchObject({
      interaction_id: "v1_abc123",
      status: "completed",
      model: MODEL,
      parent_interaction_id: "v1_parent",
      video: { mime_type: "video/mp4", delivery: "uri", media_file: "files/vid123" },
      usage: completed.usage,
    });
    expect(summary.cost_estimate).toMatchObject({ usd: expect.any(Number) });
  });

  it("reports inline video by decoded size instead of the data itself", () => {
    const summary = summarizeInteraction({
      id: "v1_inline",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "video", mime_type: "video/mp4", data: "QUJDRA==" }],
        },
      ],
    });
    expect(summary.video).toEqual({ mime_type: "video/mp4", delivery: "inline", bytes: 4 });
    expect(JSON.stringify(summary)).not.toContain("QUJDRA==");
  });

  it("names a non-Files-API URI as external without echoing it", () => {
    const summary = summarizeInteraction({
      id: "v1_ext",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            { type: "video", uri: "https://storage.example.com/clip.mp4?X-Signature=secret" },
          ],
        },
      ],
    });
    expect(summary.video).toEqual({
      mime_type: "video/mp4",
      delivery: "uri",
      media_file: "(external)",
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("storage.example.com");
  });

  it("omits the video for an interaction still running and includes errors", () => {
    const running = summarizeInteraction({ id: "v1_run", status: "in_progress", steps: [] });
    expect(running).not.toHaveProperty("video");
    expect(running).not.toHaveProperty("cost_estimate");

    const failed = summarizeInteraction({
      id: "v1_fail",
      status: "failed",
      error: { message: "content blocked", code: 400 },
    });
    expect(failed.error).toEqual({ message: "content blocked", code: 400 });
  });

  it("truncates long model text to 2000 characters", () => {
    const summary = summarizeInteraction({
      id: "v1_text",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "x".repeat(5000) }] }],
    });
    expect(String(summary.text)).toHaveLength(2000);
  });
});

describe("estimateOmniCost", () => {
  const M = 1_000_000;

  it("prices input at 1.5, video output at 17.5 and text plus thought output at 9 per million tokens", () => {
    // 1M input (1.5) + 1M video (17.5) = 19.
    expect(
      estimateOmniCost({
        total_input_tokens: M,
        total_output_tokens: M,
        output_tokens_by_modality: [{ modality: "video", tokens: M }],
      })?.usd,
    ).toBe(19);
  });

  it("counts non-video output and thought tokens as text output", () => {
    // input 1.5 + video 17.5 + text output 1M (9) + thought 1M (9) = 37.
    const est = estimateOmniCost({
      total_input_tokens: M,
      total_output_tokens: 2 * M,
      total_thought_tokens: M,
      output_tokens_by_modality: [{ modality: "video", tokens: M }],
    });
    expect(est?.usd).toBe(37);
    expect(est?.basis).toMatch(/estimate/);
  });

  it("does not go negative when reported video tokens exceed total output", () => {
    expect(
      estimateOmniCost({
        total_output_tokens: M,
        output_tokens_by_modality: [{ modality: "video", tokens: 2 * M }],
      })?.usd,
    ).toBe(35);
  });

  it("returns null when usage is missing or all zero", () => {
    expect(estimateOmniCost(undefined)).toBeNull();
    expect(estimateOmniCost({})).toBeNull();
    expect(estimateOmniCost({ total_input_tokens: 0, total_output_tokens: 0 })).toBeNull();
  });
});

describe("isTerminalInteraction", () => {
  it("is true only for statuses after which the interaction never changes", () => {
    for (const status of ["completed", "failed", "cancelled", "incomplete"]) {
      expect(isTerminalInteraction(status), status).toBe(true);
    }
    for (const status of ["in_progress", "queued", "", undefined]) {
      expect(isTerminalInteraction(status), String(status)).toBe(false);
    }
  });
});

describe("base64DecodedBytes", () => {
  it("computes the decoded length from padding without decoding", () => {
    expect(base64DecodedBytes("")).toBe(0);
    expect(base64DecodedBytes("QQ==")).toBe(1);
    expect(base64DecodedBytes("QUI=")).toBe(2);
    expect(base64DecodedBytes("QUJD")).toBe(3);
    expect(base64DecodedBytes("QUJDRA==")).toBe(4);
  });
});

describe("interactionFailureMessage", () => {
  it("names the id, status and error message on one line", () => {
    expect(
      interactionFailureMessage({
        id: "v1_x",
        status: "failed",
        error: { message: "quota\n exceeded" },
      }),
    ).toBe("Gemini Omni interaction v1_x failed: quota exceeded");
  });

  it("falls back to the model's text when there is no error message", () => {
    expect(
      interactionFailureMessage({
        id: "v1_y",
        status: "incomplete",
        steps: [{ type: "model_output", content: [{ type: "text", text: "Blocked by policy." }] }],
      }),
    ).toBe("Gemini Omni interaction v1_y incomplete: Blocked by policy.");
  });
});

describe("followUpPrompt", () => {
  it("prefixes edit and extend prompts", () => {
    expect(followUpPrompt("  make it night", "edit")).toBe("Edit this video: make it night");
    expect(followUpPrompt("pan out", "extend")).toBe("Extend this video: pan out");
  });

  it("does not repeat an intent the prompt already states", () => {
    expect(followUpPrompt("Extend this video: pan out", "extend")).toBe(
      "Extend this video: pan out",
    );
    expect(followUpPrompt("extend this video by panning out", "extend")).toBe(
      "extend this video by panning out",
    );
    expect(followUpPrompt("EDIT THIS VIDEO: night", "edit")).toBe("EDIT THIS VIDEO: night");
    // An explicit intent is the user's call, even on the other command.
    expect(followUpPrompt("Extend this video: x", "edit")).toBe("Extend this video: x");
    expect(followUpPrompt("Edit this videogame scene", "edit")).toBe(
      "Edit this video: Edit this videogame scene",
    );
  });

  it("leaves the prompt alone without an edit or extend task", () => {
    expect(followUpPrompt("pan out", undefined)).toBe("pan out");
    expect(followUpPrompt("pan out", "text_to_video")).toBe("pan out");
  });
});
