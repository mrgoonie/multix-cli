/**
 * Download a job's input files into its directory. Only public https URLs are
 * fetched: the host name is checked here, and the resolved address is checked
 * when the socket connects (job-network.mjs), on every redirect hop, which is
 * followed by hand. Each download has a size cap and a timeout, and the target
 * path chosen by the Worker must stay under `in/`.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BlockedAddressError, publicHttpsGet } from "./job-network.mjs";

export const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
export const INPUT_PATH_RE = /^in\/(?:[A-Za-z0-9_-]{1,64}\/)?\d{1,3}-[A-Za-z0-9._-]{1,80}$/;

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".private",
  ".home.arpa",
  ".in-addr.arpa",
  ".ip6.arpa",
];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

/** Same rules as worker/src/url-guard.ts: https, default port, public host name, no credentials. */
export function assertPublicHttps(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError("Input URL is not valid");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipLiteral = host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port !== "" ||
    !host.includes(".") ||
    ipLiteral ||
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    throw new InputError("Input URL must be a public https URL");
  }
  return url;
}

/** Absolute path for a Worker-chosen relative input path, refusing anything outside `<dir>/in`. */
export function inputPath(dir, relative) {
  if (typeof relative !== "string" || !INPUT_PATH_RE.test(relative) || relative.includes("..")) {
    throw new InputError("Input path is not valid");
  }
  const full = resolve(dir, relative);
  if (!full.startsWith(`${resolve(dir, "in")}${sep}`))
    throw new InputError("Input path is not valid");
  return full;
}

function sizeLimit(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new InputError(`Input file is larger than ${limit / 1024 / 1024} MB`));
      else done(null, chunk);
    },
  });
}

async function fetchFollowing(rawUrl, signal, get) {
  let url = assertPublicHttps(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await get(url, { signal });
    } catch (error) {
      if (error instanceof BlockedAddressError || error?.code === "EBLOCKEDADDRESS") {
        throw new InputError(new BlockedAddressError().message);
      }
      throw error;
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel();
      url = assertPublicHttps(new URL(response.headers.get("location"), url).toString());
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new InputError(`Input download failed: HTTP ${response.status}`);
    }
    return response;
  }
  throw new InputError("Input download failed: too many redirects");
}

/**
 * @param {string} dir job directory
 * @param {{ url: string, path: string }[]} inputs
 * @param {{ signal?: AbortSignal, get?: typeof publicHttpsGet, maxBytes?: number }} [options]
 *   `get` is injected in tests; it performs one request without following redirects.
 */
export async function downloadInputs(dir, inputs, options = {}) {
  const get = options.get ?? publicHttpsGet;
  const maxBytes = options.maxBytes ?? MAX_INPUT_BYTES;
  for (const input of inputs) {
    const target = inputPath(dir, input.path);
    const signals = [AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let response;
    try {
      response = await fetchFollowing(input.url, signal, get);
    } catch (error) {
      if (error instanceof InputError) throw error;
      if (options.signal?.aborted) throw error;
      throw new InputError("Input download failed: the host could not be reached in time");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body.cancel();
      throw new InputError(`Input file is larger than ${maxBytes / 1024 / 1024} MB`);
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        sizeLimit(maxBytes),
        createWriteStream(target),
      );
    } catch (error) {
      if (error instanceof InputError) throw error;
      if (options.signal?.aborted) throw error;
      throw new InputError("Input download failed while reading the file");
    }
  }
}
