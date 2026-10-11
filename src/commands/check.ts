/**
 * multix check — diagnostics command.
 * Validates tooling, API keys, Gemini live ping, setup hints, and optional
 * authenticated Codex image-driver readiness.
 */

import fs from "node:fs";
import os from "node:os";
import type { Command } from "commander";
import {
  type CredentialSpec,
  type TrustedSettingState,
  getLoadedEnvFiles,
  inspectBaseUrl,
  inspectTrustedSetting,
  legacyClaudeEnvEnabled,
  legacyClaudeEnvFiles,
  redact,
  resolveFirstKey,
  resolveKey,
} from "../core/env-loader.js";
import { createLogger } from "../core/logger.js";
import { DEFAULT_ATLAS_BASE_URL } from "../providers/atlascloud/models.js";
import { DEFAULT_BYTEPLUS_BASE_URL } from "../providers/byteplus/models.js";
import {
  CLOUDFLARE_NATIVE_CREDENTIALS,
  CLOUDFLARE_VIDEO_CREDENTIALS,
} from "../providers/cloudflare/models.js";
import { DEFAULT_FAL_BASE_URL } from "../providers/fal/models.js";
import { listGeminiKeys } from "../providers/gemini/key-pool.js";
import { DEFAULT_HEYGEN_BASE_URL } from "../providers/heygen/models.js";
import { DEFAULT_LEONARDO_BASE_URL } from "../providers/leonardo/models.js";
import { checkCodexAuthenticated } from "../providers/openai/codex-image-driver.js";
import { DEFAULT_REPLICATE_BASE_URL } from "../providers/replicate/models.js";
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
  {
    name: "fal.ai",
    envPrimary: "FAL_KEY",
    optional: true,
    link: "https://fal.ai/dashboard/keys",
  },
  {
    name: "Atlas Cloud",
    envPrimary: "ATLASCLOUD_API_KEY",
    optional: true,
    link: "https://www.atlascloud.ai/console/api-keys",
  },
  {
    name: "Replicate",
    envPrimary: "REPLICATE_API_TOKEN",
    envFallback: "REPLICATE_API_KEY",
    optional: true,
    link: "https://replicate.com/account/api-tokens",
  },
  {
    name: "HeyGen",
    envPrimary: "HEYGEN_API_KEY",
    optional: true,
    link: "https://app.heygen.com/developers/api",
  },
];

/** Same trimmed primary→fallback resolution the providers use, so check never disagrees. */
export function resolveProviderKey(p: ProviderEntry): { key?: string; envUsed?: string } {
  if (p.envPrimary === "GEMINI_API_KEY") {
    // Rotation pool: GEMINI_API_KEY first, then GEMINI_API_KEY_2, _3, …
    const first = listGeminiKeys()[0];
    return first ? { key: first.value, envUsed: first.name } : {};
  }
  const names = p.envFallback ? [p.envPrimary, p.envFallback] : [p.envPrimary];
  const found = resolveFirstKey(...names);
  return found ? { key: found.value, envUsed: found.envUsed } : {};
}

type CodexImageChecker = () => Promise<boolean>;

export function getCheckProviders(): ProviderEntry[] {
  return [...PROVIDERS];
}

const usable = (s: TrustedSettingState) => s.status === "used" || s.status === "fallback";

/**
 * Cloudflare readiness with the same trust rules the provider applies to the
 * account and gateway IDs, so an ID the provider would refuse is not counted.
 */
export function cloudflareReadiness(): { native: boolean; video: boolean } {
  const apiToken = resolveKey("CLOUDFLARE_API_TOKEN")?.trim();
  const replicateToken = resolveKey("REPLICATE_API_TOKEN")?.trim();
  const ids = (credentials: readonly CredentialSpec[]) => ({
    account: usable(inspectTrustedSetting("CLOUDFLARE_ACCOUNT_ID", credentials)),
    gateway: usable(inspectTrustedSetting("CLOUDFLARE_AI_GATEWAY_ID", credentials)),
  });
  const native = ids(CLOUDFLARE_NATIVE_CREDENTIALS);
  const video = ids(CLOUDFLARE_VIDEO_CREDENTIALS);
  return {
    native: Boolean(apiToken) && native.account,
    video: Boolean(apiToken && replicateToken) && video.account && video.gateway,
  };
}

/** Settings that decide where a key is sent, with the credentials each one receives. */
const ROUTING_SETTINGS: { name: string; defaultUrl?: string; credentials: CredentialSpec[] }[] = [
  {
    name: "ATLASCLOUD_BASE_URL",
    defaultUrl: DEFAULT_ATLAS_BASE_URL,
    credentials: ["ATLASCLOUD_API_KEY"],
  },
  {
    name: "BYTEPLUS_BASE_URL",
    defaultUrl: DEFAULT_BYTEPLUS_BASE_URL,
    credentials: [["BYTEPLUS_API_KEY", "ARK_API_KEY"]],
  },
  { name: "FAL_BASE_URL", defaultUrl: DEFAULT_FAL_BASE_URL, credentials: ["FAL_KEY"] },
  { name: "HEYGEN_BASE_URL", defaultUrl: DEFAULT_HEYGEN_BASE_URL, credentials: ["HEYGEN_API_KEY"] },
  {
    name: "LEONARDO_BASE_URL",
    defaultUrl: DEFAULT_LEONARDO_BASE_URL,
    credentials: ["LEONARDO_API_KEY"],
  },
  {
    name: "REPLICATE_BASE_URL",
    defaultUrl: DEFAULT_REPLICATE_BASE_URL,
    credentials: [["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]],
  },
  { name: "CLOUDFLARE_ACCOUNT_ID", credentials: [...CLOUDFLARE_NATIVE_CREDENTIALS] },
  { name: "CLOUDFLARE_AI_GATEWAY_ID", credentials: [...CLOUDFLARE_NATIVE_CREDENTIALS] },
];

/**
 * One check line per routing setting that is set, describing its effective
 * state (never the value).
 */
export function routingSettingReport(): { level: "info" | "warn"; message: string }[] {
  const lines: { level: "info" | "warn"; message: string }[] = [];
  for (const s of ROUTING_SETTINGS) {
    const state = s.defaultUrl
      ? inspectBaseUrl(s.name, s.defaultUrl, s.credentials)
      : inspectTrustedSetting(s.name, s.credentials);
    if (state.status === "used") {
      const from =
        state.source === "project"
          ? "project .env, with the keys it receives from the same file"
          : state.source === "user"
            ? "~/.multix/.env"
            : state.source === "legacy"
              ? "legacy .claude file"
              : "shell";
      lines.push({ level: "info", message: `${s.name} in effect (from ${from})` });
    } else if (state.status === "fallback") {
      const why =
        state.reason === "it is empty"
          ? "set empty in project .env"
          : `set in project .env while ${state.reason}`;
      lines.push({ level: "warn", message: `${s.name} ignored: ${why}; using ~/.multix/.env` });
    } else if (state.status === "refused") {
      lines.push({
        level: "warn",
        message: `${s.name} ignored: set in project .env while ${state.reason}; commands that use it will stop with an error`,
      });
    }
  }
  return lines;
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

      // ffmpeg only accepts the single-dash form; see checkBinary docstring.
      const ffmpegStatus = await checkBinary("ffmpeg", "-version");
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

      if (opts.verbose) {
        const files = getLoadedEnvFiles();
        logger.info(`Env files loaded: ${files.length > 0 ? files.join(", ") : "none"}`);
      }
      if (!legacyClaudeEnvEnabled()) {
        const home = process.env.MULTIX_DISABLE_HOME_ENV ? undefined : os.homedir();
        const legacy = legacyClaudeEnvFiles(process.cwd(), home).filter((f) => fs.existsSync(f));
        if (legacy.length > 0) {
          logger.info(
            `Found ${legacy.length} legacy .claude env file(s); set MULTIX_LEGACY_CLAUDE_ENV=1 to load them`,
          );
        }
      }

      let anyKey = false;
      const resolved = new Map<string, { key?: string; envUsed?: string }>();
      for (const p of PROVIDERS) {
        const r = resolveProviderKey(p);
        resolved.set(p.name, r);
        if (r.key) anyKey = true;
        const envLabel = r.envUsed ?? p.envPrimary;
        if (r.key) {
          logger.success(`${envLabel} found — ${redact(r.key)}`);
          if (p.name === "Gemini") {
            const pool = listGeminiKeys();
            if (pool.length > 1) {
              logger.info(
                `Gemini key rotation: ${pool.length} keys (${pool.map((k) => k.name).join(", ")})`,
              );
            }
          }
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

      const routing = routingSettingReport();
      if (routing.length > 0) {
        logger.header("Endpoint Overrides");
        for (const line of routing) {
          if (line.level === "warn") logger.warn(line.message);
          else logger.info(line.message);
        }
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

        // Ping every key in the rotation pool so a broken extra key is caught early.
        for (const key of listGeminiKeys()) {
          const ping = await pingGemini(key.value);
          if (ping.status === "success") {
            logger.success(
              `${key.name}: Gemini API reachable — ${ping.modelCount ?? 0} models available`,
            );
          } else if (ping.status === "auth_error") {
            logger.error(`Gemini auth failed — check ${key.name}: ${ping.error ?? ""}`);
            exitCode = 1;
          } else {
            logger.warn(`${key.name}: Gemini network error (API may be down): ${ping.error ?? ""}`);
          }
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
