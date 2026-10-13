#!/usr/bin/env node
/**
 * Job server inside the multix job container. Reachable only through the
 * job's Durable Object (Containers have no public ingress), and each
 * container runs exactly one job:
 *
 *   GET  /                      readiness ping
 *   POST /jobs                  start the job (202); a second job is refused (409)
 *   GET  /jobs/current          { state: "idle" | "running" | "done", result? }
 *   POST /jobs/current/cancel   SIGTERM the CLI (202)
 *
 * The request body carries the caller's keys: it is never logged, and only
 * the job id and final status are written to the log.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { SpecError, runJob, validateSpec } from "./job-runner.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 1024 * 1024;

/** @type {{ state: "running" | "done", jobId: string, abort: AbortController, result?: object } | undefined} */
let current;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SpecError("Body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function log(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
}

async function startJob(req, res) {
  if (current) return send(res, 409, { error: "A job already ran in this container" });
  let spec;
  try {
    spec = validateSpec(JSON.parse(await readBody(req)));
  } catch {
    return send(res, 400, { error: "Invalid job" });
  }
  if (current) return send(res, 409, { error: "A job already ran in this container" });
  const job = { state: "running", jobId: spec.jobId, abort: new AbortController() };
  current = job;
  log("job_started", { job: spec.jobId });
  runJob(spec, { signal: job.abort.signal })
    .catch(() => ({
      status: "failed",
      exitCode: null,
      stdout: "",
      stderrTail: "",
      outputs: [],
      error: "The job failed inside the container",
    }))
    .then((result) => {
      job.result = result;
      job.state = "done";
      log("job_finished", { job: spec.jobId, status: result.status, exit: result.exitCode });
    });
  return send(res, 202, { accepted: true });
}

export function createJobServer() {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://container").pathname;
    if (req.method === "GET" && path === "/") return send(res, 200, { ok: true });
    if (req.method === "POST" && path === "/jobs") {
      startJob(req, res).catch(() => send(res, 500, { error: "Internal error" }));
      return;
    }
    if (req.method === "GET" && path === "/jobs/current") {
      if (!current) return send(res, 200, { state: "idle" });
      return send(res, 200, {
        state: current.state,
        ...(current.result ? { result: current.result } : {}),
      });
    }
    if (req.method === "POST" && path === "/jobs/current/cancel") {
      if (current?.state === "running") current.abort.abort();
      return send(res, 202, { state: current?.state ?? "idle" });
    }
    return send(res, 404, { error: "Not found" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createJobServer();
  server.listen(PORT, () => log("job_server_listening", { port: PORT }));
  // The platform sends SIGTERM before stopping the container: stop the CLI too.
  process.on("SIGTERM", () => {
    if (current?.state === "running") current.abort.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
