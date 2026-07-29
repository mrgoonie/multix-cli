import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../dist/cli.js");

const env = {
  ...process.env,
  GEMINI_API_KEY: "test-key",
  MULTIX_DISABLE_HOME_ENV: "1",
};

describe("Gemini video model validation", () => {
  it("rejects Gemini text models for generate-video before submitting", async () => {
    const result = await execa(
      "node",
      [CLI, "gemini", "generate-video", "--prompt", "waves", "--model", "gemini-3.5-flash"],
      { env, reject: false },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Video generation requires a Veo model");
  });

  it("rejects Gemini text models for image-to-video before reading the image", async () => {
    const result = await execa(
      "node",
      [
        CLI,
        "gemini",
        "image-to-video",
        "missing.jpg",
        "--prompt",
        "camera pans left",
        "--model",
        "gemini-3.5-flash",
      ],
      { env, reject: false },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Image-to-video requires a Veo model");
  });
});
