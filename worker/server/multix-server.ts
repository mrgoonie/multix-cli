/**
 * `multix-server`: the Multix remote MCP server, dashboard and REST API as a
 * standalone Node.js process (no Cloudflare runtime). Listens on
 * HOST:PORT (default 0.0.0.0:3000) and keeps its state in one SQLite file
 * under MULTIX_DATA_DIR (default /data, a persistent volume).
 *
 *   GET /health         liveness, from the Worker: { ok: true }
 *   GET /health/ready   readiness: storage writable, configuration complete, not draining
 *                       (and, with jobs enabled, the job executor accepting jobs)
 *
 * MULTIX_LOCAL_JOBS=true runs `multix_run` jobs as child processes (see
 * local-jobs.ts); start-up fails when the multix CLI is not on PATH. The
 * `server_started` log line says whether jobs are enabled. With
 * MULTIX_JOB_EXECUTOR=kubernetes each job runs as a Kubernetes Job instead
 * (container/k8s-job-runner.mjs); start-up fails when its NetworkPolicy is missing.
 *
 * SIGTERM / SIGINT (see server-shutdown.ts): readiness turns 503 and, at the
 * same time, the listener stops accepting and running jobs are recorded as
 * interrupted and their CLI processes stopped (within the executor's own
 * budget). Open requests and background work get MULTIX_SHUTDOWN_TIMEOUT_MS
 * to finish; the slots of the stopped jobs are given back before the
 * database is closed.
 */

// First: the public-only fetch must be in place before any Worker module loads.
import "./install-public-fetch-guard.js";
import { logEvent } from "../src/redaction.js";
import { createHttpServer } from "./http-server.js";
import { DEFAULT_CLI_BIN, kubernetesJobOptions, resolveExecutable } from "./local-jobs.js";
import { serverConfigFrom, workerVars } from "./server-config.js";
import { shutdownServer } from "./server-shutdown.js";
import { openDatabase } from "./sqlite-database.js";
import { createStandaloneApp } from "./standalone-app.js";
import { prepareBootstrap } from "./standalone-bootstrap.js";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

declare const MULTIX_SERVER_VERSION: string | undefined;

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env);
  const vars = workerVars(process.env);
  let cliBin: string | undefined;
  let executorOptions: Awaited<ReturnType<typeof kubernetesJobOptions>> | undefined;
  if (config.localJobs && config.jobExecutor === "kubernetes") {
    // Jobs run in their own pods: no CLI is needed here, but the NetworkPolicy is.
    executorOptions = await kubernetesJobOptions(process.env);
  } else if (config.localJobs) {
    cliBin = await resolveExecutable(DEFAULT_CLI_BIN);
    if (!cliBin) {
      throw new Error("MULTIX_LOCAL_JOBS=true but the multix CLI is not on PATH");
    }
  }
  const database = openDatabase(config.databasePath);
  const app = await createStandaloneApp({
    database,
    vars,
    mcpRateLimit: config.mcpRateLimit,
    authRateLimit: config.authRateLimit,
    jobs: config.localJobs
      ? {
          stateDir: config.jobsStateDir,
          maxConcurrent: config.maxConcurrentJobs,
          cliBin,
          ...executorOptions,
          // Leave part of the shutdown budget for the database and alarms.
          closeTimeoutMs: Math.min(10_000, Math.floor(config.shutdownTimeoutMs / 2)),
        }
      : undefined,
  });
  await prepareBootstrap(app.env, (line) => process.stdout.write(`${line}\n`));

  const sweepTimer = setInterval(() => {
    try {
      app.sweep();
    } catch (error) {
      logEvent("warn", "kv_sweep_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // The Worker builds every URL from MULTIX_PUBLIC_URL; requests are rebased on it.
  // Without it the app answers 503 (and readiness fails) until it is configured.
  const configured = vars.MULTIX_PUBLIC_URL;
  const origin =
    configured && URL.canParse(configured)
      ? new URL(configured).origin
      : `http://localhost:${config.port}`;
  const http = createHttpServer(app, {
    origin,
    trustProxyHops: config.trustProxyHops,
    maxBodyBytes: config.maxBodyBytes,
  });
  await new Promise<void>((resolve) => http.server.listen(config.port, config.host, resolve));
  logEvent("info", "server_started", {
    version: typeof MULTIX_SERVER_VERSION === "string" ? MULTIX_SERVER_VERSION : "dev",
    port: config.port,
    data_dir: config.dataDir,
    jobs: app.jobs ? "enabled" : "disabled",
    job_executor: app.jobs ? config.jobExecutor : undefined,
    max_concurrent_jobs: app.jobs?.maxConcurrent,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logEvent("info", "server_stopping", { signal });
    clearInterval(sweepTimer);
    await shutdownServer(app, http, database, config.shutdownTimeoutMs);
    logEvent("info", "server_stopped", {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logEvent("error", "server_start_failed", {
    error: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
});
