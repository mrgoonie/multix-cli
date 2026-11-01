/**
 * Minimal S3 API client for Cloudflare R2 and any other S3-compatible
 * service, signed with aws4fetch (SigV4).
 *
 * Runtime-neutral: no `node:*` imports and fetch is injected, so the same
 * module runs in the Worker (dashboard credential check, presigned links) and
 * in Node 20+. The target is either an R2 account id (path-style URLs on
 * `https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`, region
 * `auto`) or a custom https endpoint with its region and path-style
 * (`https://<host>/<bucket>/<key>`) or virtual-hosted
 * (`https://<bucket>.<host>/<key>`) addressing.
 *
 * Errors carry the HTTP status and the S3 error code only, never the request
 * URL (presigned or not), headers or credentials.
 */

import { AwsV4Signer } from "aws4fetch";
import type { FetchLike } from "../../../src/core/fetch-json.js";
import { assertPublicHttpsUrl } from "../url-guard.js";

/** Longest lifetime R2 accepts for a presigned URL (7 days). */
export const MAX_PRESIGN_SECONDS = 604_800;
/** Longest object key R2 accepts, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 1024;

export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
/** R2 bucket names: 3–63 chars of lower-case letters, digits and hyphens, not starting or ending with a hyphen. */
export const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Bucket names on a custom endpoint with path-style addressing may also contain dots (S3 rules). */
export const DOTTED_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** Signing region: lower-case letters, digits and hyphens (`auto` for R2, `us-east-1` style elsewhere). */
export const REGION_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Region used for a custom endpoint when none is given (what most S3-compatible services accept). */
export const DEFAULT_S3_REGION = "us-east-1";

export type S3Addressing = "path" | "virtual";

/** Where the bucket lives: an R2 account id, or a custom S3-compatible endpoint. Exactly one of the two. */
export interface StorageTarget {
  /** Cloudflare account id (32 lower-case hex characters); selects R2. */
  accountId?: string;
  /** https origin of an S3-compatible API, e.g. `https://s3.eu-central-1.amazonaws.com`. */
  endpoint?: string;
  /** Signing region; `auto` for R2, DEFAULT_S3_REGION for a custom endpoint when unset. */
  region?: string;
  /** Path-style (default) or virtual-hosted bucket URLs. R2 always uses path-style. */
  addressing?: S3Addressing;
}

export interface R2Credentials extends StorageTarget {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The resolved request target. */
export interface ResolvedTarget {
  /** https origin of the S3 API host, without the bucket. */
  origin: string;
  region: string;
  addressing: S3Addressing;
  /** True for a Cloudflare R2 account endpoint. */
  r2: boolean;
}

/**
 * Normalise a custom endpoint to its https origin. It must be a public https
 * host name (url-guard.ts: no IP literal, internal name, credentials or
 * non-default port) with no path, query or fragment. Returns undefined when
 * the value is rejected.
 */
export function normaliseEndpoint(raw: string): string | undefined {
  let normalized: string;
  try {
    normalized = assertPublicHttpsUrl(raw.trim(), "endpoint");
  } catch {
    return undefined;
  }
  const url = new URL(normalized);
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(raw)) return undefined;
  return url.origin;
}

/** Resolve where requests go; throws on an invalid or ambiguous target. */
export function resolveTarget(target: StorageTarget): ResolvedTarget {
  if (target.accountId !== undefined && target.endpoint !== undefined) {
    throw new Error("Give either an R2 account id or an endpoint, not both");
  }
  if (target.region !== undefined && !REGION_RE.test(target.region)) {
    throw new Error("Invalid storage region");
  }
  if (target.endpoint !== undefined) {
    const origin = normaliseEndpoint(target.endpoint);
    if (!origin || origin !== target.endpoint) throw new Error("Invalid storage endpoint");
    return {
      origin,
      region: target.region ?? DEFAULT_S3_REGION,
      addressing: target.addressing === "virtual" ? "virtual" : "path",
      r2: false,
    };
  }
  if (!ACCOUNT_ID_RE.test(target.accountId ?? "")) throw new Error("Invalid R2 account id");
  return {
    origin: `https://${target.accountId}.r2.cloudflarestorage.com`,
    region: target.region ?? "auto",
    addressing: "path",
    r2: true,
  };
}

/** Whether `bucket` is a valid name for this target (dots only with path-style on a custom endpoint). */
export function validBucket(bucket: string, target: ResolvedTarget): boolean {
  if (BUCKET_RE.test(bucket)) return true;
  return (
    !target.r2 &&
    target.addressing === "path" &&
    DOTTED_BUCKET_RE.test(bucket) &&
    !bucket.includes("..") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  );
}

/** Base URL of a bucket, without a trailing slash. */
export function bucketBaseUrl(bucket: string, target: ResolvedTarget): string {
  if (!validBucket(bucket, target)) {
    throw new Error(target.r2 ? "Invalid R2 bucket name" : "Invalid bucket name");
  }
  if (target.addressing === "virtual") {
    const url = new URL(target.origin);
    return `${url.protocol}//${bucket}.${url.host}`;
  }
  return `${target.origin}/${bucket}`;
}

/** Clamp a presigned-link lifetime to 1 s – 7 days; anything not finite means the maximum. */
export function clampPresignSeconds(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds)) return MAX_PRESIGN_SECONDS;
  return Math.min(Math.max(Math.floor(seconds), 1), MAX_PRESIGN_SECONDS);
}

export interface R2ClientOptions extends R2Credentials {
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Abort each request after this many milliseconds (unset = no timeout). */
  timeoutMs?: number;
}

export class R2RequestError extends Error {
  constructor(
    readonly operation: string,
    /** HTTP status, or 0 when the storage service could not be reached. */
    readonly status: number,
    /** S3 error code from the response body, e.g. `NoSuchBucket`. */
    readonly code?: string,
  ) {
    super(
      status === 0
        ? `Storage ${operation} failed: the storage service could not be reached`
        : `Storage ${operation} failed: HTTP ${status}${code ? ` ${code}` : ""}`,
    );
    this.name = "R2RequestError";
  }
}

const encoder = new TextEncoder();

/** RFC 3986 encoding; encodeURIComponent leaves !'()* raw, which SigV4 signs encoded. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encode an object key as a URL path. Empty, "." and ".." segments are refused:
 * URL parsing collapses dot segments, so they could address another bucket.
 */
function encodeKey(key: string): string {
  const bytes = encoder.encode(key).byteLength;
  const segments = key.split("/");
  if (
    bytes === 0 ||
    bytes > MAX_KEY_BYTES ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error("Invalid R2 object key");
  }
  return segments.map(encodeSegment).join("/");
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Read at most MAX_ERROR_BODY_BYTES of an error body, then drop the rest. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, MAX_ERROR_BODY_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await readCapped(response);
  return /<Code>([A-Za-z]{1,64})<\/Code>/.exec(body)?.[1];
}

export class R2Client {
  readonly target: ResolvedTarget;
  private readonly doFetch: FetchLike;

  constructor(private readonly options: R2ClientOptions) {
    this.target = resolveTarget(options);
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Unsigned object URL on the S3 API host (path-style or virtual-hosted). */
  objectUrl(bucket: string, key: string): string {
    return `${bucketBaseUrl(bucket, this.target)}/${encodeKey(key)}`;
  }

  private signer(
    url: string,
    method: string,
    extra: { headers?: HeadersInit; body?: BodyInit; signQuery?: boolean } = {},
  ) {
    return new AwsV4Signer({
      url,
      method,
      ...extra,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      service: "s3",
      region: this.target.region,
    });
  }

  private async send(
    operation: string,
    url: string,
    method: string,
    headers?: HeadersInit,
    body?: BodyInit,
  ): Promise<Response> {
    const signed = await this.signer(url, method, { headers, body }).sign();
    // Never follow a redirect: the signed request would go to a host that was not checked.
    const init: RequestInit = { method, headers: signed.headers, body, redirect: "manual" };
    if (this.options.timeoutMs) init.signal = AbortSignal.timeout(this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(signed.url.toString(), init);
    } catch {
      throw new R2RequestError(operation, 0);
    }
    if (!response.ok)
      throw new R2RequestError(operation, response.status, await errorCode(response));
    return response;
  }

  /** ListObjectsV2 with max-keys=1: proves read access to one bucket (works with bucket-scoped tokens). */
  async listProbe(bucket: string): Promise<void> {
    const response = await this.send(
      "list",
      // Virtual-hosted URLs need the root path; path-style keeps R2's original form.
      `${bucketBaseUrl(bucket, this.target)}${this.target.addressing === "virtual" ? "/" : ""}?list-type=2&max-keys=1`,
      "GET",
    );
    await response.body?.cancel();
  }

  /** Upload one object with a single PUT (R2 accepts up to ~5 GiB per PUT). */
  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array | ArrayBuffer | string,
    contentType = "application/octet-stream",
  ): Promise<void> {
    const response = await this.send(
      "upload",
      this.objectUrl(bucket, key),
      "PUT",
      {
        "content-type": contentType,
      },
      body,
    );
    await response.body?.cancel();
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const response = await this.send("delete", this.objectUrl(bucket, key), "DELETE");
    await response.body?.cancel();
  }

  /**
   * Presigned GET URL, valid for `expiresSeconds` (clamped to 1 s – 7 days).
   * The URL is a bearer credential: never log it.
   */
  async presignGet(
    bucket: string,
    key: string,
    expiresSeconds = MAX_PRESIGN_SECONDS,
  ): Promise<string> {
    const seconds = clampPresignSeconds(expiresSeconds);
    const url = new URL(this.objectUrl(bucket, key));
    url.searchParams.set("X-Amz-Expires", String(seconds));
    const signed = await this.signer(url.toString(), "GET", { signQuery: true }).sign();
    return signed.url.toString();
  }
}

/** Public URL of an object under an https base URL (custom domain or r2.dev), or undefined without one. */
export function publicObjectUrl(
  publicBaseUrl: string | undefined,
  key: string,
): string | undefined {
  if (!publicBaseUrl) return undefined;
  return `${publicBaseUrl.replace(/\/+$/, "")}/${encodeKey(key)}`;
}
