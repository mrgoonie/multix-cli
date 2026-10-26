/**
 * Render scene lines into takes. Only lines without a take for their current
 * cache key are sent (or the lines named with `newTake` for a fresh variant),
 * one request per line, never retried: a failed line is recorded and the run
 * stops (or continues with keepGoing) so nothing is paid for twice silently.
 * Every take records its file hash, duration, verification and the usage the
 * provider reported for that request alone; the manifest is saved after each
 * take so an interrupted run keeps what it paid for.
 */

import fs from "node:fs";
import path from "node:path";
import { settleTelemetry } from "../../agent/fetch-telemetry.js";
import { type OutputWarning, inspectOutput } from "../../agent/output-file-inspect.js";
import { run, summarizeUsage } from "../../agent/run-state.js";
import { classifyError } from "../../core/error-classify.js";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import {
  type LineEntry,
  type SceneManifest,
  TAKES_DIR,
  type Take,
  type TakeUsage,
  allLines,
  combinedStyle,
  refreshStatus,
  sha256,
  writeManifest,
} from "./scene-manifest.js";
import { adapterFor } from "./speech-adapters.js";
import type { VoiceProfile } from "./voice-profile.js";

export interface RenderOptions {
  projectDir: string;
  manifest: SceneManifest;
  profiles: Map<string, VoiceProfile>;
  scene?: string;
  lines?: string[];
  /** Render a new variant of the named lines even when a take is cached. */
  newTake?: boolean;
  /** Stop after this many requests. */
  limit?: number;
  keepGoing?: boolean;
  logger?: Logger;
}

export interface RenderResult {
  rendered: string[];
  cached: number;
  failed: Array<{ line: string; code: string; message: string }>;
  /** Lines left pending because of `limit` or an earlier failure. */
  remaining: string[];
}

/** Lines this run would send, in manifest order. */
export function selectTargets(
  manifest: SceneManifest,
  opts: Pick<RenderOptions, "scene" | "lines" | "newTake">,
): { targets: LineEntry[]; cached: number } {
  let lines = allLines(manifest);
  if (opts.scene) {
    if (!manifest.scenes.some((s) => s.id === opts.scene)) {
      throw new ValidationError(`No scene "${opts.scene}" in the manifest`);
    }
    lines = lines.filter((l) => l.id.startsWith(`${opts.scene}/`));
  }
  if (opts.lines?.length) {
    const wanted = new Set(opts.lines);
    for (const id of wanted) {
      if (!lines.some((l) => l.id === id)) throw new ValidationError(`No line "${id}" to render`);
    }
    lines = lines.filter((l) => wanted.has(l.id));
  } else if (opts.newTake) {
    throw new ValidationError("--new-take needs --line <id> (one variant per named line)");
  }
  const targets = opts.newTake
    ? lines
    : lines.filter((l) => l.status === "pending" || l.status === "failed");
  return { targets, cached: lines.length - targets.length };
}

function usageSince(postIndex: number, getKeys: Set<string>, characters: number): TakeUsage {
  const summary = summarizeUsage({
    ...run,
    postUsage: run.postUsage.slice(postIndex),
    getUsage: new Map([...run.getUsage].filter(([k]) => !getKeys.has(k))),
  });
  const cost = summary?.cost_usd ?? null;
  const credits = summary?.credits ?? null;
  return {
    characters,
    cost_usd: cost,
    credits,
    provenance: cost !== null || credits !== null ? "provider_reported" : "unknown",
    ...(summary?.metrics ? { metrics: summary.metrics } : {}),
  };
}

function takeFile(line: LineEntry, takeId: string, ext: string): string {
  const [scene, rest] = line.id.split("/");
  return path.join(TAKES_DIR, scene ?? "scene", `${rest}_${line.speaker}_${takeId}.${ext}`);
}

async function renderLine(
  line: LineEntry,
  profile: VoiceProfile,
  projectDir: string,
  logger?: Logger,
): Promise<Take> {
  const adapter = adapterFor(profile.provider);
  const postIndex = run.postUsage.length;
  const getKeys = new Set(run.getUsage.keys());
  const audio = await adapter.synthesize(
    {
      text: line.text,
      profile,
      style: combinedStyle(profile, line.direction),
      previousText: line.previous_text,
      nextText: line.next_text,
    },
    logger,
  );
  await settleTelemetry();
  const digest = sha256(audio.bytes);
  const id = `t_${digest.slice(0, 12)}`;
  const rel = takeFile(line, id, audio.ext);
  const abs = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, audio.bytes);
  const warnings: OutputWarning[] = [];
  const inspected = inspectOutput(abs, warnings);
  if (audio.bytes.length === 0) {
    warnings.push({ code: "EMPTY_OUTPUT", path: rel, message: "provider returned no audio" });
  }
  return {
    id,
    cache_key: line.cache_key,
    path: rel.split(path.sep).join("/"),
    sha256: digest,
    bytes: audio.bytes.length,
    mime: inspected.mime,
    ...(inspected.duration_s !== undefined ? { duration_s: inspected.duration_s } : {}),
    ...(audio.sampleRate ? { sample_rate: audio.sampleRate } : {}),
    created_at: new Date().toISOString(),
    verification: {
      ok: !warnings.some((w) => w.code === "EMPTY_OUTPUT" || w.code === "CONTENT_MISMATCH"),
      warnings: warnings.map((w) => `${w.code}: ${w.message}`),
    },
    status: "candidate",
    usage: usageSince(postIndex, getKeys, line.chars),
  };
}

/** Check keys and profiles for every target before the first paid request. */
export function preflight(targets: LineEntry[], profiles: Map<string, VoiceProfile>): void {
  const providers = new Set<VoiceProfile["provider"]>();
  for (const line of targets) {
    const profile = profiles.get(line.speaker);
    if (!profile)
      throw new ValidationError(`Line ${line.id}: voice profile "${line.speaker}" is missing`);
    providers.add(profile.provider);
  }
  for (const provider of providers) adapterFor(provider).requireKey();
}

export async function renderScenes(opts: RenderOptions): Promise<RenderResult> {
  const { manifest, profiles, projectDir, logger } = opts;
  const { targets, cached } = selectTargets(manifest, opts);
  preflight(targets, profiles);
  const result: RenderResult = { rendered: [], cached, failed: [], remaining: [] };
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let stopped = false;
  for (const line of targets) {
    if (stopped || result.rendered.length + result.failed.length >= limit) {
      result.remaining.push(line.id);
      continue;
    }
    const profile = profiles.get(line.speaker) as VoiceProfile;
    logger?.info(`Rendering ${line.id} (${line.speaker}, ${line.chars} chars)`);
    try {
      const take = await renderLine(line, profile, projectDir, logger);
      const existing = line.takes.findIndex((t) => t.id === take.id);
      if (existing >= 0) line.takes[existing] = take;
      else line.takes.push(take);
      line.selected_take = take.id;
      line.error = undefined;
      result.rendered.push(line.id);
    } catch (error) {
      const info = classifyError(error);
      line.error = {
        code: info.code,
        message: info.message.slice(0, 300),
        at: new Date().toISOString(),
      };
      result.failed.push({ line: line.id, code: info.code, message: line.error.message });
      logger?.error(`${line.id}: ${info.code} ${line.error.message}`);
      if (!opts.keepGoing) stopped = true;
    }
    refreshStatus(line);
    writeManifest(projectDir, manifest);
  }
  return result;
}
