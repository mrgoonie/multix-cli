/**
 * multix sume image [prompt]  — text-to-image or image edit (--image)
 * multix sume video [prompt]  — text/image/reference-to-video, video-to-video, lipsync
 *
 * The model's catalog entry decides which flags it takes; nothing is sent
 * until the request checks out against it. Local media is uploaded first
 * through Sume's pre-signed upload URLs.
 */

import type { Command } from "commander";
import { untrackedFetch } from "../../../agent/fetch-telemetry.js";
import { mapMediaRefs } from "../request.js";
import type { SumeRouter } from "../types.js";
import { createSumeClientFromEnv, createSumeLogger, resolveSumeMedia } from "./env.js";
import {
  NOTHING_SUBMITTED,
  type SumeRunOpts,
  addSumeRunOptions,
  exitOnInterrupt,
  submitSumeJob,
} from "./job-runner.js";
import {
  type SumeImageCliOpts,
  type SumeVideoCliOpts,
  addImageRequestOptions,
  addVideoRequestOptions,
  planRequest,
} from "./request-options.js";

const IMAGE_WAIT_MS = 300_000;
const VIDEO_WAIT_MS = 1_200_000;

async function runGenerate(
  router: SumeRouter,
  prompt: string | undefined,
  opts: (SumeImageCliOpts | SumeVideoCliOpts) & SumeRunOpts,
  defaultWaitTimeoutMs: number,
): Promise<void> {
  const logger = createSumeLogger({
    verbose: opts.verbose,
    stdoutReserved: opts.async || opts.download === false,
  });
  const client = createSumeClientFromEnv();
  // The catalog read is a free lookup, not part of the paid request.
  const { body } = await planRequest(router, prompt, opts, untrackedFetch());
  const resolved = await exitOnInterrupt(
    () => mapMediaRefs(body, (ref) => resolveSumeMedia(client, ref, logger)),
    {
      message: "Stopped while uploading inputs; no Sume job was submitted.",
      outcome: NOTHING_SUBMITTED,
    },
  );
  await submitSumeJob({ client, logger, router, body: resolved, opts, defaultWaitTimeoutMs });
}

export function registerSumeGenerateCommands(parent: Command): void {
  const image = parent
    .command("image [prompt]")
    .description(
      "Generate or edit images with a Sume catalog model (async job; downloads the result)",
    );
  addImageRequestOptions(image);
  addSumeRunOptions(image, { waitTimeoutMs: IMAGE_WAIT_MS, images: true }).action(
    async (prompt: string | undefined, opts: SumeImageCliOpts & SumeRunOpts) => {
      await runGenerate("image", prompt, opts, IMAGE_WAIT_MS);
    },
  );

  const video = parent
    .command("video [prompt]")
    .description(
      "Generate a video with a Sume catalog model: text, image, references, video-to-video or lipsync",
    );
  addVideoRequestOptions(video);
  addSumeRunOptions(video, { waitTimeoutMs: VIDEO_WAIT_MS }).action(
    async (prompt: string | undefined, opts: SumeVideoCliOpts & SumeRunOpts) => {
      await runGenerate("video", prompt, opts, VIDEO_WAIT_MS);
    },
  );
}
