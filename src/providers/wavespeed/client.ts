import { resolveProviderBaseUrl, resolveRoutedKey } from "../../core/env-loader.js";
import {
  ConfigError,
  HttpError,
  MultixError,
  ProviderError,
  ProviderJobFailedError,
} from "../../core/errors.js";
/** Runtime-neutral WaveSpeedAI REST client; never retries paid POST submissions. */
import { fetchJson } from "../../core/fetch-json.js";
import { checkUrlSafety } from "../../core/url-safety.js";
import { WAVESPEED_ROUTING, validateWaveModelId } from "./models.js";

export interface WavePrediction {
  id: string;
  model?: string;
  status: string;
  outputs?: unknown[];
  error?: string | null;
  cost?: unknown;
  price?: unknown;
  timings?: unknown;
}
interface WaveEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}
interface WaveUploadTicket {
  download_url: string;
  upload: { url: string; method?: string; headers?: Record<string, string> };
}

export class WaveSpeedClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = WAVESPEED_ROUTING.defaultUrl,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    if (!apiKey.trim()) throw new ConfigError("WAVESPEED_API_KEY is not set");
  }

  private async request<T>(suffix: string, method: "GET" | "POST", body?: object): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
    const res = await fetchJson<WaveEnvelope<T>>({
      url,
      method,
      body,
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      fetch: this.fetcher,
      timeoutMs: 60_000,
      maxBytes: 2 * 1024 * 1024,
    });
    if (!res || res.code !== 200 || res.data === undefined) {
      throw new ProviderError(
        `WaveSpeedAI API error: ${String(res?.message ?? "invalid response")}`,
        "wavespeed",
      );
    }
    return res.data;
  }

  /** POST exactly once: an ambiguous network failure may already have incurred a charge. */
  async submit(model: string, input: Record<string, unknown>): Promise<WavePrediction> {
    validateWaveModelId(model);
    let data: WavePrediction;
    try {
      data = await this.request<WavePrediction>(model, "POST", input);
    } catch (error) {
      if (
        error instanceof HttpError &&
        (error.status === 0 || error.status >= 500 || (error.status >= 200 && error.status < 300))
      ) {
        throw new MultixError(
          "WaveSpeedAI submit status unknown. It may have charged a job; check prediction history before retrying.",
          "UNKNOWN_REMOTE_STATE",
          { cause: error },
        );
      }
      throw error;
    }
    if (typeof data?.id !== "string" || !/^[a-zA-Z0-9_-]{1,150}$/.test(data.id)) {
      throw new MultixError(
        "WaveSpeedAI accepted submit without a valid prediction ID; check history before retrying.",
        "UNKNOWN_REMOTE_STATE",
      );
    }
    return data;
  }

  async result(id: string): Promise<WavePrediction> {
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id))
      throw new ProviderError("Invalid prediction ID", "wavespeed");
    return this.request<WavePrediction>(`predictions/${id}/result`, "GET");
  }

  async wait(
    id: string,
    options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<WavePrediction> {
    const timeoutMs = options.timeoutMs ?? 900_000;
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const started = Date.now();
    let pause = Math.max(2000, options.pollMs ?? 2000);
    while (Date.now() - started < timeoutMs) {
      let prediction: WavePrediction;
      try {
        prediction = await this.result(id);
      } catch (err) {
        if (!(err instanceof HttpError) || ![0, 429, 500, 502, 503, 504].includes(err.status))
          throw err;
        await sleep(Math.min(10000, Math.max(pause, err.retryAfterMs ?? 0)));
        pause = Math.min(10000, pause + 1000);
        continue;
      }
      if (prediction.status === "completed") return prediction;
      if (["failed", "cancelled", "timeout", "deleted"].includes(prediction.status)) {
        throw new ProviderJobFailedError(
          `WaveSpeedAI prediction ${id} ended: ${prediction.status}${prediction.error ? ` (${prediction.error})` : ""}`,
          "wavespeed",
          { terminal: prediction.status === "failed" },
        );
      }
      await sleep(pause);
      pause = Math.min(10000, pause + 1000);
    }
    throw new MultixError(
      `WaveSpeedAI job ${id} still running; resume with multix wavespeed status ${id} --wait`,
      "POLL_TIMEOUT",
    );
  }

  async uploadTicket(
    filename: string,
    size: number,
    contentType?: string,
  ): Promise<WaveUploadTicket> {
    return this.request<WaveUploadTicket>("media/uploads", "POST", {
      filename,
      size,
      ...(contentType ? { content_type: contentType } : {}),
    });
  }

  /** Upload target is a temporary credential. NEVER forward our API key to it. */
  async uploadBytes(ticket: WaveUploadTicket, body: Uint8Array): Promise<string> {
    const url = new URL(ticket?.upload?.url ?? "");
    if (url.protocol !== "https:" || url.username || url.password)
      throw new ProviderError("Untrusted WaveSpeedAI upload ticket", "wavespeed");
    checkUrlSafety(url.toString(), { provider: "wavespeed", action: "upload to" });
    const headers = Object.fromEntries(
      Object.entries(ticket.upload.headers ?? {}).filter(
        ([name]) => name.toLowerCase() !== "authorization",
      ),
    );
    const response = await this.fetcher(url, {
      method: ticket.upload.method ?? "PUT",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new ProviderError(
        `WaveSpeedAI upload failed with HTTP ${response.status}`,
        "wavespeed",
      );
    if (!/^https:\/\//.test(ticket.download_url))
      throw new ProviderError("Invalid WaveSpeedAI upload download URL", "wavespeed");
    checkUrlSafety(ticket.download_url, { provider: "wavespeed", action: "fetch" });
    return ticket.download_url;
  }
}

export function createWaveSpeedClient(): WaveSpeedClient {
  const key = resolveRoutedKey(WAVESPEED_ROUTING);
  if (!key)
    throw new ConfigError(
      "WAVESPEED_API_KEY is not set. Get one at https://wavespeed.ai/accesskey",
    );
  return new WaveSpeedClient(key, resolveProviderBaseUrl(WAVESPEED_ROUTING));
}

export function waveOutputUrls(result: WavePrediction): string[] {
  return (result.outputs ?? []).flatMap((item) => {
    if (typeof item === "string" && /^https:\/\//.test(item)) return [item];
    if (
      item &&
      typeof item === "object" &&
      "url" in item &&
      typeof item.url === "string" &&
      /^https:\/\//.test(item.url)
    )
      return [item.url];
    return [];
  });
}
