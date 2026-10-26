/**
 * Turn the CLI's run ledger (the last line of its history JSONL file) into the
 * job result's usage report (`JobUsageReport` in worker/src/jobs/job-protocol.ts).
 *
 * The ledger holds argv, the working directory, error messages and absolute
 * output paths; none of those leave the container. Only numbers, short ids,
 * hashes and output names relative to out/ are copied, and each is checked
 * before it is kept. A field the CLI did not record stays absent (never 0).
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** A larger ledger is not one job's single entry: ignore it. */
export const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_METRICS = 20;
const MAX_METRIC_KEY = 80;
const MAX_PROVIDER_IDS = 10;
const MAX_ID_LENGTH = 128;
const MAX_OUTPUTS = 50;
const ID_RE = /^[A-Za-z0-9._:\-/]+$/;
const URL_LIKE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\//;
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MIME_RE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const TOKEN_KEYS = ["input", "output", "total", "thinking"];

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A short id-like string: no URL, no absolute path, no whitespace. */
function safeId(v) {
  return typeof v === "string" &&
    v.length > 0 &&
    v.length <= MAX_ID_LENGTH &&
    ID_RE.test(v) &&
    !URL_LIKE_RE.test(v) &&
    !v.startsWith("/")
    ? v
    : undefined;
}

/** Parse the last non-empty line of the ledger; undefined when missing, too big or malformed. */
async function lastEntry(historyFile) {
  try {
    const info = await stat(historyFile);
    if (!info.isFile() || info.size > MAX_HISTORY_BYTES) return undefined;
    const lines = (await readFile(historyFile, "utf8")).split("\n").filter((l) => l.trim());
    const entry = JSON.parse(lines.at(-1) ?? "");
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

function mapTokens(raw) {
  if (!isRecord(raw)) return undefined;
  const tokens = {};
  for (const key of TOKEN_KEYS) {
    const v = count(raw[key]);
    if (v !== undefined) tokens[key] = v;
  }
  return Object.keys(tokens).length ? tokens : undefined;
}

function mapMetrics(raw) {
  if (!isRecord(raw)) return undefined;
  const metrics = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_METRICS) break;
    const v = finite(value);
    if (v === undefined || key.length === 0 || key.length > MAX_METRIC_KEY) continue;
    if (URL_LIKE_RE.test(key)) continue;
    metrics[key] = v;
    kept++;
  }
  return kept ? metrics : undefined;
}

function mapHttp(raw) {
  if (!isRecord(raw)) return undefined;
  const requests = count(raw.requests);
  const errors = count(raw.errors);
  const ms = count(raw.ms);
  return requests !== undefined && errors !== undefined && ms !== undefined
    ? { requests, errors, ms }
    : undefined;
}

function mapProviderIds(raw) {
  if (!Array.isArray(raw)) return undefined;
  const ids = [];
  for (const v of raw) {
    const id = safeId(v);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_PROVIDER_IDS) break;
  }
  return ids.length ? ids : undefined;
}

/** `file` relative to one of `roots` with forward slashes, or undefined when it escapes all of them. */
function nameUnder(file, roots) {
  for (const root of roots) {
    const rel = relative(root, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    const name = rel.split(sep).join("/");
    if (name.split("/").some((s) => s === ".." || s === "." || s === "")) continue;
    return name;
  }
  return undefined;
}

function mapOutputs(raw, cwd, roots) {
  if (!Array.isArray(raw)) return undefined;
  const outputs = [];
  for (const o of raw) {
    if (outputs.length >= MAX_OUTPUTS) break;
    if (!isRecord(o) || typeof o.path !== "string" || o.path.includes("\0")) continue;
    const name = nameUnder(resolve(cwd, o.path), roots);
    const bytes = count(o.bytes);
    if (!name || bytes === undefined || !Number.isInteger(bytes)) continue;
    const out = { name, bytes };
    if (typeof o.mime === "string" && MIME_RE.test(o.mime)) out.mime = o.mime;
    if (typeof o.sha256 === "string" && SHA256_RE.test(o.sha256))
      out.sha256 = o.sha256.toLowerCase();
    const durationS = count(o.duration_s);
    if (durationS !== undefined) out.durationS = durationS;
    outputs.push(out);
  }
  return outputs.length ? outputs : undefined;
}

/**
 * Read the CLI's last ledger entry and reduce it to a `JobUsageReport`.
 *
 * @param {string} historyFile the CLI's MULTIX_HISTORY_FILE
 * @param {string} outDir the job's out/ directory; output names are relative to it
 * @param {string} [cwd] the CLI's working directory, for relative output paths (default: out/'s parent)
 * @returns {Promise<object | undefined>} undefined when the ledger is missing, unreadable or empty of useful fields
 */
export async function readUsageReport(historyFile, outDir, cwd = dirname(outDir)) {
  const entry = await lastEntry(historyFile);
  if (!entry) return undefined;
  const roots = [resolve(outDir)];
  try {
    const real = await realpath(outDir);
    if (real !== roots[0]) roots.push(real);
  } catch {}
  const usage = isRecord(entry.usage) ? entry.usage : {};
  const report = {
    provider:
      typeof entry.provider === "string" && PROVIDER_RE.test(entry.provider)
        ? entry.provider
        : undefined,
    model: safeId(entry.model),
    durationMs: count(entry.duration_ms),
    errorCode:
      isRecord(entry.error) &&
      typeof entry.error.code === "string" &&
      ERROR_CODE_RE.test(entry.error.code)
        ? entry.error.code
        : undefined,
    tokens: mapTokens(usage.tokens),
    costUsd: count(usage.cost_usd),
    credits: count(usage.credits),
    metrics: mapMetrics(usage.metrics),
    http: mapHttp(entry.http),
    providerIds: mapProviderIds(entry.provider_ids),
    outputs: mapOutputs(entry.outputs, cwd, roots),
  };
  for (const key of Object.keys(report)) if (report[key] === undefined) delete report[key];
  return Object.keys(report).length ? report : undefined;
}
