/**
 * Ratings, reviews and use-case notes about an offering (`multix.feedback/v1`):
 * what an entry may hold, how it is cleaned, and how ratings are summarised.
 *
 * Entries are user-authored and private by default. They are rejected when
 * they carry what must never be stored or shared: API keys and tokens,
 * signed or query-bearing URLs, e-mail addresses or phone numbers. Text is
 * bounded and stripped of control characters, and readers get it marked as
 * untrusted so an agent treats it as data, never as instructions. A rating
 * summary always carries its sample size; a mean from fewer than
 * MIN_RATINGS_FOR_MEAN ratings is not reported as evidence of quality.
 *
 * Runtime-neutral: the CLI stores entries locally; a server can reuse the rules.
 */

import { type Task, isTask } from "../capabilities/capability-types.js";
import { ValidationError } from "../core/errors.js";
import { type SampleConfidence, sampleConfidence } from "./usage-analytics.js";

export const FEEDBACK_SCHEMA = "multix.feedback/v1";

export type FeedbackKind = "rating" | "review" | "note";

/**
 * private: this machine only; project: this machine, tagged with the project
 * directory. Sharing with a team or publicly needs server-side moderation and
 * is refused until it exists.
 */
export type FeedbackScope = "private" | "project";
export const FEEDBACK_SCOPES: readonly FeedbackScope[] = ["private", "project"];
export const SHARED_SCOPES: readonly string[] = ["team", "public"];

export const ASPECTS = [
  "quality",
  "fidelity",
  "motion",
  "audio",
  "speed",
  "value",
  "reliability",
] as const;
export type Aspect = (typeof ASPECTS)[number];

export const MIN_RATINGS_FOR_MEAN = 3;

export const LIMITS = {
  text: 4000,
  item: 200,
  items: 10,
  tag: 40,
  ref: 200,
  version: 80,
} as const;

export interface VerifiedUsage {
  history_id: string;
  job_id?: string;
  at: string;
}

export interface Feedback {
  id: string;
  kind: FeedbackKind;
  /** "<provider>:<model>". */
  ref: string;
  provider: string;
  model: string;
  task?: Task;
  /** Slug such as "product-ugc" or "vietnamese-tts". */
  use_case?: string;
  /** 1–5, ratings and optionally reviews. */
  score?: number;
  aspects?: Partial<Record<Aspect, number>>;
  text?: string;
  pros?: string[];
  cons?: string[];
  /** Use-case notes: whether to use the offering for `use_case`. */
  verdict?: "use" | "avoid";
  strengths?: string[];
  weaknesses?: string[];
  limitations?: string[];
  tags?: string[];
  model_version?: string;
  /** Where a note's claim comes from (a run, a benchmark, a doc). */
  source?: string;
  scope: FeedbackScope;
  project?: string;
  /** Set when the entry is tied to a run in the local history of this offering. */
  verified_usage?: VerifiedUsage;
  created_at: string;
  updated_at: string;
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  [/\br8_[A-Za-z0-9]{20,}/, "a Replicate token"],
  [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, "a JWT"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{12,}/i, "a bearer token"],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/, "a long token"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*[?#]\S*=/i, "a URL with a query (signed URLs are credentials)"],
  [/[\w.+-]+@[\w-]+\.[\w.-]*[a-z]{2,}/i, "an e-mail address"],
  [/(?:\+|\b00)\d[\d ().-]{8,}\d\b/, "a phone number"],
];

/** Why `text` must not be stored, or undefined when it is fine. */
export function sensitiveContent(text: string): string | undefined {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return what;
  return undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

function clean(value: string, max: number, field: string): string {
  const text = value.replace(CONTROL, "").trim();
  if (!text) throw new ValidationError(`${field} is empty`);
  if (text.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  const bad = sensitiveContent(text);
  if (bad) {
    throw new ValidationError(
      `${field} looks like it contains ${bad}; remove it (feedback never stores secrets, signed URLs or personal data)`,
    );
  }
  return text;
}

function cleanList(values: string[] | undefined, field: string): string[] | undefined {
  if (!values?.length) return undefined;
  if (values.length > LIMITS.items) {
    throw new ValidationError(`${field}: at most ${LIMITS.items} items`);
  }
  return values.map((v) => clean(v, LIMITS.item, field));
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function cleanSlug(value: string, field: string): string {
  const slug = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!SLUG.test(slug) || slug.length > LIMITS.tag) {
    throw new ValidationError(
      `${field} must be letters, digits and "-" (at most ${LIMITS.tag}), got "${value}"`,
    );
  }
  return slug;
}

export function cleanScore(value: string | number, field = "score"): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new ValidationError(`${field} must be a whole number from 1 to 5`);
  }
  return n;
}

export function cleanScope(value: string | undefined): FeedbackScope {
  const scope = (value ?? "private").trim().toLowerCase();
  if (SHARED_SCOPES.includes(scope)) {
    throw new ValidationError(
      `--scope ${scope} is not available yet: shared feedback needs server-side moderation. Use private or project.`,
    );
  }
  if (!(FEEDBACK_SCOPES as readonly string[]).includes(scope)) {
    throw new ValidationError(`--scope must be one of ${FEEDBACK_SCOPES.join(", ")}`);
  }
  return scope as FeedbackScope;
}

/** "quality=4" pairs into aspect scores. */
export function cleanAspects(
  pairs: string[] | undefined,
): Partial<Record<Aspect, number>> | undefined {
  if (!pairs?.length) return undefined;
  const out: Partial<Record<Aspect, number>> = {};
  for (const pair of pairs) {
    const [name = "", value = ""] = pair.split("=");
    const aspect = name.trim().toLowerCase();
    if (!(ASPECTS as readonly string[]).includes(aspect)) {
      throw new ValidationError(`--aspect ${name}: use one of ${ASPECTS.join(", ")}`);
    }
    out[aspect as Aspect] = cleanScore(value, `--aspect ${aspect}`);
  }
  return out;
}

export interface FeedbackFields {
  task?: string;
  use_case?: string;
  score?: string | number;
  aspects?: string[];
  text?: string;
  pros?: string[];
  cons?: string[];
  verdict?: string;
  strengths?: string[];
  weaknesses?: string[];
  limitations?: string[];
  tags?: string[];
  model_version?: string;
  source?: string;
}

/** Validate and clean the user-provided fields of an entry; throws ValidationError. */
export function cleanFields(
  kind: FeedbackKind,
  f: FeedbackFields,
): Omit<
  Feedback,
  "id" | "kind" | "ref" | "provider" | "model" | "scope" | "created_at" | "updated_at"
> {
  if (f.task !== undefined && !isTask(f.task))
    throw new ValidationError(`Unknown task "${f.task}"`);
  if (kind === "rating" && f.score === undefined) throw new ValidationError("--score is required");
  if (kind === "review" && f.text === undefined) throw new ValidationError("--text is required");
  if (kind === "note") {
    if (!f.use_case) throw new ValidationError("--use-case is required for a note");
    if (f.verdict === undefined) throw new ValidationError("--verdict use|avoid is required");
  }
  if (f.verdict !== undefined && f.verdict !== "use" && f.verdict !== "avoid") {
    throw new ValidationError("--verdict must be use or avoid");
  }
  const lists = {
    pros: cleanList(f.pros, "--pro"),
    cons: cleanList(f.cons, "--con"),
    strengths: cleanList(f.strengths, "--strength"),
    weaknesses: cleanList(f.weaknesses, "--weakness"),
    limitations: cleanList(f.limitations, "--limitation"),
  };
  if ((f.tags?.length ?? 0) > LIMITS.items) {
    throw new ValidationError(`--tag: at most ${LIMITS.items}`);
  }
  const tags = f.tags?.length ? [...new Set(f.tags.map((t) => cleanSlug(t, "--tag")))] : undefined;
  const aspects = cleanAspects(f.aspects);
  return {
    ...(f.task ? { task: f.task as Task } : {}),
    ...(f.use_case ? { use_case: cleanSlug(f.use_case, "--use-case") } : {}),
    ...(f.score !== undefined ? { score: cleanScore(f.score) } : {}),
    ...(aspects ? { aspects } : {}),
    ...(f.text !== undefined ? { text: clean(f.text, LIMITS.text, "--text") } : {}),
    ...Object.fromEntries(Object.entries(lists).filter(([, v]) => v !== undefined)),
    ...(f.verdict ? { verdict: f.verdict as "use" | "avoid" } : {}),
    ...(tags ? { tags } : {}),
    ...(f.model_version
      ? { model_version: clean(f.model_version, LIMITS.version, "--model-version") }
      : {}),
    ...(f.source ? { source: clean(f.source, LIMITS.item, "--source") } : {}),
  };
}

export interface RatingSummary {
  count: number;
  /** Mean score; null below MIN_RATINGS_FOR_MEAN ratings. */
  mean: number | null;
  distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  verified_usage: number;
  aspects: Partial<Record<Aspect, { count: number; mean: number | null }>>;
  latest_at: string | null;
  confidence: SampleConfidence;
}

export function summariseRatings(entries: Feedback[]): RatingSummary {
  const scored = entries.filter((e) => typeof e.score === "number");
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const e of scored) distribution[String(e.score) as keyof typeof distribution]++;
  const mean = (xs: number[]) =>
    xs.length >= MIN_RATINGS_FOR_MEAN
      ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100
      : null;
  const aspects: RatingSummary["aspects"] = {};
  for (const a of ASPECTS) {
    const xs = scored.map((e) => e.aspects?.[a]).filter((v): v is number => typeof v === "number");
    if (xs.length) aspects[a] = { count: xs.length, mean: mean(xs) };
  }
  const times = entries.map((e) => e.updated_at).sort();
  return {
    count: scored.length,
    mean: mean(scored.map((e) => e.score as number)),
    distribution,
    verified_usage: scored.filter((e) => e.verified_usage).length,
    aspects,
    latest_at: times.at(-1) ?? null,
    confidence: sampleConfidence(scored.length),
  };
}

/** Feedback as a reader gets it: user text marked untrusted. */
export function feedbackView(e: Feedback): Feedback & { content_trust: "user-authored" } {
  return { ...e, content_trust: "user-authored" };
}
