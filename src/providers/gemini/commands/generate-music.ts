/**
 * multix gemini generate-music — music with Google Lyria over the Interactions API.
 * lyria-3-clip-preview (default): a 30-second MP3 clip. lyria-3.5: a full song
 * (about a couple of minutes, steered by the prompt) as MP3 or WAV, with up to
 * 10 reference images. Both take lyrics (with [Verse]/[Chorus] tags) and need a
 * paid-tier (billing-enabled) Gemini API key.
 *
 * The request is stored and runs in the background: its id is printed and
 * saved before polling, so `multix gemini music-status <id> --download`
 * resumes a timed-out or interrupted run without paying for another song.
 *
 * multix gemini music-status <interactionId> — inspect or resume one. Prints a
 * JSON summary (no audio bytes); --wait polls to a terminal status;
 * --download saves the audio. stdout carries only the result.
 */

import path from "node:path";
import type { Command } from "commander";
import { nameJob } from "../../../agent/run-state.js";
import { ProviderJobFailedError, ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { outputStamp } from "../../../core/output-name.js";
import {
  LYRIA_DEFAULT_WAIT_MS,
  musicResumeCommand,
  readLyricsFile,
  runLyriaMusic,
  saveLyriaAudio,
} from "../lyria-flow.js";
import {
  LYRIA_FORMATS,
  LYRIA_MODELS,
  LYRIA_MODEL_DEFAULT,
  type LyriaFormat,
  lyriaFailureMessage,
  summarizeLyriaInteraction,
  validateLyriaRequest,
} from "../lyria.js";
import { copyToOutput, findInteractionKey, waitForInteraction } from "../omni-flow.js";
import { type Interaction, isTerminalInteraction } from "../omni.js";
import { parseWaitTimeout } from "./video-shared.js";

interface GenerateMusicOpts {
  prompt: string;
  model: string;
  lyrics?: string;
  lyricsFile?: string;
  image?: string[];
  outputFormat?: string;
  output?: string;
  wait?: boolean;
  waitTimeout: string;
  verbose?: boolean;
}

/**
 * The format to request: --output-format, else the --output extension when it
 * is .mp3 or .wav. A conflicting pair is refused before anything is billed.
 */
export function resolveMusicFormat(
  outputFormat: string | undefined,
  output: string | undefined,
): LyriaFormat | undefined {
  const ext = output ? path.extname(output).slice(1).toLowerCase() : "";
  const fromOutput = (LYRIA_FORMATS as readonly string[]).includes(ext)
    ? (ext as LyriaFormat)
    : undefined;
  if (outputFormat === undefined) return fromOutput;
  const format = outputFormat.trim().toLowerCase();
  if (!(LYRIA_FORMATS as readonly string[]).includes(format)) {
    throw new ValidationError(
      `--output-format must be ${LYRIA_FORMATS.join(" or ")} (got '${outputFormat}')`,
    );
  }
  if (fromOutput && fromOutput !== format) {
    throw new ValidationError(
      `--output ${output} does not match --output-format ${format}; use a .${format} file name`,
    );
  }
  return format as LyriaFormat;
}

const DEFAULT_WAIT = String(LYRIA_DEFAULT_WAIT_MS);

export function registerGeminiGenerateMusicCommands(parent: Command): void {
  parent
    .command("generate-music")
    .description(
      "Generate music with Google Lyria: 30 s clips (lyria-3-clip-preview) or full songs (lyria-3.5)",
    )
    .requiredOption("--prompt <text>", "Genre, mood, instruments, structure, tempo")
    .option(
      "--model <id>",
      `Lyria model: ${Object.keys(LYRIA_MODELS).join(" | ")}`,
      LYRIA_MODEL_DEFAULT,
    )
    .option("--lyrics <text>", "Lyrics to sing; [Verse]/[Chorus]/[Bridge] tags mark sections")
    .option("--lyrics-file <path>", "Read the lyrics from a UTF-8 text file")
    .option("--image <paths...>", "Reference images that set the mood (lyria-3.5 only, up to 10)")
    .option(
      "--output-format <fmt>",
      "mp3 (default) or wav (lyria-3.5 only); inferred from a .mp3/.wav --output",
    )
    .option("--output <path>", "Copy the generated audio to this path")
    .option("--no-wait", "Submit, print the interaction id and exit (resume with music-status)")
    .option("--wait-timeout <ms>", "How long to wait for the song", DEFAULT_WAIT)
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: GenerateMusicOpts) => {
      // With --no-wait, stdout carries only the JSON result.
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: opts.wait === false });
      if (opts.lyrics !== undefined && opts.lyricsFile !== undefined) {
        throw new ValidationError("Use --lyrics or --lyrics-file, not both");
      }
      if (opts.wait === false && opts.output !== undefined) {
        throw new ValidationError(
          "--output needs the finished song; with --no-wait pass it to `music-status <id> --download` instead",
        );
      }
      const format = resolveMusicFormat(opts.outputFormat, opts.output);
      // Checked before the lyrics file or images are read.
      validateLyriaRequest({
        model: opts.model,
        prompt: opts.prompt,
        format,
        imageCount: opts.image?.length,
      });
      const lyrics = opts.lyricsFile ? readLyricsFile(opts.lyricsFile) : opts.lyrics;
      const result = await runLyriaMusic({
        request: {
          model: opts.model,
          prompt: opts.prompt,
          ...(lyrics !== undefined ? { lyrics } : {}),
          ...(format ? { format } : {}),
        },
        imagePaths: opts.image,
        wait: opts.wait !== false,
        waitTimeoutMs: parseWaitTimeout(opts.waitTimeout),
        output: opts.output,
        logger,
      });
      if (result.dest) {
        console.log(`\nGenerated music: ${result.dest}`);
        if (result.lyricsPath) console.log(`Lyrics: ${result.lyricsPath}`);
        console.log(`Interaction ID: ${result.interactionId}`);
        return;
      }
      console.log(
        JSON.stringify(
          {
            interaction_id: result.interactionId,
            status: "in_progress",
            session: result.recordPath,
          },
          null,
          2,
        ),
      );
    });

  parent
    .command("music-status <interactionId>")
    .description("Get a Gemini Lyria music interaction's status; --wait/--download to resume it")
    .option("--wait", "Poll until the interaction reaches a terminal status")
    .option("--download", "Save the audio once completed")
    .option("--output <path>", "Copy the saved audio to this path")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", DEFAULT_WAIT)
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (
        interactionId: string,
        opts: {
          wait?: boolean;
          download?: boolean;
          output?: string;
          waitTimeout: string;
          verbose?: boolean;
        },
      ) => {
        const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
        const waitTimeoutMs = parseWaitTimeout(opts.waitTimeout);
        // Name the job read here, so a failed read still joins its operation.
        nameJob(interactionId);
        const found = await findInteractionKey(interactionId, logger, {
          resume: musicResumeCommand,
        });
        let interaction: Interaction = found.interaction;
        const id = String(interaction.id ?? interactionId);
        const model = interaction.model?.replace(/^models\//, "");
        if (model && !Object.hasOwn(LYRIA_MODELS, model)) {
          throw new ValidationError(
            `Interaction ${id} is a ${interaction.model} interaction, not Lyria music`,
          );
        }

        if ((opts.wait || opts.download) && !isTerminalInteraction(interaction.status)) {
          interaction = await waitForInteraction(
            id,
            found.apiKey,
            waitTimeoutMs,
            logger,
            undefined,
            musicResumeCommand,
          );
        }

        if (interaction.status === "completed" && opts.download) {
          const saved = saveLyriaAudio(
            interaction,
            path.join(getOutputDir(), `gemini_lyria_${outputStamp()}`),
          );
          logger.success(`Saved music: ${saved.dest}`);
          if (saved.lyricsPath) logger.info(`Lyrics and structure: ${saved.lyricsPath}`);
          copyToOutput(saved.dest, opts.output, logger);
          console.log(saved.dest);
          return;
        }

        console.log(JSON.stringify(summarizeLyriaInteraction(interaction), null, 2));
        if (!isTerminalInteraction(interaction.status)) {
          logger.info(`Still running. Resume with: ${musicResumeCommand(id)}`);
        } else if (interaction.status !== "completed") {
          throw new ProviderJobFailedError(lyriaFailureMessage(interaction), "gemini", {
            terminal: interaction.status !== "cancelled",
          });
        }
      },
    );
}
