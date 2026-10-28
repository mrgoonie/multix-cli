/**
 * multix check — diagnostics command.
 * Validates tooling, API keys, Gemini live ping, setup hints, and optional
 * authenticated Codex image-driver readiness.
 */

import fs from "node:fs";
import os from "node:os";
import type { Command } from "commander";
import {
  ALLOW_PROJECT_BASE_URL_ENV,
  type BaseUrlRouting,
  type BaseUrlState,
  type TrustedSettingState,
  getLoadedEnvFiles,
  inspectProviderBaseUrl,
  legacyClaudeEnvEnabled,
  legacyClaudeEnvFiles,
  redact,
  resolveFirstKey,
  resolveKey,
} from "../core/env-loader.js";
import { createLogger } from "../core/logger.js";
import { ATLAS_ROUTING } from "../providers/atlascloud/models.js";
import { BYTEPLUS_ROUTING } from "../providers/byteplus/models.js";
import {
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_GATEWAY_ID_ENV,
  type CloudflareConfigCheck,
  inspectCloudflareConfig,
} from "../providers/cloudflare/models.js";
import { FAL_ROUTING } from "../providers/fal/models.js";
import { listGeminiKeys } from "../providers/gemini/key-pool.js";
import { HEYGEN_ROUTING } from "../providers/heygen/models.js";
import { LEONARDO_ROUTING } from "../providers/leonardo/models.js";
import { checkCodexAuthenticated } from "../providers/openai/codex-image-driver.js";
import { REPLICATE_ROUTING } from "../providers/replicate/models.js";
import { RUNWAY_ROUTING } from "../providers/runway/models.js";
import { SUME_ROUTING } from "../providers/sume/models.js";
import {
  TOPVIEW_LEGACY_ROUTING,
  TOPVIEW_PLATFORM_ROUTING,
  TOPVIEW_UID_ENV,
} from "../providers/topview/models.js";
import { checkBinary } from "./check-helpers/binary-check.js";
import { pingGemini } from "./check-helpers/gemini-ping.js";
import { FFMPEG_HINT, MAGICK_HINT, SETUP_HINTS } from "./check-helpers/setup-hints.js";

import { PROVIDER_KEYS, type ProviderEntry } from "../providers/provider-keys.js";

export type { ProviderEntry } from "../providers/provider-keys.js";

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
  return [...PROVIDER_KEYS];
}

/** Cloudflare readiness from the same inspection the commands run before they send anything. */
export function cloudflareReadiness(): {
  native: boolean;
  video: boolean;
  nativeCheck: CloudflareConfigCheck;
  videoCheck: CloudflareConfigCheck;
} {
  const nativeCheck = inspectCloudflareConfig("native");
  const videoCheck = inspectCloudflareConfig("video");
  return { native: !nativeCheck.problem, video: !videoCheck.problem, nativeCheck, videoCheck };
}

/** Provider base URLs whose effective state `multix check` reports. */
const BASE_URL_ROUTING: readonly BaseUrlRouting[] = [
  ATLAS_ROUTING,
  BYTEPLUS_ROUTING,
  FAL_ROUTING,
  HEYGEN_ROUTING,
  LEONARDO_ROUTING,
  REPLICATE_ROUTING,
  RUNWAY_ROUTING,
  SUME_ROUTING,
  TOPVIEW_LEGACY_ROUTING,
  TOPVIEW_PLATFORM_ROUTING,
];

export type ReportLine = { level: "info" | "warn"; message: string };

function usedFrom(state: Extract<TrustedSettingState, { status: "used" }>): string {
  if (state.source === "project") {
    if (state.basis === "default") return "project .env; same as the default endpoint";
    if (state.basis === "opt-in") return `project .env; allowed by ${ALLOW_PROJECT_BASE_URL_ENV}`;
    return "project .env, which also holds every key sent with it";
  }
  if (state.source === "user") return "~/.multix/.env";
  if (state.source === "legacy") return "legacy .claude file";
  return "shell";
}

/** One report line for a routing setting's state, or undefined when it is unset. */
function settingLine(
  label: string,
  state: BaseUrlState,
  commands = "commands that use it",
): ReportLine | undefined {
  const stops = `${commands} will stop with an error`;
  if (state.status === "unset") return undefined;
  if (state.status === "refused") {
    return {
      level: "warn",
      message: `${label} ignored: set in project .env while ${state.reason}; ${stops}`,
    };
  }
  if (state.schemeError) return { level: "warn", message: `${state.schemeError}; ${stops}` };
  if (state.status === "used") {
    return { level: "info", message: `${label} in effect (from ${usedFrom(state)})` };
  }
  return {
    level: "warn",
    message: `${label} ignored: set in project .env while ${state.reason}; using ~/.multix/.env`,
  };
}

const sameState = (a: TrustedSettingState, b: TrustedSettingState) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * One check line per routing setting that is set, describing its effective
 * state (never the value). Each state comes from the inspector the command
 * itself runs, including the https rule, so check and the command agree.
 */
export function routingSettingReport(): ReportLine[] {
  const lines: ReportLine[] = [];
  const push = (line: ReportLine | undefined) => {
    if (line) lines.push(line);
  };
  for (const routing of BASE_URL_ROUTING) {
    push(settingLine(routing.name, inspectProviderBaseUrl(routing)));
  }
  // Native and video commands send different tokens, so an ID can be fine for one and not the other.
  const { nativeCheck, videoCheck } = cloudflareReadiness();
  for (const [name, key] of [
    [CLOUDFLARE_ACCOUNT_ID_ENV, "accountId"],
    [CLOUDFLARE_GATEWAY_ID_ENV, "gatewayId"],
  ] as const) {
    push(settingLine(name, nativeCheck[key]));
    if (!sameState(nativeCheck[key], videoCheck[key])) {
      push(settingLine(`${name} (video)`, videoCheck[key], "video commands"));
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
      for (const p of PROVIDER_KEYS) {
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

      if (resolved.get("TopView (legacy API)")?.key && !resolveKey(TOPVIEW_UID_ENV)?.trim()) {
        logger.warn(
          `${TOPVIEW_UID_ENV} not set: TopView legacy commands need it with TOPVIEW_API_KEY`,
        );
      }

      const cloudflare = cloudflareReadiness();
      const blocked = (what: string) =>
        logger.warn(
          `${what} will stop: a project .env setting is not trusted (see Endpoint Overrides)`,
        );
      if (cloudflare.native) {
        anyKey = true;
        logger.success("Cloudflare Workers AI credentials configured (image and speech)");
        if (cloudflare.video) {
          logger.success("Cloudflare AI Gateway video credentials configured");
        } else if (cloudflare.videoCheck.refused) {
          blocked("Cloudflare video");
        } else {
          logger.info(`Cloudflare video unavailable: ${cloudflare.videoCheck.problem}`);
        }
      } else if (cloudflare.nativeCheck.refused) {
        blocked("Cloudflare image, speech and video");
      } else {
        logger.info(`Cloudflare media unavailable (optional): ${cloudflare.nativeCheck.problem}`);
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
