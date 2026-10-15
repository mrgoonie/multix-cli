/**
 * The events one finished job produces: exactly one `multix.job.*` event for
 * its terminal state, plus one `multix.asset.ready` per output stored in R2
 * when it succeeded. Ids are derived from the job id, so building the events
 * again for the same job gives the same ids and receivers dedupe them.
 */

import {
  type JobTerminalStatus,
  type JobView,
  SERVER_AT_CAPACITY_ERROR,
  isTerminal,
} from "../jobs/job-protocol.js";
import {
  ASSET_READY_EVENT,
  EVENT_SCHEMA_VERSION,
  type JobEventName,
  type MultixEvent,
} from "./event-catalog.js";

/** At most this many `multix.asset.ready` events per job. */
export const MAX_ASSET_EVENTS = 20;

const EVENT_FOR_STATUS: Record<JobTerminalStatus, JobEventName> = {
  succeeded: "multix.job.completed",
  failed: "multix.job.failed",
  canceled: "multix.job.canceled",
  timed_out: "multix.job.timed_out",
};

export interface JobEventSource {
  jobId: string;
  /** CLI command, e.g. "gemini generate"; empty when unknown. */
  command: string;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Events for a job's final view; empty while the job is still running. */
export function jobEvents(source: JobEventSource, view: JobView): MultixEvent[] {
  if (!isTerminal(view.status)) return [];
  // The caller gets a capacity error instead of a job id and retries, so this
  // job is never seen: reporting it would only send webhooks for unknown jobs.
  if (view.status === "failed" && view.error === SERVER_AT_CAPACITY_ERROR) return [];
  const finishedAt = view.finishedAt ?? view.createdAt;
  const provider = source.command.split(" ")[0] ?? "";
  const outputs = (view.result?.outputs ?? []).map((o) => ({
    name: o.name,
    bytes: o.bytes,
    stored: o.url !== null,
  }));
  const resource = { type: "job", id: source.jobId } as const;
  const events: MultixEvent[] = [
    {
      id: `evt_${source.jobId}_${view.status}`,
      name: EVENT_FOR_STATUS[view.status],
      schema_version: EVENT_SCHEMA_VERSION,
      occurred_at: iso(finishedAt),
      resource,
      data: {
        job_id: source.jobId,
        status: view.status,
        command: source.command,
        provider,
        created_at: iso(view.createdAt),
        finished_at: iso(finishedAt),
        exit_code: view.result?.exitCode ?? null,
        outputs,
      },
    },
  ];
  if (view.status !== "succeeded") return events;
  outputs.forEach((output, index) => {
    if (!output.stored || index >= MAX_ASSET_EVENTS) return;
    events.push({
      id: `evt_${source.jobId}_asset_${index}`,
      name: ASSET_READY_EVENT,
      schema_version: EVENT_SCHEMA_VERSION,
      occurred_at: iso(finishedAt),
      resource,
      data: {
        job_id: source.jobId,
        command: source.command,
        provider,
        index,
        name: output.name,
        bytes: output.bytes,
      },
    });
  });
  return events;
}
