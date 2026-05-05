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

interface ProviderEntry {
  name: string;
  envPrimary: string;
  envFallback?: string;
  optional: boolean;
  link: string;
}

const PROVIDERS: ProviderEntry[] = [
  {
    name: "Gemini",
    envPrimary: "GEMINI_API_KEY",
    optional: false,
    link: "https://aistudio.google.com/apikey",
  },
  {
    name: "OpenRouter",
    envPrimary: "OPENROUTER_API_KEY",
    optional: true,
    link: "https://openrouter.ai/settings/keys",
  },
  {
    name: "MiniMax",
    envPrimary: "MINIMAX_API_KEY",
    optional: true,
    link: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    name: "Leonardo.Ai",
    envPrimary: "LEONARDO_API_KEY",
    optional: true,
    link: "https://app.leonardo.ai/settings/api-keys",
  },
  {
    name: "BytePlus",
    envPrimary: "BYTEPLUS_API_KEY",
    envFallback: "ARK_API_KEY",
    optional: true,
    link: "https://console.byteplus.com/auth/api-keys",
  },
  {
    name: "ElevenLabs",
    envPrimary: "ELEVENLABS_API_KEY",
    optional: true,
    link: "https://elevenlabs.io/app/settings/api-keys",
  },
];

function resolveProviderKey(p: ProviderEntry): { key?: string; envUsed?: string } {
  const primary = resolveKey(p.envPrimary);
  if (primary) return { key: primary, envUsed: p.envPrimary };
  if (p.envFallback) {
    const fb = resolveKey(p.envFallback);
    if (fb) return { key: fb, envUsed: p.envFallback };
  }
  return {};
}

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

      let anyKey = false;
      const resolved = new Map<string, { key?: string; envUsed?: string }>();
      for (const p of PROVIDERS) {
        const r = resolveProviderKey(p);
        resolved.set(p.name, r);
        if (r.key) anyKey = true;
        const envLabel = r.envUsed ?? p.envPrimary;
        if (r.key) {
          logger.success(`${envLabel} found — ${redact(r.key)}`);
        } else if (p.optional) {
          const fbNote = p.envFallback ? ` (or ${p.envFallback})` : "";
          logger.info(`${p.envPrimary}${fbNote} not set (optional)`);
        } else {
          logger.warn(`${p.envPrimary} not set (${p.name} features unavailable)`);
        }
      }

      if (!anyKey) {
        logger.header("No Provider Keys Configured");
        console.log(SETUP_HINTS);
        process.exit(1);
      }

      // ── Section 3: Gemini Live Ping ─────────────────────────────────────
      const geminiKey = resolved.get("Gemini")?.key;
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
          console.log("  Image generation via OpenRouter/MiniMax/Leonardo/BytePlus available");
          console.log("  Add GEMINI_API_KEY for analysis, transcription, and doc conversion");
        }
      } else {
        logger.error("One or more checks failed — see above");
      }

      process.exit(exitCode);
    });
}
