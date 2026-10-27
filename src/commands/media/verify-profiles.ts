/**
 * Versioned rule sets for `media verify`. A profile states what kind of media
 * it judges and the thresholds of each check; any change to a threshold
 * bumps the profile's version, which every receipt records. Profiles carry no
 * platform targets (no "-14 LUFS for YouTube"): a loudness target is only
 * checked when the caller asks for one.
 */

import fs from "node:fs";
import { z } from "zod";
import { ValidationError } from "../../core/errors.js";

export type Severity = "error" | "warning";

const severity = z.enum(["error", "warning"]);

const checksSchema = z
  .object({
    black: z
      .object({
        min_duration_s: z.number().positive(),
        pixel_threshold: z.number().min(0).max(1),
        picture_threshold: z.number().min(0).max(1),
        severity,
      })
      .strict()
      .nullable(),
    freeze: z
      .object({ noise_db: z.number().max(0), min_duration_s: z.number().positive(), severity })
      .strict()
      .nullable(),
    silence: z
      .object({ noise_db: z.number().max(0), min_duration_s: z.number().positive(), severity })
      .strict()
      .nullable(),
    clipping: z
      .object({ max_true_peak_dbtp: z.number().max(6), severity })
      .strict()
      .nullable(),
    audio_required: severity.nullable(),
    blank_image: z
      .object({
        pixel_threshold: z.number().int().min(0).max(255),
        max_black_percent: z.number().min(0).max(100),
        severity,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type ProfileChecks = z.infer<typeof checksSchema>;

export interface VerifyProfile {
  id: string;
  version: number;
  description: string;
  media: "video" | "audio" | "image";
  checks: ProfileChecks;
}

const NONE: ProfileChecks = {
  black: null,
  freeze: null,
  silence: null,
  clipping: null,
  audio_required: null,
  blank_image: null,
};

export const BUILTIN_PROFILES: Record<string, VerifyProfile> = {
  "motion-graphics": {
    id: "motion-graphics",
    version: 1,
    description:
      "Rendered animation: black gaps fail; static holds are common, so only long freezes warn. Declare intended fades and holds with --allow-black/--allow-freeze.",
    media: "video",
    checks: {
      ...NONE,
      black: {
        min_duration_s: 0.5,
        pixel_threshold: 0.1,
        picture_threshold: 0.98,
        severity: "error",
      },
      freeze: { noise_db: -60, min_duration_s: 5, severity: "warning" },
      silence: { noise_db: -50, min_duration_s: 2, severity: "warning" },
      clipping: { max_true_peak_dbtp: 0, severity: "warning" },
    },
  },
  "camera-footage": {
    id: "camera-footage",
    version: 1,
    description:
      "Recorded or generated live-action video: black gaps and frozen frames over 1 s fail; missing audio and long silences warn.",
    media: "video",
    checks: {
      ...NONE,
      black: {
        min_duration_s: 0.5,
        pixel_threshold: 0.1,
        picture_threshold: 0.98,
        severity: "error",
      },
      freeze: { noise_db: -60, min_duration_s: 1, severity: "error" },
      silence: { noise_db: -50, min_duration_s: 3, severity: "warning" },
      clipping: { max_true_peak_dbtp: 0, severity: "warning" },
      audio_required: "warning",
    },
  },
  thumbnail: {
    id: "thumbnail",
    version: 1,
    description: "Still image: must decode and must not be blank (98% or more black pixels).",
    media: "image",
    checks: {
      ...NONE,
      blank_image: { pixel_threshold: 32, max_black_percent: 98, severity: "error" },
    },
  },
  audio: {
    id: "audio",
    version: 1,
    description:
      "Speech, music or sound: an audio stream is required, true peak above 0 dBTP fails, silences of 2 s or more warn.",
    media: "audio",
    checks: {
      ...NONE,
      audio_required: "error",
      silence: { noise_db: -50, min_duration_s: 2, severity: "warning" },
      clipping: { max_true_peak_dbtp: 0, severity: "error" },
    },
  },
};

const fileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "id: lowercase letters, digits, . _ -"),
    version: z.number().int().positive(),
    description: z.string().max(500).optional(),
    extends: z.string().optional(),
    media: z.enum(["video", "audio", "image"]).optional(),
    checks: checksSchema.partial().optional(),
  })
  .strict();

export function builtinProfile(id: string): VerifyProfile {
  const p = BUILTIN_PROFILES[id];
  if (!p)
    throw new ValidationError(
      `Unknown profile "${id}". Built-in profiles: ${Object.keys(BUILTIN_PROFILES).join(", ")}; or pass --profile-file <json>.`,
    );
  return p;
}

/**
 * A custom profile from a JSON file. `extends` names a built-in profile whose
 * checks it overrides one by one; `null` turns a check off.
 */
export function loadProfileFile(file: string): VerifyProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ValidationError(`Invalid profile file ${file}: ${(e as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(
      `Invalid profile file ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  const def = parsed.data;
  const base = def.extends ? builtinProfile(def.extends) : undefined;
  const media = def.media ?? base?.media;
  if (!media) throw new ValidationError(`Invalid profile file ${file}: set "media" or "extends"`);
  if (BUILTIN_PROFILES[def.id])
    throw new ValidationError(
      `Invalid profile file ${file}: id "${def.id}" is a built-in profile; pick another id`,
    );
  return {
    id: def.id,
    version: def.version,
    description: def.description ?? base?.description ?? "",
    media,
    checks: { ...(base?.checks ?? NONE), ...(def.checks ?? {}) },
  };
}
