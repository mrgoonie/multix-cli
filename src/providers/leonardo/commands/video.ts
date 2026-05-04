/**
 * multix leonardo video <prompt> — text-to-video generation.
 *
 * Two endpoints:
 *   - v1 (`/generations-text-to-video`) for enum-style models (MOTION2, VEO3, ...)
 *   - v2 (`/generations`) for string-style models (kling-2.6, hailuo-2_3, ...)
 *
 * The call is async — prints the generationId and suggests `status <id>`.
 */

import path from "node:path";
import type { Command } from "commander";
import { downloadFile } from "../../../core/http-client.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { createLeonardoClient } from "../client.js";
import { LEONARDO_DEFAULTS, LEONARDO_V2_VIDEO_MODELS } from "../models.js";
import { PollFailedError, PollTimeoutError, poll } from "../poll.js";
import type {
  CreateV2GenerationResponse,
  CreateVideoResponse,
  GetGenerationResponse,
} from "../types.js";

function v2DimsFor(resolution: string): { width: number; height: number } {
  if (resolution === "RESOLUTION_1080") return { width: 1920, height: 1080 };
  if (resolution === "RESOLUTION_480") return { width: 854, height: 480 };
  return { width: 1280, height: 720 };
}

export function registerLeonardoVideoCommand(parent: Command): void {
  parent
    .command("video <prompt>")
    .description("Generate a video from a text prompt via Leonardo (text-to-video)")
    .option("--model <model>", "Video model (e.g. MOTION2, VEO3, kling-2.6)")
    .option(
      "--resolution <r>",
      "Resolution (RESOLUTION_480|RESOLUTION_720|RESOLUTION_1080)",
      "RESOLUTION_720",
    )
    .option("--enhance", "Enable prompt enhance")
    .option("--frame-interpolation", "Enable frame interpolation (v1 only)")
    .option("--wait", "Poll until COMPLETE/FAILED instead of returning the job id")
    .option("--wait-timeout <ms>", "Poll timeout in ms (with --wait)", "600000")
    .option("--download", "Download the generated video on success (implies --wait)")
    .option("--output <path>", "Output MP4 path (with --download)")
    .option("--no-thumb", "Skip downloading the thumbnail if the API returns one")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        prompt: string,
        opts: {
          model?: string;
          resolution: string;
          enhance?: boolean;
          frameInterpolation?: boolean;
          wait?: boolean;
          waitTimeout: string;
          download?: boolean;
          output?: string;
          thumb?: boolean;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? LEONARDO_DEFAULTS.videoModel;
        const client = createLeonardoClient();

        logger.info(`Submitting text-to-video (${model})`);

        let jobId: string | undefined;
        if (LEONARDO_V2_VIDEO_MODELS.has(model)) {
          const { width, height } = v2DimsFor(opts.resolution);
          const v2Res = await client.post<CreateV2GenerationResponse>(
            "v2:/generations",
            {
              public: false,
              model,
              parameters: {
                prompt,
                duration: 8,
                mode: opts.resolution,
                prompt_enhance: opts.enhance ? "ON" : "OFF",
                width,
                height,
              },
            },
            logger,
          );
          jobId = v2Res.generate.generationId;
        } else {
          const res = await client.post<CreateVideoResponse>(
            "/generations-text-to-video",
            {
              prompt,
              model,
              resolution: opts.resolution,
              promptEnhance: !!opts.enhance,
              frameInterpolation: !!opts.frameInterpolation,
            },
            logger,
          );
          jobId = res.motionVideoGenerationJob?.generationId;
        }

        if (!jobId) {
          logger.error("No generationId returned by Leonardo");
          process.exit(1);
        }

        const shouldWait = !!(opts.wait || opts.download);
        if (!shouldWait) {
          console.log(jobId);
          console.error(`Poll with: multix leonardo status ${jobId}`);
          return;
        }

        await pollAndDownload(client, jobId, {
          waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 600_000,
          download: !!opts.download,
          output: opts.output,
          thumb: opts.thumb !== false,
          logger,
          basename: "leonardo-video",
        });
      },
    );
}

interface PollAndDownloadOpts {
  waitTimeoutMs: number;
  download: boolean;
  output?: string;
  thumb: boolean;
  logger: ReturnType<typeof createLogger>;
  basename: string;
}

async function pollAndDownload(
  client: ReturnType<typeof createLeonardoClient>,
  jobId: string,
  opts: PollAndDownloadOpts,
): Promise<void> {
  const { logger } = opts;
  let res: GetGenerationResponse;
  try {
    res = await poll<GetGenerationResponse>({
      fetch: () => client.get<GetGenerationResponse>(`/generations/${jobId}`, undefined, logger),
      done: (v) => v.generations_by_pk?.status === "COMPLETE",
      failed: (v) => v.generations_by_pk?.status === "FAILED",
      intervalMs: 5000,
      maxAttempts: Math.max(1, Math.ceil(opts.waitTimeoutMs / 5000)),
      onTick: (n, v) => logger.debug(`attempt ${n} — status: ${v.generations_by_pk?.status}`),
    });
  } catch (e) {
    if (e instanceof PollTimeoutError) {
      logger.error(`Timed out — multix leonardo status ${jobId}`);
      process.exit(1);
    }
    if (e instanceof PollFailedError) {
      logger.error(`Generation failed: ${JSON.stringify(e.value)}`);
      process.exit(1);
    }
    throw e;
  }

  const gen = res.generations_by_pk;
  if (!gen) {
    logger.error("No generation in response");
    process.exit(1);
  }

  const videoUrl =
    gen.generated_images?.find(
      (img) => typeof img.url === "string" && /\.(mp4|webm|mov)(\?|$)/i.test(img.url),
    )?.url ?? (gen.generated_images?.[0] as Record<string, unknown> | undefined)?.motionMP4URL;

  if (!opts.download) {
    if (typeof videoUrl === "string") console.log(videoUrl);
    return;
  }
  if (typeof videoUrl !== "string") {
    logger.error(`No video URL in completed generation: ${JSON.stringify(gen)}`);
    process.exit(1);
  }

  const outPath =
    opts.output ?? path.join(getOutputDir(), `${opts.basename}-${jobId.slice(0, 8)}.mp4`);
  await downloadFile(videoUrl, outPath);
  logger.success(`Saved ${outPath}`);
  await maybeDownloadThumb(gen, outPath, {
    skip: !opts.thumb,
    copyTo: opts.output,
    logger,
  });
  console.log(`\nJob: ${jobId}`);
  console.log(`Saved: ${outPath}`);
}

export { pollAndDownload as _leonardoPollAndDownload };
