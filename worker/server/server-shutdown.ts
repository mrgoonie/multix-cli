/**
 * The standalone server's shutdown order, shared by multix-server.ts and the
 * tests. Readiness turns 503 first. The job executor is stopped at once, in
 * parallel with the HTTP drain: an open `multix_run` or POST /api/v1/jobs
 * poll then sees the job's interrupted state and returns instead of holding
 * the drain for its whole wait. The executor gets its own time budget, and
 * its slot releases and event writes finish before the database closes.
 */

import type { MultixHttpServer } from "./http-server.js";
import type { MultixDatabase } from "./sqlite-database.js";
import type { StandaloneApp } from "./standalone-app.js";

export async function shutdownServer(
  app: StandaloneApp,
  http: MultixHttpServer,
  database: MultixDatabase,
  timeoutMs: number,
): Promise<void> {
  app.drain();
  const started = Date.now();
  const jobsClosed = app.closeJobs();
  await http.close(timeoutMs);
  await app.stop(Math.max(0, timeoutMs - (Date.now() - started)));
  await jobsClosed;
  database.close();
}
