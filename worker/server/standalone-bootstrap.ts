/**
 * First boot of a self-hosted server with local sign-in (MULTIX_LOCAL_AUTH=true):
 * until the bootstrap admin exists, the server needs a single-use bootstrap
 * token for /dashboard/setup. An operator may supply MULTIX_BOOTSTRAP_TOKEN
 * (a secret, 32+ characters). Without it, each start generates a fresh
 * random token, stores only its SHA-256 hash, and prints the token once to
 * stdout for the operator (container logs). The token stops working when the
 * admin is created (the hash is deleted) or the next start replaces it.
 */

import { randomBytes } from "node:crypto";
import {
  MIN_BOOTSTRAP_TOKEN_LENGTH,
  isBootstrapDone,
  localAuthEnabled,
  storeBootstrapTokenHash,
} from "../src/accounts/local-auth.js";
import type { WorkerEnv } from "../src/config.js";
import { logEvent } from "../src/redaction.js";

export type BootstrapState = "disabled" | "done" | "env_token" | "generated";

export async function prepareBootstrap(
  env: WorkerEnv,
  print: (line: string) => void,
): Promise<BootstrapState> {
  if (!localAuthEnabled(env)) return "disabled";
  if (await isBootstrapDone(env.ACCOUNTS_KV)) return "done";
  const origin = env.MULTIX_PUBLIC_URL?.replace(/\/+$/, "") ?? "";
  const configured = env.MULTIX_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (configured.length >= MIN_BOOTSTRAP_TOKEN_LENGTH) {
    logEvent("info", "bootstrap_pending", { token_source: "env" });
    print(
      `multix-server: no admin yet. Open ${origin}/dashboard/setup with the MULTIX_BOOTSTRAP_TOKEN secret.`,
    );
    return "env_token";
  }
  if (configured) {
    logEvent("warn", "bootstrap_token_too_short", { min_length: MIN_BOOTSTRAP_TOKEN_LENGTH });
  }
  const token = randomBytes(32).toString("base64url");
  await storeBootstrapTokenHash(env.ACCOUNTS_KV, token);
  logEvent("info", "bootstrap_pending", { token_source: "generated" });
  print("=".repeat(72));
  print("multix-server: no admin account yet. Create it once at:");
  print(`  ${origin}/dashboard/setup`);
  print(`  bootstrap token (single use, replaced at the next start): ${token}`);
  print("=".repeat(72));
  return "generated";
}
