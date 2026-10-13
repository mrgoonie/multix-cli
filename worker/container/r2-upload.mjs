/**
 * Upload job outputs to the caller's R2 bucket over the S3 API (aws4fetch),
 * mirroring worker/src/storage/r2-client.ts: path-style URLs on
 * https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>, presigned GET
 * links valid for 7 days when the bucket has no public base URL.
 *
 * Bodies are streamed, never buffered: the request is signed with
 * `x-amz-content-sha256: UNSIGNED-PAYLOAD` (aws4fetch's default for s3), so the
 * body does not need to be hashed up front.
 *
 * Errors carry the HTTP status and S3 error code only, never a URL (presigned
 * or not), header or credential.
 */

import { AwsV4Signer } from "aws4fetch";

export const MAX_PRESIGN_SECONDS = 604_800;
const MAX_KEY_BYTES = 1024;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

export class R2UploadError extends Error {
  constructor(status, code) {
    super(
      status === 0
        ? "R2 upload failed: R2 could not be reached"
        : `R2 upload failed: HTTP ${status}${code ? ` ${code}` : ""}`,
    );
    this.name = "R2UploadError";
  }
}

/**
 * Safe object name for an output file: its base name with control characters
 * removed. Empty, "." and ".." are rejected, because URL parsing collapses dot
 * segments and could move the key out of the job's prefix (or the bucket).
 */
export function safeOutputName(fileName) {
  const base = String(fileName).split(/[\\/]/).pop() ?? "";
  const name = base.replace(CONTROL_RE, "").trim();
  if (name === "" || name === "." || name === "..") return undefined;
  return name.slice(-200);
}

/** encodeURIComponent plus the characters it leaves alone that S3 signing treats specially. */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode an object key, refusing empty, "." and ".." segments. */
export function encodeKey(key) {
  const segments = key.split("/");
  const bytes = new TextEncoder().encode(key).byteLength;
  if (bytes === 0 || bytes > MAX_KEY_BYTES) throw new Error("Invalid R2 object key");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error("Invalid R2 object key");
  }
  return segments.map(encodeSegment).join("/");
}

function errorCode(body) {
  return /<Code>([A-Za-z]{1,64})<\/Code>/.exec(body)?.[1];
}

/**
 * @param {{ accountId: string, accessKeyId: string, secretAccessKey: string, bucket: string, publicBaseUrl?: string }} r2
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createR2Uploader(r2, options = {}) {
  if (!ACCOUNT_ID_RE.test(r2.accountId)) throw new Error("Invalid R2 account id");
  if (!BUCKET_RE.test(r2.bucket)) throw new Error("Invalid R2 bucket name");
  const doFetch = options.fetch ?? globalThis.fetch;
  const endpoint = `https://${r2.accountId}.r2.cloudflarestorage.com`;
  const objectUrl = (key) => `${endpoint}/${r2.bucket}/${encodeKey(key)}`;
  const signer = (url, method, extra = {}) =>
    new AwsV4Signer({
      url,
      method,
      ...extra,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      service: "s3",
      region: "auto",
    });

  return {
    /**
     * PUT one object; returns the URL to hand back (public, or presigned for 7 days).
     * @param {string} key
     * @param {ReadableStream | Uint8Array | string} body streamed as is
     * @param {string} contentType
     * @param {{ contentLength?: number, signal?: AbortSignal }} [put]
     */
    async put(key, body, contentType, put = {}) {
      const headers = {
        "content-type": contentType,
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      };
      const signed = await signer(objectUrl(key), "PUT", { headers }).sign();
      const sendHeaders = new Headers(signed.headers);
      if (put.contentLength !== undefined) {
        sendHeaders.set("content-length", String(put.contentLength));
      }
      const signals = [AbortSignal.timeout(options.timeoutMs ?? 300_000)];
      if (put.signal) signals.push(put.signal);
      let response;
      try {
        response = await doFetch(signed.url.toString(), {
          method: "PUT",
          headers: sendHeaders,
          body,
          duplex: "half",
          signal: AbortSignal.any(signals),
        });
      } catch {
        if (put.signal?.aborted) throw put.signal.reason ?? new Error("aborted");
        throw new R2UploadError(0);
      }
      const text = await response.text().catch(() => "");
      if (!response.ok) throw new R2UploadError(response.status, errorCode(text));
      return this.url(key);
    },

    async url(key) {
      if (r2.publicBaseUrl) return `${r2.publicBaseUrl.replace(/\/+$/, "")}/${encodeKey(key)}`;
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", String(MAX_PRESIGN_SECONDS));
      const signed = await signer(url.toString(), "GET", { signQuery: true }).sign();
      return signed.url.toString();
    },
  };
}
