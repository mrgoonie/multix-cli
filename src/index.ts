/**
 * Programmatic API — re-exports public surface for library consumers.
 */

import { type LoadEnvOptions, loadEnv as loadEnvWith } from "./core/env-loader.js";
import { isProjectEnvName } from "./project-env-names.js";

export * from "./core/index.js";
export { PROJECT_ENV_EXCLUDED, PROJECT_ENV_NAMES, isProjectEnvName } from "./project-env-names.js";

/**
 * Load .env files once (see src/core/env-loader.ts). With no argument a
 * project `.env` may only set the names multix reads (isProjectEnvName).
 * This local export takes precedence over the core `loadEnv` re-exported above.
 */
export function loadEnv(options: LoadEnvOptions = { isProjectEnvName }): void {
  loadEnvWith(options);
}
