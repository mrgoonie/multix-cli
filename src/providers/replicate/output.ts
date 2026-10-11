/**
 * Prediction output extraction and file-type inference.
 * Runtime-neutral: no node:* imports.
 *
 * Replicate outputs are model-specific: a single URL string, a URL list, a
 * nested object, plain text, or a list of text tokens (language models).
 */

import { ProviderError } from "../../core/errors.js";
import { redactUrl } from "../../core/redact.js";
import type { ReplicatePrediction } from "./types.js";

export interface MediaOutput {
  url: string;
  /** Dotted path into the output, e.g. "[0]" or "video" — for logs only. */
  path: string;
}

export interface ExtractedOutput {
  media: MediaOutput[];
  /** Non-media values to print rather than download. */
  texts: string[];
}

const HTTP_RE = /^https?:\/\//i;
const DATA_URI_RE = /^data:[^,]*,/i;

export function isMediaRef(value: unknown): boolean {
  return typeof value === "string" && (HTTP_RE.test(value) || DATA_URI_RE.test(value));
}

export const REPLICATE_DELIVERY_HOST = "replicate.delivery";

function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

function isNonPublicIpv4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 0 || // "this network" / unspecified
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

/** `host` is a bracketless IPv6 literal as normalized by the WHATWG URL parser. */
function isNonPublicIpv6(host: string): boolean {
  // IPv4-mapped (::ffff:7f00:1) — check the embedded IPv4 address.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = Number.parseInt(mapped[1] as string, 16);
    const lo = Number.parseInt(mapped[2] as string, 16);
    return isNonPublicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  // Leading zero group: unspecified (::), loopback (::1), IPv4-compatible.
  if (host.startsWith("::")) return true;
  const first = Number.parseInt(host.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 // multicast
  );
}

export interface OutputUrlCheck {
  /** Hostname only — safe to log (no path or signed query string). */
  host: string;
  /** True for replicate.delivery and its subdomains. */
  trusted: boolean;
}

/**
 * Policy for downloading a prediction output URL (applied to every redirect
 * hop): https only, never localhost or a loopback/private/link-local/
 * unspecified IP literal. Hosts other than replicate.delivery are allowed but
 * reported as untrusted so the caller can warn. Error messages name the host
 * only, never the signed URL.
 */
export function checkOutputUrl(url: string): OutputUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError("Refusing to download an output: malformed URL", "replicate");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (parsed.protocol !== "https:") {
    throw new ProviderError(
      `Refusing to download from ${host || "an output URL"}: only https:// output URLs are downloaded`,
      "replicate",
    );
  }
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const octets = ipv4Octets(bare);
  const isLocal =
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    (octets !== undefined && isNonPublicIpv4(octets)) ||
    (bare.includes(":") && isNonPublicIpv6(bare));
  if (isLocal) {
    throw new ProviderError(
      `Refusing to download from ${host}: output URLs must not point to a local or private address`,
      "replicate",
    );
  }
  const trusted = host === REPLICATE_DELIVERY_HOST || host.endsWith(`.${REPLICATE_DELIVERY_HOST}`);
  return { host, trusted };
}

/** Walk any output shape, collecting media URLs and text values in order. */
export function extractOutput(output: unknown): ExtractedOutput {
  const result: ExtractedOutput = { media: [], texts: [] };
  const seen = new Set<unknown>();

  const visit = (value: unknown, path: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (isMediaRef(value)) result.media.push({ url: value, path: path || "output" });
      else if (value.length > 0) result.texts.push(path ? `${path}: ${value}` : value);
      return;
    }
    if (typeof value !== "object") {
      result.texts.push(path ? `${path}: ${String(value)}` : String(value));
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      // Language models stream text as an array of string tokens: join them.
      if (value.length > 0 && value.every((v) => typeof v === "string" && !isMediaRef(v))) {
        const joined = (value as string[]).join("");
        if (joined.length > 0) result.texts.push(path ? `${path}: ${joined}` : joined);
        return;
      }
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      visit(val, path ? `${path}.${key}` : key);
    }
  };

  visit(output, "");
  return result;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "model/gltf-binary": ".glb",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/plain": ".txt",
};

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".glb": "model/gltf-binary",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".zip": "application/zip",
  ".txt": "text/plain",
};

/** File extension (with dot) for a MIME type, ignoring parameters. */
export function extFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TO_EXT[mime];
}

/** MIME type for a file name/extension, defaulting to application/octet-stream. */
export function mimeFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot === -1 ? "" : filename.slice(dot).toLowerCase();
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/** Extension from a URL path (`.png`) or a data URI's MIME type; undefined when unknown. */
export function extFromUrl(url: string): string | undefined {
  if (DATA_URI_RE.test(url)) {
    const mime = url.slice(5, url.indexOf(",")).split(";")[0];
    return extFromContentType(mime);
  }
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const ext = last.slice(dot).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Printable view of a prediction. Omits `input` and `logs`, which can carry
 * prompts or inlined user files, and strips query strings (pre-signed
 * tokens) from output URLs, so structured output stays safe to share.
 * Use --download (or --no-download for raw URLs) to get the files themselves.
 */
export function summarizePrediction(p: ReplicatePrediction): Record<string, unknown> {
  const summary: Record<string, unknown> = { id: p.id, status: p.status };
  if (p.model) summary.model = p.model;
  if (p.version) summary.version = p.version;
  if (p.error !== undefined && p.error !== null) summary.error = p.error;
  if (p.output !== undefined && p.output !== null) summary.output = redactOutputUrls(p.output);
  if (p.metrics) summary.metrics = p.metrics;
  if (p.created_at) summary.created_at = p.created_at;
  if (p.completed_at) summary.completed_at = p.completed_at;
  if (p.urls?.web) summary.web_url = p.urls.web;
  return summary;
}

/** Deep-copy an output, redacting signed URL query strings and inlined data URIs. */
export function redactOutputUrls(value: unknown): unknown {
  if (typeof value === "string") {
    if (DATA_URI_RE.test(value)) return `${value.slice(0, value.indexOf(",") + 1)}[redacted]`;
    return HTTP_RE.test(value) ? redactUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map(redactOutputUrls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactOutputUrls(v)]),
    );
  }
  return value;
}

/**
 * `replicate-<first 8 of id>-NN<ext>` — the default saved-output file name.
 * Non-alphanumerics are stripped so an id can never introduce path segments.
 */
export function outputFilename(predictionId: string, index: number, ext: string): string {
  const prefix = predictionId.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "output";
  return `replicate-${prefix}-${String(index + 1).padStart(2, "0")}${ext}`;
}
