/**
 * Public API barrel for src/core — shared utilities used by all providers and commands.
 */

export { MultixError, ConfigError, ProviderError, ValidationError, HttpError } from "./errors.js";
export { ok, err, isOk, isErr } from "./result.js";
export type { Result, OkResult, ErrResult } from "./result.js";
export { loadEnv, resolveKey, redact, _resetEnvLoader } from "./env-loader.js";
export { getOutputDir, _resetOutputDir } from "./output-dir.js";
export { httpJson, downloadFile, fetchBytes } from "./http-client.js";
export type { HttpJsonOptions } from "./http-client.js";
export { createLogger, defaultLogger } from "./logger.js";
export type { Logger } from "./logger.js";
