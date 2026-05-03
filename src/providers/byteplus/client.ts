/**
 * BytePlus ModelArk API client — thin wrapper over multix core/http-client.
 * Auth: Bearer token via BYTEPLUS_API_KEY (primary) or ARK_API_KEY (fallback).
 * Base URL override via BYTEPLUS_BASE_URL.
 */

import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, HttpError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { DEFAULT_BYTEPLUS_BASE_URL } from "./models.js";

export function requireBytePlusKey(): string {
  const key = resolveKey("BYTEPLUS_API_KEY") ?? resolveKey("ARK_API_KEY");
  if (!key) {
    throw new ConfigError(
      "BytePlus API key not set. Set BYTEPLUS_API_KEY or ARK_API_KEY. Get one at https://console.byteplus.com/auth/api-keys",
    );
  }
  return key;
}

export function bytePlusBaseUrl(): string {
  return resolveKey("BYTEPLUS_BASE_URL") ?? DEFAULT_BYTEPLUS_BASE_URL;
}

export interface BytePlusRequestOptions {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  logger?: Logger;
}

export class BytePlusClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = bytePlusBaseUrl(),
  ) {}

  async request<T = unknown>(path: string, opts: BytePlusRequestOptions = {}): Promise<T> {
    const base = this.baseUrl.replace(/\/$/, "");
    const url = new URL(base + path);
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

  get<T>(path: string, query?: BytePlusRequestOptions["query"], logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "GET", query, logger });
  }

  post<T>(path: string, body?: unknown, logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "POST", body, logger });
  }

  delete<T>(path: string, logger?: Logger): Promise<T> {
    return this.request<T>(path, { method: "DELETE", logger });
  }
}

export function createBytePlusClient(): BytePlusClient {
  return new BytePlusClient(requireBytePlusKey(), bytePlusBaseUrl());
}

export { HttpError };
