import { describe, expect, it } from "vitest";
import { resultCommand, resumeCommand } from "../../../../src/providers/fal/request-receipt.js";

describe("resultCommand", () => {
  it("fetches and downloads, quoting the model, id and extra arguments when needed", () => {
    expect(resultCommand("fal-ai/flux/schnell", "req-1")).toBe(
      "multix fal result fal-ai/flux/schnell req-1 --download",
    );
    expect(resultCommand("fal-ai/x", "req 1", ["--format", "pcm_16000"])).toBe(
      "multix fal result fal-ai/x 'req 1' --download --format pcm_16000",
    );
  });
});

describe("resumeCommand", () => {
  it("saves where the run would: its extra arguments and output directory", () => {
    expect(resumeCommand("fal-ai/x", "req-1")).toBe("multix fal result fal-ai/x req-1 --download");
    expect(
      resumeCommand("fal-ai/x", "req-1", {
        extraArgs: ["--format", "pcm_16000"],
        outputDir: "/tmp/my clips",
      }),
    ).toBe(
      "multix fal result fal-ai/x req-1 --download --format pcm_16000 --output-dir '/tmp/my clips'",
    );
  });

  it("prints the result JSON without download, whatever the model id holds", () => {
    expect(resumeCommand("fal-ai/x", "req-1", { download: false, outputDir: "/tmp/o" })).toBe(
      "multix fal result fal-ai/x req-1",
    );
    expect(resumeCommand("fal-ai/x --download y", "req-1", { download: false })).toBe(
      "multix fal result 'fal-ai/x --download y' req-1",
    );
  });
});
