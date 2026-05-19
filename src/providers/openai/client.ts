import fs from "node:fs";
import path from "node:path";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError, ValidationError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import { OPENAI_BASE_URL } from "./models.js";

const DEFAULT_TIMEOUT_MS = 240_000;

export function requireOpenAIKey(): string {
  const key = resolveKey("OPENAI_API_KEY");
  if (!key) {
    throw new ConfigError(
      "OPENAI_API_KEY is not set. Get one at https://platform.openai.com/api-keys",
    );
  }
  return key;
}

function endpoint(pathname: string): string {
  return `${OPENAI_BASE_URL}/${pathname.replace(/^\//, "")}`;
}

function authHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...(extra ?? {}) };
}

export function postOpenAIJson<T>(
  pathname: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return httpJson<T>({
    url: endpoint(pathname),
    method: "POST",
    headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
    body,
    timeoutMs,
  });
}

export async function postOpenAIForm<T>(
  pathname: string,
  form: FormData,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = endpoint(pathname);
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new HttpError(0, cause instanceof Error ? cause.message : String(cause), url);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, text.slice(0, 500), url);
  }
  return res.json() as Promise<T>;
}

export async function postOpenAIBinary(
  pathname: string,
  body: Record<string, unknown>,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Buffer> {
  const url = endpoint(pathname);
  let res: Response;
  try {
    res = await globalThis.fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new HttpError(0, cause instanceof Error ? cause.message : String(cause), url);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, text.slice(0, 500), url);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function fileFromPath(filePath: string): File {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new ValidationError(`File not found: ${abs}`);
  const bytes = fs.readFileSync(abs);
  return new File([new Uint8Array(bytes)], path.basename(abs));
}
