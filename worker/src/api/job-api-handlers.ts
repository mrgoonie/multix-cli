/**
 * REST handlers for the CLI runner: the command catalog and jobs. They reuse
 * the MCP tools' code paths (catalogPayload, prepareRun, JobRunner), so caps,
 * input checks, ownership and output scrubbing are the same on both surfaces.
 */

import type { Limits } from "../config.js";
import { json } from "../http-responses.js";
import { MODEL_ID_RE, catalogPayload } from "../jobs/catalog-view.js";
import { type JobStatus, isTerminal } from "../jobs/job-protocol.js";
import { DEFAULT_WAIT_SECONDS, JobRunner, MAX_WAIT_SECONDS } from "../jobs/job-runner.js";
import type { JobToolsContext } from "../jobs/job-runner.js";
import { modelCatalogPayload } from "../jobs/model-catalog-view.js";
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

const NUMBER_RE = /^\d+(\.\d+)?$/;

function boolParam(url: URL, name: string): boolean | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  if (v === "true" || v === "on" || v === "1") return true;
  if (v === "false" || v === "off" || v === "0") return false;
  throw new ApiError(400, "bad_request", `${name} must be true or false`);
}

/** Same bounds as the multix_model_catalog input schema. */
function numberParam(url: URL, name: string, max: number, whole = false): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  if (!NUMBER_RE.test(v) || n <= 0 || n > max || (whole && !Number.isInteger(n))) {
    throw new ApiError(
      400,
      "bad_request",
      `${name} must be a positive ${whole ? "whole " : ""}number up to ${max}`,
    );
  }
  return n;
}

/** GET /model-catalog: the same views as `multix catalog --json` and multix_model_catalog. */
export function getModelCatalog(keys: ProviderKeys, url: URL): Response {
  const p = url.searchParams;
  const text = (name: string, max: number) => {
    const v = p.get(name) ?? undefined;
    if (v !== undefined && v.length > max) {
      throw new ApiError(400, "bad_request", `${name} is longer than ${max} characters`);
    }
    return v;
  };
  const query = {
    view: (text("view", 20) ?? "models") as "models",
    task: text("task", 40),
    provider: text("provider", 40),
    family: text("family", 60),
    query: text("q", 100),
    offering: text("offering", 250),
    resolution: text("resolution", 20),
    aspect_ratio: text("aspect_ratio", 10),
    sort: text("sort", 20),
    priced: boolParam(url, "priced"),
    ready: boolParam(url, "ready"),
    audio: boolParam(url, "audio"),
    duration_s: numberParam(url, "duration_s", 3600),
    images: numberParam(url, "images", 100, true),
  };
  const defined = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
  return json(200, modelCatalogPayload(keys, defined as typeof query));
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
