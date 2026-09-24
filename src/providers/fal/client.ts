/**
 * fal.ai queue API client — thin wrapper over multix core/http-client.
 * Auth: `Authorization: Key <FAL_KEY>` header.
 * Base URL: https://queue.fal.run/{model_id}[/...]
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { DEFAULT_FAL_BASE_URL } from "./models.js";

export function requireFalKey(): string {
  const key = resolveKey("FAL_KEY");
  if (!key) {
    throw new ConfigError("FAL_KEY is not set. Get one at https://fal.ai/dashboard/keys");
  }
  return key;
}

export function falBaseUrl(): string {
  return resolveKey("FAL_BASE_URL") ?? DEFAULT_FAL_BASE_URL;
}

export interface FalRequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  body?: unknown;
  timeoutMs?: number;
  logger?: Logger;
}

export class FalClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = falBaseUrl(),
  ) {}

  /** `path` is appended verbatim to the base queue URL, e.g. "/fal-ai/flux/schnell". */
  async request<T = unknown>(path: string, opts: FalRequestOptions = {}): Promise<T> {
    const base = this.baseUrl.replace(/\/$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const url = base + suffix;

    opts.logger?.debug(`${opts.method ?? "GET"} ${url}`);

    return httpJson<T>({
      url,
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        authorization: `Key ${this.apiKey}`,
      },
      body: opts.body as Record<string, unknown> | undefined,
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
  }

  get<T>(path: string, logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "GET", logger });
  }

  post<T>(path: string, body?: unknown, logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "POST", body, logger });
  }
}

/** Convenience: build a client from env. Throws ConfigError if no key. */
export function createFalClient(): FalClient {
  return new FalClient(requireFalKey(), falBaseUrl());
}

/** Submit a job to a fal model endpoint. Model id may include subpaths, e.g. "fal-ai/flux/schnell". */
export function submitPath(model: string): string {
  return `/${model.replace(/^\/+/, "")}`;
}

/** Status endpoint for a submitted request. */
export function statusPath(model: string, requestId: string): string {
  return `${submitPath(model)}/requests/${requestId}/status`;
}

/** Result endpoint for a completed request. */
export function resultPath(model: string, requestId: string): string {
  return `${submitPath(model)}/requests/${requestId}`;
}

/** Re-export HttpError for caller convenience. */
export { HttpError };
