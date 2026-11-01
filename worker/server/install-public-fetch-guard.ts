/**
 * Imported first by multix-server.ts, so the public-only fetch is installed
 * before any Worker module is evaluated (workers-oauth-provider checks the
 * `global_fetch_strictly_public` flag when its module loads).
 */
import { installPublicFetchGuard } from "./public-fetch-guard.js";

installPublicFetchGuard();
