/**
 * fal.ai queue API client — thin wrapper over multix core/http-client.
 * Auth: `Authorization: Key <FAL_KEY>` header.
 * Base URL: https://queue.fal.run/{model_id}[/...]
 *
 * The queue's status/result URLs are keyed by "app id" — only the first two
 * path segments of a model id (owner/alias), NOT the full endpoint id. e.g.
 * for "fal-ai/kling-video/v1.6/standard/text-to-video" the app id is
 * "fal-ai/kling-video". This matches fal-js's queue client (parseEndpointId +
 * buildUrl use only owner/alias for status and result URLs). The submit
 * response's own `status_url`/`response_url` already encode this correctly,
 * so submitAndWait uses those directly instead of reconstructing them; the
 * standalone `status`/`result` commands (given only a model id) derive the
 * app id themselves via `appIdFromModel`.
 */

import { resolveProviderBaseUrl, resolveRoutedKey } from "../../core/env-loader.js";
import { ProviderError, ValidationError } from "../../core/errors.js";
import { ConfigError, HttpError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { redactUrl } from "../../core/redact.js";
import { FAL_ROUTING } from "./models.js";

/**
 * fal's documented queue host. Submit responses point `status_url` /
 * `response_url` here, so it stays trusted even when FAL_BASE_URL is a proxy.
 * Kept to this exact host on https with the default port (no wildcard
 * subdomains): it is the only host the queue API uses today.
 */
export const FAL_QUEUE_HOST = "queue.fal.run";

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Lowercased hostname without a trailing dot (IPv6 keeps its brackets). */
function normalizedHost(u: URL): string {
  return u.hostname.toLowerCase().replace(/\.$/, "");
}

/** Scheme, host and port, with the default port elided by the URL parser. */
function normalizedOrigin(u: URL): string {
  return `${u.protocol}//${normalizedHost(u)}:${u.port}`;
}

/**
 * Throws a ProviderError unless `url` may receive the fal key. Two cases are
 * trusted:
 * - the same origin (scheme, host, port) as FAL_BASE_URL — the key already
 *   goes there on submit, and which base URLs are accepted (https, or http to
 *   loopback; project-file trust) is decided by `resolveProviderBaseUrl`;
 * - https on exactly {@link FAL_QUEUE_HOST} with the default port.
 * Messages name the host only, never the path, query string or key.
 */
export function assertTrustedFalUrl(url: string, baseUrl: string): void {
  const target = parseUrl(url);
  if (!target) {
    throw new ProviderError("Refusing to send the fal key to a malformed URL", "fal");
  }
  const base = parseUrl(baseUrl);
  if (base && normalizedOrigin(target) === normalizedOrigin(base)) return;
  const host = normalizedHost(target);
  if (target.protocol === "https:" && host === FAL_QUEUE_HOST && target.port === "") return;
  throw new ProviderError(
    `Refusing to send the fal key to ${host || "this URL"}: not https://${FAL_QUEUE_HOST} or the FAL_BASE_URL origin`,
    "fal",
  );
}

export function requireFalKey(): string {
  const key = resolveRoutedKey(FAL_ROUTING);
  if (!key) {
    throw new ConfigError("FAL_KEY is not set. Get one at https://fal.ai/dashboard/keys");
  }
  return key;
}

export function falBaseUrl(): string {
  return resolveProviderBaseUrl(FAL_ROUTING);
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
    return this.send<T>(base + suffix, opts);
  }

  /**
   * Same auth/headers as `request`, but `url` is used verbatim (e.g. a
   * status_url/response_url returned by submit). The URL must pass
   * {@link assertTrustedFalUrl} before the key is sent.
   */
  async requestAbsolute<T = unknown>(url: string, opts: FalRequestOptions = {}): Promise<T> {
    assertTrustedFalUrl(url, this.baseUrl);
    return this.send<T>(url, opts);
  }

  /** Throws a ProviderError when `url` may not receive the key (see {@link assertTrustedFalUrl}). */
  assertTrustedUrl(url: string): void {
    assertTrustedFalUrl(url, this.baseUrl);
  }

  private async send<T>(url: string, opts: FalRequestOptions): Promise<T> {
    opts.logger?.debug(`${opts.method ?? "GET"} ${redactUrl(url)}`);

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

  getAbsolute<T>(url: string, logger?: Logger): Promise<T> {
    return this.requestAbsolute<T>(url, { method: "GET", logger });
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

/**
 * The queue "app id" for a model: its first two path segments (owner/alias).
 * Status and result URLs are keyed by this, regardless of how many extra
 * segments the model id itself has.
 */
export function appIdFromModel(model: string): string {
  const segments = model.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2 || !segments[0] || !segments[1]) {
    throw new ValidationError(
      `Invalid fal model id "${model}" — expected at least "owner/alias" (e.g. fal-ai/flux)`,
    );
  }
  return `${segments[0]}/${segments[1]}`;
}

/** Status endpoint for a submitted request, derived from the model's app id. */
export function statusPath(model: string, requestId: string): string {
  return `/${appIdFromModel(model)}/requests/${requestId}/status`;
}

/** Result endpoint for a completed request, derived from the model's app id. */
export function resultPath(model: string, requestId: string): string {
  return `/${appIdFromModel(model)}/requests/${requestId}`;
}

/** Re-export HttpError for caller convenience. */
export { HttpError };
