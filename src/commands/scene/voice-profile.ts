/**
 * Character voice profiles (`multix.voice/v1`): one JSON file per speaker in
 * `<project>/voices/<id>.json`, so a character keeps the same provider, model,
 * voice and delivery defaults across every scene. Profiles hold no
 * credentials: keys come from the environment at render time, and a profile
 * with a secret-looking field is rejected. A cloud-cloned voice must record
 * who granted consent and when.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import { SCENE_PROVIDERS, type SceneProvider, adapterFor } from "./speech-adapters.js";

export const VOICE_PROFILE_SCHEMA = "multix.voice/v1";
export const VOICES_DIR = "voices";

export type SettingValue = string | number | boolean;

export interface VoiceProfile {
  schema: typeof VOICE_PROFILE_SCHEMA;
  /** Stable speaker id used in scripts and manifests. */
  id: string;
  name?: string;
  /** Other names the script may use for this speaker (case-insensitive). */
  aliases?: string[];
  /** Bumped by the author on intentional changes; informational. */
  version: number;
  provider: SceneProvider;
  model: string;
  /** Provider voice id or name. */
  voice: string;
  /** BCP 47 language tag, e.g. "vi" or "vi-VN". */
  language?: string;
  /** Provider output format (see `multix scene voice add --help`). */
  format: string;
  /** Delivery direction applied to every line (OpenAI instructions, Gemini 3.8 style). */
  style?: string;
  /** Provider-specific request settings, e.g. ElevenLabs stability. */
  settings?: Record<string, SettingValue>;
  /** Send neighbouring lines as previous/next text (only where the model supports it). */
  context?: boolean;
  /** Split lines longer than this many characters (capped by the model limit). */
  max_chars?: number;
  /** Present when the voice is a cloud clone of a real person's voice. */
  clone?: { consent: { granted_by: string; granted_at: string; note?: string } };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECRET_FIELD = /(api[_-]?key|token|secret|password|authorization|credential|bearer)/i;
const SECRET_VALUE = /^(sk-|sk_|xi-|AIza|Bearer\s)/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function voicesDir(projectDir: string): string {
  return path.join(projectDir, VOICES_DIR);
}

export function profilePath(projectDir: string, id: string): string {
  return path.join(voicesDir(projectDir), `${id}.json`);
}

function findSecrets(value: unknown, at: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSecrets(v, `${at}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD.test(k)) out.push(`${at}.${k}: credentials do not belong in a profile`);
      findSecrets(v, `${at}.${k}`, out);
    }
  } else if (typeof value === "string" && SECRET_VALUE.test(value)) {
    out.push(`${at}: looks like a credential; keep keys in the environment`);
  }
}

/** Every problem with a profile, before any request is sent. Empty when valid. */
export function profileErrors(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["profile must be an object"];
  const p = raw as Partial<VoiceProfile>;
  findSecrets(raw, "profile", errors);
  if (p.schema !== VOICE_PROFILE_SCHEMA) errors.push(`schema must be "${VOICE_PROFILE_SCHEMA}"`);
  if (typeof p.id !== "string" || !ID.test(p.id)) {
    errors.push("id must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  if (!Number.isInteger(p.version) || (p.version ?? 0) < 1) {
    errors.push("version must be an integer >= 1");
  }
  if (p.aliases !== undefined) {
    if (!Array.isArray(p.aliases) || p.aliases.some((a) => typeof a !== "string" || !a.trim())) {
      errors.push("aliases must be non-empty strings");
    }
  }
  if (p.language !== undefined && (typeof p.language !== "string" || !LANGUAGE.test(p.language))) {
    errors.push(`language "${String(p.language)}" is not a BCP 47 tag (e.g. vi, vi-VN, en-US)`);
  }
  if (p.max_chars !== undefined && !(Number.isInteger(p.max_chars) && p.max_chars >= 20)) {
    errors.push("max_chars must be an integer >= 20");
  }
  if (p.context !== undefined && typeof p.context !== "boolean") {
    errors.push("context must be true or false");
  }
  if (p.settings !== undefined) {
    if (!p.settings || typeof p.settings !== "object" || Array.isArray(p.settings)) {
      errors.push("settings must be an object");
    }
  }
  if (p.clone !== undefined) {
    const c = p.clone?.consent;
    if (!c || typeof c.granted_by !== "string" || !c.granted_by.trim()) {
      errors.push("clone.consent.granted_by is required for a cloned voice");
    }
    if (!c || typeof c.granted_at !== "string" || Number.isNaN(Date.parse(c.granted_at))) {
      errors.push("clone.consent.granted_at must be an ISO date for a cloned voice");
    }
  }
  if (!SCENE_PROVIDERS.includes(p.provider as SceneProvider)) {
    errors.push(`provider must be one of: ${SCENE_PROVIDERS.join(", ")}`);
    return errors;
  }
  if (typeof p.model !== "string" || typeof p.voice !== "string" || typeof p.format !== "string") {
    errors.push("model, voice and format are required strings");
    return errors;
  }
  errors.push(...adapterFor(p.provider as SceneProvider).profileErrors(p as VoiceProfile));
  return errors;
}

export function assertValidProfile(raw: unknown, source: string): VoiceProfile {
  const errors = profileErrors(raw);
  if (errors.length > 0) {
    throw new ValidationError(`Invalid voice profile ${source}:\n  - ${errors.join("\n  - ")}`);
  }
  return raw as VoiceProfile;
}

export function readProfileFile(file: string): VoiceProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ValidationError(
      `Cannot read voice profile ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const profile = assertValidProfile(raw, file);
  if (path.basename(file, ".json") !== profile.id) {
    throw new ValidationError(`Voice profile ${file} has id "${profile.id}"; rename the file`);
  }
  return profile;
}

/** All profiles of a project, by id. */
export function loadProfiles(projectDir: string): Map<string, VoiceProfile> {
  const dir = voicesDir(projectDir);
  const out = new Map<string, VoiceProfile>();
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const profile = readProfileFile(path.join(dir, name));
    out.set(profile.id, profile);
  }
  return out;
}

/** Speaker label in a script → profile, by id or alias (case-insensitive). */
export function speakerIndex(profiles: Map<string, VoiceProfile>): Map<string, VoiceProfile> {
  const index = new Map<string, VoiceProfile>();
  for (const profile of profiles.values()) {
    for (const name of [profile.id, profile.name, ...(profile.aliases ?? [])]) {
      if (!name) continue;
      const key = name.normalize("NFC").trim().toLocaleLowerCase();
      const taken = index.get(key);
      if (taken && taken.id !== profile.id) {
        throw new ValidationError(
          `Speaker name "${name}" belongs to both "${taken.id}" and "${profile.id}"`,
        );
      }
      index.set(key, profile);
    }
  }
  return index;
}

export function writeProfile(projectDir: string, profile: VoiceProfile): string {
  const file = profilePath(projectDir, profile.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return file;
}
