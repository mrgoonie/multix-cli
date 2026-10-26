/**
 * Summarize the CLI's own record of a job run: the last entry of the history
 * file the job pointed it at (MULTIX_HISTORY_FILE). Only what the usage ledger
 * needs is kept: command, provider, model, outcome, error code, usage, HTTP
 * counts, provider ids and output metadata. argv, cwd, version, paths and
 * error messages are dropped. Every field is checked; anything unexpected is
 * left out and nothing here throws.
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { safeOutputName } from "./r2-upload.mjs";

/** A bigger history file is ignored: one job writes one short line. */
export const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_METRICS = 40;
const MAX_PROVIDER_IDS = 10;
const MAX_OUTPUTS = 20;
const MAX_STRING = 128;
const TOKEN_KEYS = ["input", "output", "total", "thinking"];

/**
 * @param {string} file history file written by the CLI
 * @param {(text: string) => string} clean redacts secrets from a string
 * @returns {Promise<object | undefined>} JobRunSummary, or undefined without a usable entry
 */
export async function readRunSummary(file, clean) {
  try {
    const entry = lastEntry(await readBounded(file));
    return entry ? summarize(entry, clean) : undefined;
  } catch {
    return undefined;
  }
}

async function readBounded(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_HISTORY_BYTES) return undefined;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** The last line that parses to a JSON object. */
function lastEntry(text) {
  if (typeof text !== "string") return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      if (isObject(value)) return value;
    } catch {}
  }
  return undefined;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A redacted string of at most `max` characters, or undefined. */
function text(value, clean, max = MAX_STRING) {
  if (typeof value !== "string") return undefined;
  const out = clean(value);
  return out.length > 0 && out.length <= max ? out : undefined;
}

/** Copy the defined values only. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) if (value !== undefined) out[key] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

function summarize(entry, clean) {
  const command = text(entry.command, clean);
  const provider = text(entry.provider, clean);
  const exitCode = Number.isInteger(entry.exit_code) ? entry.exit_code : undefined;
  const duration = finite(entry.duration_ms);
  if (
    command === undefined ||
    provider === undefined ||
    typeof entry.ok !== "boolean" ||
    exitCode === undefined ||
    duration === undefined ||
    duration < 0
  ) {
    return undefined;
  }
  const errorCode = isObject(entry.error) ? text(entry.error.code, clean, 64) : undefined;
  return compact({
    command,
    provider,
    model: text(entry.model, clean),
    ok: entry.ok,
    exitCode,
    durationMs: Math.round(duration),
    errorCode,
    usage: usageOf(entry.usage, clean),
    http: httpOf(entry.http),
    providerIds: idsOf(entry.provider_ids, clean),
    outputs: outputsOf(entry.outputs, clean),
  });
}

function usageOf(usage, clean) {
  if (!isObject(usage)) return undefined;
  const tokens = isObject(usage.tokens)
    ? compact(Object.fromEntries(TOKEN_KEYS.map((k) => [k, finite(usage.tokens[k])])))
    : undefined;
  let metrics;
  if (isObject(usage.metrics)) {
    const kept = [];
    for (const [key, value] of Object.entries(usage.metrics)) {
      if (kept.length >= MAX_METRICS) break;
      const name = text(key, clean);
      const number = finite(value);
      if (name !== undefined && number !== undefined) kept.push([name, number]);
    }
    if (kept.length > 0) metrics = Object.fromEntries(kept);
  }
  return compact({
    tokens,
    cost_usd: finite(usage.cost_usd),
    credits: finite(usage.credits),
    metrics,
  });
}

function httpOf(http) {
  if (!isObject(http)) return undefined;
  const requests = count(http.requests);
  const errors = count(http.errors);
  const ms = finite(http.ms);
  if (requests === undefined || errors === undefined || ms === undefined || ms < 0) {
    return undefined;
  }
  return { requests, errors, ms: Math.round(ms) };
}

function idsOf(ids, clean) {
  if (!Array.isArray(ids)) return undefined;
  const kept = [];
  for (const id of ids) {
    if (kept.length >= MAX_PROVIDER_IDS) break;
    const value = text(id, clean);
    if (value !== undefined) kept.push(value);
  }
  return kept.length > 0 ? kept : undefined;
}

function outputsOf(outputs, clean) {
  if (!Array.isArray(outputs)) return undefined;
  const kept = [];
  for (const output of outputs) {
    if (kept.length >= MAX_OUTPUTS) break;
    if (!isObject(output) || typeof output.path !== "string") continue;
    const name = safeOutputName(clean(output.path));
    const bytes = count(output.bytes);
    if (name === undefined || bytes === undefined) continue;
    const sha256 =
      typeof output.sha256 === "string" && /^[0-9a-f]{64}$/.test(output.sha256)
        ? output.sha256
        : undefined;
    const durationS = finite(output.duration_s);
    kept.push(
      compact({
        name,
        bytes,
        mime: text(output.mime, clean),
        sha256,
        durationS: durationS !== undefined && durationS >= 0 ? durationS : undefined,
      }),
    );
  }
  return kept.length > 0 ? kept : undefined;
}
