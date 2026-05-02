/**
 * MiniMax API client — HTTP utilities for all MiniMax generation tasks.
 * Base URL: https://api.minimax.io/v1
 * Auth: Bearer token via MINIMAX_API_KEY.
 * Mirrors minimax_api_client.py exactly.
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, ProviderError } from "../../core/errors.js";
import { downloadFile as coreDownload, httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";

export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

/** Resolve and validate MINIMAX_API_KEY. */
export function requireMinimaxKey(): string {
  const key = resolveKey("MINIMAX_API_KEY");
  if (!key) {
    throw new ConfigError(
      "MINIMAX_API_KEY is not set. Get one at https://platform.minimax.io/user-center/basic-information/interface-key",
    );
  }
  return key;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

interface MinimaxBaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

/** POST to a MiniMax endpoint. Throws ProviderError on non-zero status. */
export async function apiPost<T extends MinimaxBaseResp>(
  endpoint: string,
  payload: Record<string, unknown>,
  apiKey: string,
  opts: { timeoutMs?: number; logger?: Logger } = {},
): Promise<T> {
  const url = `${MINIMAX_BASE_URL}/${endpoint}`;
  opts.logger?.debug(`POST ${url}`);

  const data = await httpJson<T>({
    url,
    method: "POST",
    headers: authHeaders(apiKey),
    body: payload,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });

  const baseResp = data.base_resp;
  if (baseResp && baseResp.status_code !== 0) {
    throw new ProviderError(
      `MiniMax API error (code ${baseResp.status_code}): ${baseResp.status_msg ?? "unknown"}`,
      "minimax",
    );
  }

  return data;
}

/** GET from a MiniMax endpoint. */
export async function apiGet<T>(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<T> {
  const url = new URL(`${MINIMAX_BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  return httpJson<T>({ url: url.toString(), headers: authHeaders(apiKey) });
}

export interface PollResult {
  status: string;
  file_id?: string;
  [key: string]: unknown;
}

/**
 * Poll an async MiniMax task until Success/Failed/Error or timeout.
 * Mirrors poll_async_task in Python source.
 */
export async function pollAsyncTask(
  taskId: string,
  taskType: "video_generation" | "music_generation",
  apiKey: string,
  opts: { intervalMs?: number; timeoutMs?: number; logger?: Logger } = {},
): Promise<PollResult> {
  const { intervalMs = 10_000, timeoutMs = 600_000, logger } = opts;
  const deadline = Date.now() + timeoutMs;
  let elapsed = 0;

  while (Date.now() < deadline) {
    const result = await apiGet<PollResult>(`query/${taskType}`, { task_id: taskId }, apiKey);

    const status = result.status ?? "Unknown";
    if (elapsed > 0 && elapsed % 30_000 < intervalMs) {
      logger?.debug(`Polling... ${Math.round(elapsed / 1000)}s elapsed, status: ${status}`);
    }

    if (status === "Success") return result;
    if (status === "Failed" || status === "Error") {
      throw new ProviderError(`Task ${taskId} failed: ${JSON.stringify(result)}`, "minimax");
    }

    await sleep(intervalMs);
    elapsed += intervalMs;
  }

  throw new ProviderError(`Task ${taskId} timed out after ${timeoutMs / 1000}s`, "minimax");
}

/**
 * Retrieve file download URL from MiniMax file service and stream to dest.
 */
export async function downloadMinimaxFile(
  fileId: string,
  apiKey: string,
  dest: string,
  logger?: Logger,
): Promise<string> {
  const result = await apiGet<{ file?: { download_url?: string } }>(
    "files/retrieve",
    { file_id: fileId },
    apiKey,
  );

  const downloadUrl = result.file?.download_url;
  if (!downloadUrl) {
    throw new ProviderError(`No download URL for file ${fileId}`, "minimax");
  }

  logger?.debug(`Downloading to: ${dest}`);
  await coreDownload(downloadUrl, dest);
  return dest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
