/**
 * Leonardo.Ai API client — thin wrapper over multix core/http-client.
 * Auth: Bearer token via LEONARDO_API_KEY.
 * Routes prefixed with `v2:/` swap the v1 base for v2 (e.g. /api/rest/v2).
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { DEFAULT_LEONARDO_BASE_URL } from "./models.js";

export function requireLeonardoKey(): string {
  const key = resolveKey("LEONARDO_API_KEY");
  if (!key) {
    throw new ConfigError(
      "LEONARDO_API_KEY is not set. Get one at https://app.leonardo.ai/settings/api-keys",
    );
  }
  return key;
}

export function leonardoBaseUrl(): string {
  return resolveKey("LEONARDO_BASE_URL") ?? DEFAULT_LEONARDO_BASE_URL;
}

export interface LeonardoRequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  logger?: Logger;
}

export class LeonardoClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = leonardoBaseUrl(),
  ) {}

  async request<T = unknown>(path: string, opts: LeonardoRequestOptions = {}): Promise<T> {
    const base = this.baseUrl.replace(/\/$/, "");
    const v2Override = path.startsWith("v2:");
    const finalBase = v2Override ? base.replace(/\/v1$/, "/v2") : base;
    const finalPath = v2Override ? path.slice(3) : path;
    const url = new URL(finalBase + finalPath);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    opts.logger?.debug(`${opts.method ?? "GET"} ${url.toString()}`);

    return httpJson<T>({
      url: url.toString(),
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: opts.body as Record<string, unknown> | undefined,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  get<T>(path: string, query?: LeonardoRequestOptions["query"], logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "GET", query, logger });
  }

  post<T>(path: string, body?: unknown, logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "POST", body, logger });
  }

  delete<T>(path: string, logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "DELETE", logger });
  }
}

/** Convenience: build a client from env. Throws ConfigError if no key. */
export function createLeonardoClient(): LeonardoClient {
  return new LeonardoClient(requireLeonardoKey(), leonardoBaseUrl());
}

/** Re-export HttpError for caller convenience. */
export { HttpError };
