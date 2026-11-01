/**
 * Smoke-test a running multix-server (e.g. the Docker image) over HTTP:
 *
 *   MULTIX_SMOKE_URL=http://localhost:3000 \
 *   MULTIX_SMOKE_USERNAME=admin MULTIX_SMOKE_PASSWORD=… \
 *   MULTIX_SMOKE_BOOTSTRAP_TOKEN=… npm run smoke:server
 *
 * The bootstrap token is needed only on first boot (setup still open).
 * Calls only multix_catalog: no provider is contacted and nothing is billed.
 */

import { runSmoke } from "../server/smoke-flow.js";

const baseUrl = process.env.MULTIX_SMOKE_URL ?? "http://localhost:3000";
const username = process.env.MULTIX_SMOKE_USERNAME ?? "admin";
const password = process.env.MULTIX_SMOKE_PASSWORD ?? "";
if (password.length < 12) {
  console.error("Set MULTIX_SMOKE_PASSWORD (12+ characters).");
  process.exit(2);
}

try {
  const result = await runSmoke({
    baseUrl,
    username,
    password,
    bootstrapToken: process.env.MULTIX_SMOKE_BOOTSTRAP_TOKEN,
    log: (line) => console.log(`smoke: ${line}`),
  });
  console.log(`smoke: passed (${result.createdAdmin ? "admin created" : "signed in"})`);
} catch (error) {
  console.error(`smoke: FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
