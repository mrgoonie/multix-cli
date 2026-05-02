/**
 * Ping the Gemini models endpoint to verify the API key is valid.
 * Uses a short 10s timeout to avoid blocking check command.
 */

import { HttpError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export type PingStatus = "success" | "auth_error" | "network_error";

export interface PingResult {
  status: PingStatus;
  modelCount?: number;
  error?: string;
}

/** Ping the Gemini API; distinguish auth failures from network errors. */
export async function pingGemini(apiKey: string): Promise<PingResult> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic API
    const resp = await httpJson<any>({
      url: `${MODELS_URL}?key=${encodeURIComponent(apiKey)}`,
      timeoutMs: 10_000,
    });
    const modelCount: number = Array.isArray(resp.models) ? resp.models.length : 0;
    return { status: "success", modelCount };
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 400 || e.status === 401 || e.status === 403) {
        return { status: "auth_error", error: `HTTP ${e.status}: ${e.snippet}` };
      }
      return { status: "network_error", error: `HTTP ${e.status}: ${e.snippet}` };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "network_error", error: msg };
  }
}
