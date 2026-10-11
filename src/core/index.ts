/**
 * Public API barrel for src/core — shared utilities used by all providers and commands.
 */

export { MultixError, ConfigError, ProviderError, ValidationError, HttpError } from "./errors.js";
export { ok, err, isOk, isErr } from "./result.js";
export type { Result, OkResult, ErrResult } from "./result.js";
export { loadEnv, resolveKey, _resetEnvLoader } from "./env-loader.js";
export { redact, redactUrl } from "./redact.js";
export { getOutputDir, _resetOutputDir } from "./output-dir.js";
export { parseJsonInput } from "./json-input.js";
export { httpJson, downloadFile, fetchBytes } from "./http-client.js";
export type { HttpJsonOptions } from "./http-client.js";
export { fetchJson, parseRetryAfter, httpErrorFromResponse } from "./fetch-json.js";
export type { FetchJsonOptions, FetchLike } from "./fetch-json.js";
export { pollUntil, isTransientHttpError, PollTimeoutError } from "./async-poll.js";
export type { PollOptions } from "./async-poll.js";
export { createLogger, defaultLogger } from "./logger.js";
export type { Logger } from "./logger.js";
export { detectThumbUrl, downloadThumbBeside, maybeDownloadThumb } from "./video-thumb.js";
