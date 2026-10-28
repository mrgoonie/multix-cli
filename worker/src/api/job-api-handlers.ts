/**
 * REST handlers for the CLI runner: the command catalog, the price book and jobs. They reuse
 * the MCP tools' code paths (catalogPayload, prepareRun, JobRunner), so caps,
 * input checks, ownership and output scrubbing are the same on both surfaces.
 */

import { z } from "zod";
import type { Limits } from "../config.js";
import { json } from "../http-responses.js";
import { MODEL_ID_RE, catalogPayload } from "../jobs/catalog-view.js";
import { type JobStatus, isTerminal } from "../jobs/job-protocol.js";
import { DEFAULT_WAIT_SECONDS, JobRunner, MAX_WAIT_SECONDS } from "../jobs/job-runner.js";
import type { JobToolsContext } from "../jobs/job-runner.js";
import { priceBookArgsSchema, priceBookView } from "../jobs/price-book-view.js";
import { type RunRequest, prepareRun } from "../jobs/run-argv-builder.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { ApiError, readJsonObject } from "./api-http.js";

const GROUP_RE = /^[a-z0-9-]{1,40}$/;

export function getCatalog(keys: ProviderKeys, url: URL): Response {
  const group = url.searchParams.get("group") ?? undefined;
  if (group !== undefined && !GROUP_RE.test(group)) {
    throw new ApiError(400, "bad_request", "group must be a command group such as gemini");
  }
  const task = url.searchParams.get("task") ?? undefined;
  const model = url.searchParams.get("model") ?? undefined;
  if (model !== undefined && !MODEL_ID_RE.test(model)) {
    throw new ApiError(400, "bad_request", "model must be a provider model id");
  }
  return json(200, catalogPayload(keys, group, { task, model }));
}

/** Same views and arguments as multix_price_book, as query parameters. */
export function getPriceBook(keys: ProviderKeys, url: URL): Response {
  const q = url.searchParams;
  const flag = (name: string) => {
    const v = q.get(name);
    if (v === null) return undefined;
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return false;
    throw new ApiError(400, "bad_request", `${name} must be true or false`);
  };
  const num = (name: string) => {
    const v = q.get(name);
    return v === null ? undefined : Number(v);
  };
  const input: Record<string, unknown> = { view: q.get("view") ?? "providers" };
  for (const name of ["ref", "family", "provider", "task", "resolution", "aspect_ratio"]) {
    const v = q.get(name);
    if (v !== null) input[name] = v;
  }
  for (const name of ["priced", "verified", "audio"]) {
    const v = flag(name);
    if (v !== undefined) input[name] = v;
  }
  for (const name of ["duration", "count"]) {
    const v = num(name);
    if (v !== undefined) input[name] = v;
  }
  const parsed = z.object(priceBookArgsSchema).safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      "bad_request",
      `${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return json(200, priceBookView(keys, parsed.data));
}

function requireJobs(jobs: JobToolsContext | undefined): JobToolsContext {
  if (!jobs) throw new ApiError(503, "unavailable", "Jobs are not available on this server");
  return jobs;
}

/** Same shape as multix_run's arguments; prepareRun validates the details. */
function runRequest(body: Record<string, unknown>): { request: RunRequest; wait: number } {
  const { command, args, options, inputs, wait_seconds: wait } = body;
  if (typeof command !== "string" || !command.trim() || command.length > 100) {
    throw new ApiError(400, "bad_request", 'command is required, e.g. "gemini generate"');
  }
  if (
    args !== undefined &&
    (!Array.isArray(args) || args.length > 20 || args.some((a) => typeof a !== "string"))
  ) {
    throw new ApiError(400, "bad_request", "args must be an array of at most 20 strings");
  }
  for (const [name, value] of [
    ["options", options],
    ["inputs", inputs],
  ] as const) {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw new ApiError(400, "bad_request", `${name} must be an object`);
    }
  }
  if (
    wait !== undefined &&
    (typeof wait !== "number" || !Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_SECONDS)
  ) {
    throw new ApiError(
      400,
      "bad_request",
      `wait_seconds must be an integer from 0 to ${MAX_WAIT_SECONDS}`,
    );
  }
  return {
    request: {
      command,
      args: args as string[] | undefined,
      options: options as RunRequest["options"],
      inputs: inputs as RunRequest["inputs"],
    },
    wait: (wait as number | undefined) ?? DEFAULT_WAIT_SECONDS,
  };
}

/** 202 while the job runs, 200 once it reached a final state. */
function jobResponse(payload: Record<string, unknown>): Response {
  const done = isTerminal(payload.status as JobStatus);
  const body = { ...payload };
  // The MCP payload points to the next tool; the REST client polls the job URL instead.
  if (!done) body.next = { method: "GET", path: `/api/v1/jobs/${String(payload.job_id)}` };
  return json(done ? 200 : 202, body);
}

export async function postJob(
  jobs: JobToolsContext | undefined,
  limits: Limits,
  request: Request,
): Promise<Response> {
  const ctx = requireJobs(jobs);
  const { request: run, wait } = runRequest(await readJsonObject(request));
  const prepared = prepareRun(run, limits);
  return jobResponse(await new JobRunner(ctx).run(prepared, wait));
}

export async function getJob(jobs: JobToolsContext | undefined, jobId: string): Promise<Response> {
  return jobResponse(await new JobRunner(requireJobs(jobs)).status(jobId));
}

export async function cancelJob(
  jobs: JobToolsContext | undefined,
  jobId: string,
): Promise<Response> {
  return jobResponse(await new JobRunner(requireJobs(jobs)).cancel(jobId));
}
