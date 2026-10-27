/**
 * Bounded reads of a fetch Response for paid requests, and the connection
 * error codes that prove a request never left (runtime-neutral: no `node:*`
 * imports). A paid POST is never retried, so callers use these to tell "not
 * sent" apart from "may have been accepted and billed".
 */

import { ResponseTooLargeError } from "./errors.js";

/** Connection failures that prove the request never reached the provider. */
export const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]);

/** Error code of a request whose outcome (and billing) is unknown. */
export const UNKNOWN_REMOTE_STATE = "UNKNOWN_REMOTE_STATE";

export function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk.subarray(0, size - offset), offset);
    offset += chunk.byteLength;
    if (offset >= size) break;
  }
  return out;
}

/** Read at most `limit` bytes of a body as text (error bodies are small JSON). */
export async function readCappedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= limit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    return "(could not read body)";
  }
  return new TextDecoder().decode(concatBytes(chunks, size).subarray(0, limit));
}

/** Error codes of an error and its causes (undici nests them). */
export function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === "string") codes.push(e.code);
    if (Array.isArray(e.errors)) {
      for (const m of e.errors) {
        const code = (m as { code?: unknown } | null)?.code;
        if (typeof code === "string") codes.push(code);
      }
    }
    current = e.cause;
  }
  return codes;
}

/** Read a binary body under a byte cap and an idle timeout (no bytes for `idleTimeoutMs`). */
export async function readCappedBytes(
  response: Response,
  maxBytes: number,
  idleTimeoutMs: number,
  url: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes, url);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no audio bytes for ${Math.round(idleTimeoutMs / 1000)} s`)),
        idleTimeoutMs,
      );
    });
    let step: Awaited<ReturnType<typeof reader.read>>;
    try {
      step = await Promise.race([reader.read(), idle]);
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (step.done) break;
    size += step.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes, url);
    }
    chunks.push(step.value);
  }
  return concatBytes(chunks, size);
}
