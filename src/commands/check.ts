/**
 * multix check — diagnostics command.
 * Validates tooling, API keys, Gemini live ping, setup hints, and optional
 * authenticated Codex image-driver readiness.
 */

import type { Command } from "commander";
import { redact, resolveKey } from "../core/env-loader.js";
import { createLogger } from "../core/logger.js";
import { checkCodexAuthenticated } from "../providers/openai/codex-image-driver.js";
import { checkBinary } from "./check-helpers/binary-check.js";
import { pingGemini } from "./check-helpers/gemini-ping.js";
import { FFMPEG_HINT, MAGICK_HINT, SETUP_HINTS } from "./check-helpers/setup-hints.js";

export interface ProviderEntry {
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
    name: "OpenAI",
    envPrimary: "OPENAI_API_KEY",
    optional: true,
    link: "https://platform.openai.com/api-keys",
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

type CodexImageChecker = () => Promise<boolean>;

export function getCheckProviders(): ProviderEntry[] {
  return [...PROVIDERS];
}

export function cloudflareReadiness(): { native: boolean; video: boolean } {
  const accountId = resolveKey("CLOUDFLARE_ACCOUNT_ID")?.trim();
  const apiToken = resolveKey("CLOUDFLARE_API_TOKEN")?.trim();
  const gatewayId = resolveKey("CLOUDFLARE_AI_GATEWAY_ID")?.trim();
  const replicateToken = resolveKey("REPLICATE_API_TOKEN")?.trim();
  return {
    native: Boolean(accountId && apiToken),
    video: Boolean(accountId && apiToken && gatewayId && replicateToken),
  };
}

export async function checkCodexImageReadiness(
  hasAnyProviderKey: boolean,
  verbose = false,
  checker: CodexImageChecker = checkCodexAuthenticated,
): Promise<boolean> {
  if (hasAnyProviderKey && !verbose) return false;
  return checker();
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

      const cloudflare = cloudflareReadiness();
      if (cloudflare.native) {
        anyKey = true;
        logger.success("Cloudflare Workers AI credentials configured (image and speech)");
        if (cloudflare.video) {
          logger.success("Cloudflare AI Gateway video credentials configured");
        } else {
          logger.info("Cloudflare video needs CLOUDFLARE_AI_GATEWAY_ID and REPLICATE_API_TOKEN");
        }
      } else {
        logger.info(
          "Cloudflare media needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (optional)",
        );
      }

      const shouldCheckCodex = !anyKey || opts.verbose;
      let codexReady = false;
      if (shouldCheckCodex) {
        logger.header("Codex Image Driver");
        logger.info("Checking Codex login status...");
        codexReady = await checkCodexImageReadiness(anyKey, opts.verbose ?? false);
        if (codexReady) {
          logger.success("Codex authenticated — experimental OpenAI image driver available");
        } else {
          logger.info("Codex image driver unavailable (run `codex login` to enable it)");
        }
      }
      if (!anyKey) {
        if (!codexReady) {
          logger.header("No Provider Keys Configured");
          console.log(SETUP_HINTS);
          process.exit(1);
        }
        anyKey = true;
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
        } else if (resolved.get("OpenAI")?.key) {
          console.log("  OpenAI API setup available (images, TTS, STT)");
        } else {
          console.log("  Image generation via configured providers or experimental Codex driver");
          console.log("  Add API keys for full provider features");
        }
      } else {
        logger.error("One or more checks failed — see above");
      }

      process.exit(exitCode);
    });
}
