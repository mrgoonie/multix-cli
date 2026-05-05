/**
 * multix byteplus generate-3d — Hyper3D / Hitem3d 3D generation (async).
 * Default flow: submit task, poll until terminal, download the resulting
 * model file (.glb / .zip / etc.) on success.
 */

import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { PollFailedError, PollTimeoutError } from "../../leonardo/poll.js";
import { createBytePlusClient } from "../client.js";
import {
  buildThreeDTaskBody,
  downloadModelFile,
  inferModelFileExt,
  submitThreeDTask,
  waitForThreeDTask,
} from "../generators/three-d.js";
import { resolveImageInput } from "../image-input.js";
import { BYTEPLUS_3D_MODELS, BYTEPLUS_DEFAULTS } from "../models.js";

export function registerBytePlusGenerate3DCommand(parent: Command): void {
  parent
    .command("generate-3d")
    .alias("3d")
    .description(
      `Generate a 3D model via BytePlus (Hyper3D / Hitem3d). Models: ${BYTEPLUS_3D_MODELS.map((m) => m.id).join(", ")}`,
    )
    .option("--prompt <text>", "Text prompt (text-to-3D or to guide image-to-3D)")
    .option(
      "-m, --model <id>",
      `Model id (default ${BYTEPLUS_DEFAULTS.threeDModel})`,
      BYTEPLUS_DEFAULTS.threeDModel,
    )
    .option("--input-image <path|url...>", "1–5 reference images for image-to-3D (path or URL)")
    .option(
      "--flags <raw>",
      "Raw flags appended to the prompt (e.g. '--mesh_mode Raw --hd_texture true' for Hyper3D, '--ff 2 --resolution 1536pro' for Hitem3d)",
    )
    .option("--seed <n>", "Fixed seed")
    .option("--async", "Submit task and exit; print taskId only")
    .option("--wait-timeout <ms>", "Poll timeout in ms", "900000")
    .option("--output <path>", "Output file path (extension auto-detected from URL if omitted)")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt?: string;
        model: string;
        inputImage?: string[];
        flags?: string;
        seed?: string;
        async?: boolean;
        waitTimeout: string;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const client = createBytePlusClient();

        const images = opts.inputImage ?? [];
        if (images.length > 5) {
          logger.error("BytePlus 3D supports at most 5 reference images.");
          process.exit(1);
        }
        const imageInputs = await Promise.all(images.map((src) => resolveImageInput(src, logger)));

        if (!opts.prompt && imageInputs.length === 0) {
          logger.error("Provide --prompt and/or --input-image to describe the 3D content.");
          process.exit(1);
        }

        const body = buildThreeDTaskBody({
          model: opts.model,
          prompt: opts.prompt,
          flags: opts.flags,
          seed: opts.seed ? Number.parseInt(opts.seed, 10) : undefined,
          imageInputs,
        });

        logger.info(
          `Submitting 3D task (${opts.model}${imageInputs.length > 0 ? `, ${imageInputs.length} image ref${imageInputs.length === 1 ? "" : "s"}` : ""})`,
        );
        const submitted = await submitThreeDTask(client, body, logger);
        const taskId = submitted.id;
        logger.debug(`taskId: ${taskId}`);

        if (opts.async) {
          console.log(taskId);
          console.error(`Poll with: multix byteplus status ${taskId} --wait --download`);
          return;
        }

        try {
          const final = await waitForThreeDTask(client, taskId, {
            waitTimeoutMs: Number.parseInt(opts.waitTimeout, 10) || 900_000,
            logger,
          });
          const url = final.content?.file_url;
          if (!url) {
            logger.error(`Task succeeded but no file_url in response: ${JSON.stringify(final)}`);
            process.exit(1);
          }
          const ext = inferModelFileExt(url);
          const outPath =
            opts.output ??
            path.join(getOutputDir(), `byteplus-3d-${taskId.slice(0, 8)}-${Date.now()}.${ext}`);
          await downloadModelFile(url, outPath, logger);
          console.log(`\nTask: ${taskId}`);
          console.log(`Saved: ${outPath}`);
        } catch (e) {
          if (e instanceof PollTimeoutError) {
            logger.error(
              `Polling timed out — keep the task and check later: multix byteplus status ${taskId} --wait --download`,
            );
            process.exit(1);
          }
          if (e instanceof PollFailedError) {
            logger.error(`Task failed: ${JSON.stringify(e.value)}`);
            process.exit(1);
          }
          throw e;
        }
      },
    );
}
