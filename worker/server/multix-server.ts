/**
 * `multix-server`: the Multix remote MCP server, dashboard and REST API as a
 * standalone Node.js process (no Cloudflare runtime). Listens on
 * HOST:PORT (default 0.0.0.0:3000) and keeps its state in one SQLite file
 * under MULTIX_DATA_DIR (default /data, a persistent volume).
 *
 *   GET /health         liveness, from the Worker: { ok: true }
 *   GET /health/ready   readiness: storage writable, configuration complete, not draining
 *
 * SIGTERM / SIGINT: readiness turns 503, the listener stops accepting, open
 * requests and background work get MULTIX_SHUTDOWN_TIMEOUT_MS to finish,
 * then the database is closed.
 */

// First: the public-only fetch must be in place before any Worker module loads.
import "./install-public-fetch-guard.js";
import { logEvent } from "../src/redaction.js";
import { createHttpServer } from "./http-server.js";
import { serverConfigFrom, workerVars } from "./server-config.js";
import { openDatabase } from "./sqlite-database.js";
import { createStandaloneApp } from "./standalone-app.js";
import { prepareBootstrap } from "./standalone-bootstrap.js";

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

declare const MULTIX_SERVER_VERSION: string | undefined;

async function main(): Promise<void> {
  const config = serverConfigFrom(process.env);
  const vars = workerVars(process.env);
  const database = openDatabase(config.databasePath);
  const app = createStandaloneApp({
    database,
    vars,
    mcpRateLimit: config.mcpRateLimit,
    authRateLimit: config.authRateLimit,
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
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logEvent("info", "server_stopping", { signal });
    app.drain();
    clearInterval(sweepTimer);
    const started = Date.now();
    await http.close(config.shutdownTimeoutMs);
    await app.stop(Math.max(0, config.shutdownTimeoutMs - (Date.now() - started)));
    database.close();
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
