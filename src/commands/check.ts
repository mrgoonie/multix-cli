/**
 * multix check — diagnostics command.
 * Mirrors check_setup.py: tooling, API keys, Gemini live ping, setup hints.
 * Exit 0 if at least one provider key is configured (and Gemini ping passes when key present).
 * Exit 1 if no provider keys configured or Gemini auth fails.
 */

import type { Command } from "commander";
import { redact, resolveKey } from "../core/env-loader.js";
import { createLogger } from "../core/logger.js";
import { checkBinary } from "./check-helpers/binary-check.js";
import { pingGemini } from "./check-helpers/gemini-ping.js";
import { FFMPEG_HINT, MAGICK_HINT, SETUP_HINTS } from "./check-helpers/setup-hints.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Validate multix setup: tooling, API keys, and live Gemini connectivity")
    .option("-v, --verbose", "Verbose output")
    .action(async (opts: { verbose?: boolean }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      let exitCode = 0;

      // ── Section 1: Tooling ──────────────────────────────────────────────
      logger.header("Tooling");

      const ffmpegStatus = await checkBinary("ffmpeg");
      const magickStatus = await checkBinary("magick");

      if (ffmpegStatus.available) {
        logger.success(`ffmpeg found${ffmpegStatus.version ? ` — ${ffmpegStatus.version}` : ""}`);
      } else {
        logger.warn("ffmpeg not found");
        if (opts.verbose) console.log(`  ${FFMPEG_HINT}`);
      }

      if (magickStatus.available) {
        logger.success(`magick found${magickStatus.version ? ` — ${magickStatus.version}` : ""}`);
      } else {
        logger.warn("magick (ImageMagick) not found");
        if (opts.verbose) console.log(`  ${MAGICK_HINT}`);
      }

      // ── Section 2: API Keys ─────────────────────────────────────────────
      logger.header("API Keys");

      const geminiKey = resolveKey("GEMINI_API_KEY");
      const openrouterKey = resolveKey("OPENROUTER_API_KEY");
      const minimaxKey = resolveKey("MINIMAX_API_KEY");

      if (geminiKey) {
        logger.success(`GEMINI_API_KEY found — ${redact(geminiKey)}`);
      } else {
        logger.warn("GEMINI_API_KEY not set (Gemini analyze/transcribe/doc features unavailable)");
      }

      if (openrouterKey) {
        logger.success(`OPENROUTER_API_KEY found — ${redact(openrouterKey)}`);
      } else {
        logger.info("OPENROUTER_API_KEY not set (optional)");
      }

      if (minimaxKey) {
        logger.success(`MINIMAX_API_KEY found — ${redact(minimaxKey)}`);
      } else {
        logger.info("MINIMAX_API_KEY not set (optional)");
      }

      // Check at least one key is configured
      if (!geminiKey && !openrouterKey && !minimaxKey) {
        logger.header("No Provider Keys Configured");
        console.log(SETUP_HINTS);
        process.exit(1);
      }

      // ── Section 3: Gemini Live Ping ─────────────────────────────────────
      if (geminiKey) {
        logger.header("Gemini Connectivity");
        logger.info("Pinging Gemini models endpoint...");

        const ping = await pingGemini(geminiKey);

        if (ping.status === "success") {
          logger.success(`Gemini API reachable — ${ping.modelCount ?? 0} models available`);
        } else if (ping.status === "auth_error") {
          logger.error(`Gemini auth failed — check GEMINI_API_KEY: ${ping.error ?? ""}`);
          exitCode = 1;
        } else {
          logger.warn(`Gemini network error (API may be down): ${ping.error ?? ""}`);
          // Don't set exitCode — transient
        }
      }

      // ── Summary ─────────────────────────────────────────────────────────
      logger.header("Summary");

      if (exitCode === 0) {
        logger.success("multix is ready to use");
        if (geminiKey) {
          console.log(
            "  Full Gemini multimodal setup (analyze, transcribe, generate, doc convert)",
          );
        } else {
          console.log("  Image generation via OpenRouter/MiniMax available");
          console.log("  Add GEMINI_API_KEY for analysis, transcription, and doc conversion");
        }
      } else {
        logger.error("One or more checks failed — see above");
      }

      process.exit(exitCode);
    });
}
