/**
 * Programmatic API — re-exports public surface for library consumers.
 */

import { type LoadEnvOptions, loadEnv as loadEnvWith } from "./core/env-loader.js";
import { isProjectEnvName } from "./project-env-names.js";

// The core surface, named explicitly so the test-only `_reset*` helpers stay
// out of the published entry. `loadEnv` is defined below.
export {
  MultixError,
  ConfigError,
  ProviderError,
  ValidationError,
  HttpError,
  ok,
  err,
  isOk,
  isErr,
  resolveKey,
  redact,
  redactUrl,
  getOutputDir,
  parseJsonInput,
  httpJson,
  downloadFile,
  fetchBytes,
  fetchJson,
  parseRetryAfter,
  httpErrorFromResponse,
  pollUntil,
  isTransientHttpError,
  PollTimeoutError,
  createLogger,
  defaultLogger,
  detectThumbUrl,
  downloadThumbBeside,
  maybeDownloadThumb,
} from "./core/index.js";
export type {
  Result,
  OkResult,
  ErrResult,
  LoadEnvOptions,
  HttpJsonOptions,
  FetchJsonOptions,
  FetchLike,
  PollOptions,
  Logger,
} from "./core/index.js";
export { PROJECT_ENV_EXCLUDED, PROJECT_ENV_NAMES, isProjectEnvName } from "./project-env-names.js";

/**
 * Load .env files once (see src/core/env-loader.ts). With no argument a
 * project `.env` may only set the names multix reads (isProjectEnvName).
 */
export function loadEnv(options: LoadEnvOptions = { isProjectEnvName }): void {
  loadEnvWith(options);
}
