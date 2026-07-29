import { ProviderError, ValidationError } from "../../../core/errors.js";
import { type CloudflareVideoPrediction, downloadVideo, getVideoPrediction } from "../client.js";
import { saveBytes } from "../media-output.js";

export function positiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new ValidationError(`${flag} must be a positive integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new ValidationError(`${flag} must be a positive integer`);
  return parsed;
}

export function outputUrl(prediction: CloudflareVideoPrediction): string | undefined {
  if (typeof prediction.output === "string") return prediction.output;
  return prediction.output?.find((value) => typeof value === "string");
}

export async function saveCompletedVideo(
  prediction: CloudflareVideoPrediction,
  output?: string,
): Promise<string> {
  const url = outputUrl(prediction);
  if (!url)
    throw new ProviderError("Cloudflare completed the video without an output", "Cloudflare");
  const bytes = await downloadVideo(url);
  return saveBytes(bytes, `cloudflare_video_${prediction.id}.mp4`, output);
}

export async function waitForVideo(
  prediction: CloudflareVideoPrediction,
  timeoutMs: number,
  onTick?: (status: string) => void,
): Promise<CloudflareVideoPrediction> {
  const deadline = Date.now() + timeoutMs;
  let current = prediction;
  while (!isTerminalVideoStatus(current.status)) {
    if (Date.now() >= deadline)
      throw new ProviderError("Cloudflare video polling timed out", "Cloudflare");
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    current = await getVideoPrediction(current.id);
    onTick?.(current.status);
  }
  if (current.status !== "succeeded")
    throw new ProviderError("Cloudflare video generation failed", "Cloudflare");
  return current;
}

export function isTerminalVideoStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled" ||
    status === "cancelled" ||
    status === "aborted"
  );
}
