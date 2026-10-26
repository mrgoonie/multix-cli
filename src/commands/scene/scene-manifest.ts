/**
 * Scene manifest (`multix.scene/v1`, `<project>/multix-scene.json`): every
 * line of every scene with its speaker, normalised text and digest, the exact
 * request it will send (provider, model, voice, params), a content-addressed
 * cache key, and its takes (audio path, sha256, duration, verification,
 * approval, usage). Planning is local: it re-reads the scripts and profiles,
 * keeps takes whose cache key still matches, and marks the rest pending, so a
 * changed line (or voice) invalidates only the lines whose request changed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import { type ParsedScript, charCount, chunkText, markupIn, parseScript } from "./script-parser.js";
import { type SceneProvider, adapterFor } from "./speech-adapters.js";
import { type VoiceProfile, speakerIndex } from "./voice-profile.js";

export const SCENE_SCHEMA = "multix.scene/v1";
export const MANIFEST_FILE = "multix-scene.json";
export const TAKES_DIR = "takes";

export type CostProvenance = "provider_reported" | "unknown";

export interface TakeUsage {
  characters: number;
  /** null when the provider did not report it (unknown is not zero). */
  cost_usd: number | null;
  credits: number | null;
  provenance: CostProvenance;
  metrics?: Record<string, number>;
}

export interface Take {
  id: string;
  cache_key: string;
  /** Relative to the project directory. */
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
  duration_s?: number;
  sample_rate?: number;
  created_at: string;
  verification: { ok: boolean; warnings: string[] };
  status: "candidate" | "approved" | "rejected";
  usage: TakeUsage;
}

export interface LineRequest {
  provider: SceneProvider;
  model: string;
  params: Record<string, unknown>;
}

export interface LineEntry {
  /** `<scene>/<NNN>` or `<scene>/<NNN>.<part>` for split lines. */
  id: string;
  speaker: string;
  speaker_label: string;
  text: string;
  direction?: string;
  script_sha256: string;
  previous_text?: string;
  next_text?: string;
  part?: { index: number; of: number };
  source_line: number;
  chars: number;
  voice_version: number;
  request: LineRequest;
  cache_key: string;
  status: "pending" | "rendered" | "approved" | "failed";
  selected_take?: string;
  takes: Take[];
  error?: { code: string; message: string; at: string };
}

export interface SceneEntry {
  id: string;
  title?: string;
  script: string;
  script_sha256: string;
  lines: LineEntry[];
}

export interface SceneManifest {
  schema: typeof SCENE_SCHEMA;
  project: string;
  updated_at: string;
  voices: Record<string, { version: number; provider: string; model: string; voice: string }>;
  scenes: SceneEntry[];
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with sorted keys, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Content address of one synthesis request: same key, same audio contract. */
export function cacheKey(request: LineRequest, text: string): string {
  return sha256(canonical({ v: 1, ...request, text }));
}

export function manifestPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_FILE);
}

export function readManifest(projectDir: string): SceneManifest | undefined {
  const file = manifestPath(projectDir);
  if (!fs.existsSync(file)) return undefined;
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as SceneManifest;
  if (data.schema !== SCENE_SCHEMA) {
    throw new ValidationError(`${file} is not a ${SCENE_SCHEMA} manifest`);
  }
  return data;
}

export function requireManifest(projectDir: string): SceneManifest {
  const manifest = readManifest(projectDir);
  if (!manifest) {
    throw new ValidationError(
      `No ${MANIFEST_FILE} in ${projectDir}; run: multix scene plan <script...> --project ${projectDir}`,
    );
  }
  return manifest;
}

/** Write atomically so an interrupted render never leaves a torn manifest. */
export function writeManifest(projectDir: string, manifest: SceneManifest): void {
  manifest.updated_at = new Date().toISOString();
  const file = manifestPath(projectDir);
  fs.mkdirSync(projectDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function combinedStyle(profile: VoiceProfile, direction?: string): string | undefined {
  const style = [profile.style, direction].filter(Boolean).join("; ");
  return style || undefined;
}

/** Problems with one line for its model, found before anything is billed. */
export function lineErrors(
  profile: VoiceProfile,
  text: string,
  direction: string | undefined,
): string[] {
  const limits = adapterFor(profile.provider).limits(profile.model);
  const errors: string[] = [];
  const { ssml, audioTags } = markupIn(text);
  for (const tag of ssml) {
    const isBreak = /^<break\b[^>]*\/>$/i.test(tag);
    if (!(isBreak && limits.ssmlBreaks)) {
      errors.push(`${tag} is not supported by ${profile.model} and would be read aloud`);
    }
  }
  if (audioTags.length && !limits.audioTags) {
    errors.push(`audio tags ${audioTags.join(" ")} need a model that supports them (eleven_v3)`);
  }
  if (direction && !limits.style) {
    errors.push(`delivery direction "(${direction})" is not supported by ${profile.model}`);
  }
  return errors;
}

export interface PlanInput {
  scripts: Array<{ path: string; source: string }>;
  profiles: Map<string, VoiceProfile>;
  project: string;
  previous?: SceneManifest;
}

export interface PlanResult {
  manifest: SceneManifest;
  /** Line ids whose request differs from every take they had. */
  invalidated: string[];
  added: string[];
  removed: string[];
}

function lineStatus(line: LineEntry): LineEntry["status"] {
  const take = line.takes.find((t) => t.id === line.selected_take);
  if (take && take.cache_key === line.cache_key) {
    return take.status === "approved" ? "approved" : "rendered";
  }
  return line.error ? "failed" : "pending";
}

export function refreshStatus(line: LineEntry): void {
  line.status = lineStatus(line);
}

/** Build the manifest from scripts and profiles, carrying over still-valid takes. */
export function planScenes(input: PlanInput): PlanResult {
  const speakers = speakerIndex(input.profiles);
  const parsed: Array<ParsedScript & { path: string; sha: string }> = input.scripts.map((s) => ({
    ...parseScript(s.source, path.basename(s.path).replace(/\.[^.]+$/, "")),
    path: s.path,
    sha: sha256(s.source),
  }));
  const seen = new Set<string>();
  for (const p of parsed) {
    if (seen.has(p.scene)) throw new ValidationError(`Scene "${p.scene}" appears twice`);
    seen.add(p.scene);
  }

  const oldLines = new Map<string, LineEntry>();
  const takesByKey = new Map<string, Take[]>();
  for (const scene of input.previous?.scenes ?? []) {
    for (const line of scene.lines) {
      oldLines.set(line.id, line);
      for (const take of line.takes) {
        takesByKey.set(take.cache_key, [...(takesByKey.get(take.cache_key) ?? []), take]);
      }
    }
  }

  const errors: string[] = [];
  const usedVoices = new Map<string, VoiceProfile>();
  const scenes: SceneEntry[] = parsed.map((script) => {
    const lines: LineEntry[] = [];
    script.lines.forEach((l, i) => {
      const where = `${script.path}:${l.sourceLine}`;
      const profile = speakers.get(l.speaker.toLocaleLowerCase());
      if (!profile) {
        errors.push(
          `${where}: no voice profile for speaker "${l.speaker}" (multix scene voice add ${l.speaker.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")} ...)`,
        );
        return;
      }
      usedVoices.set(profile.id, profile);
      for (const e of lineErrors(profile, l.text, l.direction)) errors.push(`${where}: ${e}`);
      const adapter = adapterFor(profile.provider);
      const limit = Math.min(
        profile.max_chars ?? Number.POSITIVE_INFINITY,
        adapter.limits(profile.model).maxChars,
      );
      const parts = chunkText(l.text, limit);
      const base = `${script.scene}/${String(i + 1).padStart(3, "0")}`;
      parts.forEach((text, p) => {
        lines.push({
          id: parts.length > 1 ? `${base}.${p + 1}` : base,
          speaker: profile.id,
          speaker_label: l.speaker,
          text,
          ...(l.direction ? { direction: l.direction } : {}),
          script_sha256: sha256(`${l.direction ?? ""}\n${text}`),
          ...(parts.length > 1 ? { part: { index: p + 1, of: parts.length } } : {}),
          source_line: l.sourceLine,
          chars: charCount(text),
          voice_version: profile.version,
          request: { provider: profile.provider, model: profile.model, params: {} },
          cache_key: "",
          status: "pending",
          takes: [],
        });
      });
    });

    // Context and cache keys need the neighbours, so they come after splitting.
    lines.forEach((line, i) => {
      const profile = input.profiles.get(line.speaker) as VoiceProfile;
      const previousText = lines[i - 1]?.text;
      const nextText = lines[i + 1]?.text;
      if (previousText) line.previous_text = previousText;
      if (nextText) line.next_text = nextText;
      line.request.params = adapterFor(profile.provider).requestParams({
        profile,
        style: combinedStyle(profile, line.direction),
        previousText,
        nextText,
      });
      line.cache_key = cacheKey(line.request, line.text);
      const old = oldLines.get(line.id);
      const takes = [...(old?.takes ?? [])];
      for (const t of takesByKey.get(line.cache_key) ?? []) {
        if (!takes.some((x) => x.path === t.path)) takes.push(t);
      }
      line.takes = takes;
      const keep = old?.selected_take
        ? takes.find((t) => t.id === old.selected_take && t.cache_key === line.cache_key)
        : undefined;
      const match =
        keep ??
        takes.find((t) => t.cache_key === line.cache_key && t.status === "approved") ??
        [...takes].reverse().find((t) => t.cache_key === line.cache_key && t.status !== "rejected");
      if (match) line.selected_take = match.id;
      if (old?.error && old.cache_key === line.cache_key) line.error = old.error;
      refreshStatus(line);
    });

    return {
      id: script.scene,
      ...(script.title ? { title: script.title } : {}),
      script: script.path,
      script_sha256: script.sha,
      lines,
    };
  });

  if (errors.length) {
    throw new ValidationError(
      `Scene plan has ${errors.length} problem(s):\n  - ${errors.join("\n  - ")}`,
    );
  }

  const newIds = new Set(scenes.flatMap((s) => s.lines.map((l) => l.id)));
  const added: string[] = [];
  const invalidated: string[] = [];
  for (const line of scenes.flatMap((s) => s.lines)) {
    const old = oldLines.get(line.id);
    if (!old) added.push(line.id);
    else if (old.cache_key !== line.cache_key && old.takes.length > 0) invalidated.push(line.id);
  }
  const removed = [...oldLines.keys()].filter((id) => !newIds.has(id));

  const manifest: SceneManifest = {
    schema: SCENE_SCHEMA,
    project: input.project,
    updated_at: new Date().toISOString(),
    voices: Object.fromEntries(
      [...usedVoices.values()].map((p) => [
        p.id,
        { version: p.version, provider: p.provider, model: p.model, voice: p.voice },
      ]),
    ),
    scenes,
  };
  return { manifest, invalidated, added, removed };
}

export function allLines(manifest: SceneManifest): LineEntry[] {
  return manifest.scenes.flatMap((s) => s.lines);
}

export function findLine(manifest: SceneManifest, id: string): LineEntry {
  const line = allLines(manifest).find((l) => l.id === id);
  if (!line) {
    throw new ValidationError(
      `No line "${id}" in the manifest (ids look like s01/003; see multix scene status)`,
    );
  }
  return line;
}

export interface SceneSummary {
  scene: string;
  lines: number;
  rendered: number;
  approved: number;
  pending: number;
  failed: number;
  complete: boolean;
  characters_rendered: number;
  duration_s: number;
  /** Sum of provider-reported costs; null when none was reported. */
  cost_usd: number | null;
  credits: number | null;
  /** Takes whose cost the provider did not report. */
  unknown_cost_takes: number;
  takes: number;
}

/** Per-scene completion and spend, over every take (rejected variants cost money too). */
export function summarize(manifest: SceneManifest): SceneSummary[] {
  return manifest.scenes.map((scene) => {
    const s: SceneSummary = {
      scene: scene.id,
      lines: scene.lines.length,
      rendered: 0,
      approved: 0,
      pending: 0,
      failed: 0,
      complete: false,
      characters_rendered: 0,
      duration_s: 0,
      cost_usd: null,
      credits: null,
      unknown_cost_takes: 0,
      takes: 0,
    };
    for (const line of scene.lines) {
      s[line.status === "approved" ? "approved" : line.status] += 1;
      if (line.status === "approved") s.rendered += 1;
      const selected = line.takes.find((t) => t.id === line.selected_take);
      if (selected && line.status !== "pending" && line.status !== "failed") {
        s.duration_s += selected.duration_s ?? 0;
      }
      for (const take of line.takes) {
        s.takes += 1;
        s.characters_rendered += take.usage.characters;
        if (take.usage.cost_usd !== null) s.cost_usd = (s.cost_usd ?? 0) + take.usage.cost_usd;
        else s.unknown_cost_takes += 1;
        if (take.usage.credits !== null) s.credits = (s.credits ?? 0) + take.usage.credits;
      }
    }
    s.complete = s.pending === 0 && s.failed === 0;
    s.duration_s = Math.round(s.duration_s * 1000) / 1000;
    if (s.cost_usd !== null) s.cost_usd = Math.round(s.cost_usd * 1e6) / 1e6;
    return s;
  });
}
