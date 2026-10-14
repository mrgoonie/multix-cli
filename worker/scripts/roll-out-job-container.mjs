#!/usr/bin/env node
/**
 * Roll out a new job container image BEFORE the Worker that uses it.
 *
 * `wrangler deploy` activates the new Worker first and only then starts a
 * gradual container rollout, so for a minute or two a new Worker can send jobs
 * to old containers. Running this first means the Worker is only deployed once
 * every container instance runs the new image. The image must therefore keep
 * accepting the job spec of the Worker that is still live (see AGENTS.md).
 *
 * Steps, using the same Containers API calls wrangler makes:
 *   1. docker build with wrangler's flags (so the later `wrangler deploy` build is
 *      a cache hit and usually finds nothing to change) and push to the
 *      Cloudflare registry with `wrangler containers push`;
 *   2. PATCH the container application's configuration to the new image digest
 *      and start a rolling rollout;
 *   3. wait until the rollout completes; any other end state fails the job, so
 *      the Worker deploy step never runs.
 *
 * Usage (from worker/): node scripts/roll-out-job-container.mjs
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; optional IMAGE_TAG (default: git HEAD).
 * Never prints the token.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** `<worker name>-<container class name in lower case>`, the name wrangler gives the application. */
const APP_NAME = "multix-mcp-multixjobcontainer";
const DOCKERFILE = resolve(WORKER_DIR, "container/Dockerfile");
/** wrangler.jsonc image_build_context, relative to worker/. */
const BUILD_CONTEXT = resolve(WORKER_DIR, "..");
/** Same steps wrangler uses for this application (10% of instances, then all). */
const ROLLOUT_STEPS = [10, 100];
const POLL_MS = 10_000;
const ROLLOUT_TIMEOUT_MS = 20 * 60_000;

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  process.exit(1);
}
const API = `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers`;

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    ...options,
  });
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok || json?.success === false) {
    throw new Error(
      `${method} ${path} -> ${response.status}: ${JSON.stringify(json?.errors ?? text).slice(0, 500)}`,
    );
  }
  return json?.result ?? json;
}

function buildAndPush() {
  const tag =
    process.env.IMAGE_TAG ||
    run("git", ["rev-parse", "--short=12", "HEAD"], { cwd: WORKER_DIR }).trim();
  const local = `${APP_NAME}:${tag}`;
  console.log(`Building ${local}`);
  // wrangler's build command (constructBuildCommand): Dockerfile on stdin, linux/amd64, no provenance.
  run(
    "docker",
    [
      "build",
      "--load",
      "-t",
      local,
      "--platform",
      "linux/amd64",
      "--provenance=false",
      "-f",
      "-",
      BUILD_CONTEXT,
    ],
    { input: readFileSync(DOCKERFILE), stdio: ["pipe", "inherit", "inherit"] },
  );
  console.log(`Pushing ${local}`);
  run("npx", ["wrangler", "containers", "push", local], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const digests = JSON.parse(
    run("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", local]),
  );
  const ref = digests.find((d) =>
    d.startsWith(`registry.cloudflare.com/${accountId}/${APP_NAME}@sha256:`),
  );
  if (!ref) throw new Error(`No Cloudflare registry digest for ${local} after the push`);
  return ref;
}

async function findApplication() {
  const apps = await api("GET", "/applications");
  const app = (Array.isArray(apps) ? apps : []).find((a) => a.name === APP_NAME);
  if (!app) throw new Error(`Container application ${APP_NAME} not found`);
  return app;
}

async function waitForRollout(appId, rolloutId) {
  const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
  for (;;) {
    const rollout = await api("GET", `/applications/${appId}/rollouts/${rolloutId}`);
    const p = rollout.progress ?? {};
    console.log(
      `Rollout ${rollout.status}: step ${p.current_step ?? "?"}/${p.total_steps ?? "?"}, ${p.updated_instances ?? "?"}/${p.total_instances ?? "?"} instances updated`,
    );
    if (rollout.status === "completed") return;
    if (rollout.status !== "pending" && rollout.status !== "progressing") {
      throw new Error(`Rollout ended as ${rollout.status}; the Worker was not deployed`);
    }
    if (Date.now() > deadline)
      throw new Error("Rollout did not complete in time; the Worker was not deployed");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const image = buildAndPush();
const app = await findApplication();
if (app.configuration?.image === image) {
  console.log("The container application already runs this image; nothing to roll out.");
  process.exit(0);
}
const configuration = { ...app.configuration, image };
console.log(`Updating ${APP_NAME} to ${image.split("@")[1]}`);
await api("PATCH", `/applications/${app.id}`, { configuration });
const rollout = await api("POST", `/applications/${app.id}/rollouts`, {
  description: "Container-first update before the Worker deploy",
  strategy: "rolling",
  kind: "full_auto",
  target_configuration: configuration,
  steps: ROLLOUT_STEPS.map((percentage, i) => ({
    step_size: { percentage },
    description: `Step ${i + 1} of ${ROLLOUT_STEPS.length} - rollout at ${percentage}% of instances`,
  })),
});
await waitForRollout(app.id, rollout.id);
console.log("Container rollout completed; the Worker can be deployed.");
