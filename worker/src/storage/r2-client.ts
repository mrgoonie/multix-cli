/**
 * Minimal Cloudflare R2 client over the S3 API, signed with aws4fetch.
 *
 * Runtime-neutral: no `node:*` imports and fetch is injected, so the same
 * module runs in the Worker (dashboard credential check, presigned links) and
 * in Node 20+ (uploading job outputs). Path-style URLs on
 * `https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`.
 *
 * Errors carry the HTTP status and the S3 error code only, never the request
 * URL (presigned or not), headers or credentials.
 */

import { AwsV4Signer } from "aws4fetch";
import type { FetchLike } from "../../../src/core/fetch-json.js";

/** Longest lifetime R2 accepts for a presigned URL (7 days). */
export const MAX_PRESIGN_SECONDS = 604_800;
/** Longest object key R2 accepts, in UTF-8 bytes. */
export const MAX_KEY_BYTES = 1024;

export const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
/** R2 bucket names: 3–63 chars of lower-case letters, digits and hyphens, not starting or ending with a hyphen. */
export const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export interface R2Credentials {
  /** Cloudflare account id (32 lower-case hex characters). */
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
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
    /** HTTP status, or 0 when R2 could not be reached. */
    readonly status: number,
    /** S3 error code from the response body, e.g. `NoSuchBucket`. */
    readonly code?: string,
  ) {
    super(
      status === 0
        ? `R2 ${operation} failed: R2 could not be reached`
        : `R2 ${operation} failed: HTTP ${status}${code ? ` ${code}` : ""}`,
    );
    this.name = "R2RequestError";
  }
}

const encoder = new TextEncoder();

function assertBucket(bucket: string): void {
  if (!BUCKET_RE.test(bucket)) throw new Error("Invalid R2 bucket name");
}

function encodeKey(key: string): string {
  const bytes = encoder.encode(key).byteLength;
  if (bytes === 0 || bytes > MAX_KEY_BYTES || key.startsWith("/")) {
    throw new Error("Invalid R2 object key");
  }
  return key.split("/").map(encodeURIComponent).join("/");
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.text().catch(() => "");
  return /<Code>([A-Za-z]{1,64})<\/Code>/.exec(body)?.[1];
}

export class R2Client {
  private readonly endpoint: string;
  private readonly doFetch: FetchLike;

  constructor(private readonly options: R2ClientOptions) {
    if (!ACCOUNT_ID_RE.test(options.accountId)) throw new Error("Invalid R2 account id");
    this.endpoint = `https://${options.accountId}.r2.cloudflarestorage.com`;
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Unsigned path-style object URL on the S3 API host. */
  objectUrl(bucket: string, key: string): string {
    assertBucket(bucket);
    return `${this.endpoint}/${bucket}/${encodeKey(key)}`;
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
      region: "auto",
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
    const init: RequestInit = { method, headers: signed.headers, body };
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
    assertBucket(bucket);
    const response = await this.send(
      "list",
      `${this.endpoint}/${bucket}?list-type=2&max-keys=1`,
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
    const requested = Number.isFinite(expiresSeconds)
      ? Math.floor(expiresSeconds)
      : MAX_PRESIGN_SECONDS;
    const seconds = Math.min(Math.max(requested, 1), MAX_PRESIGN_SECONDS);
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
