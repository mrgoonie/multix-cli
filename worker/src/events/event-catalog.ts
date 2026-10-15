/**
 * The MCP Events catalog served by `events/list`: one entry per event a
 * client may subscribe to, with the JSON Schema of its subscription
 * `arguments` and of the `data` it will receive.
 *
 * Payloads stay minimal: ids, final status, the command and its group, a
 * timestamp and an R2 object key. Never provider keys, prompts, logs, media
 * or expiring signed URLs. Publishing these events when a job ends is a
 * separate change; this catalog only defines what can be subscribed to.
 */

import { z } from "zod";

/** Delivery modes this server supports. ChatGPT supports webhook only. */
export const DELIVERY_MODES = ["webhook"] as const;

/** Subscription arguments of every job event: optionally narrow to one job. */
export const jobEventArguments = z
  .object({
    job_id: z
      .string()
      .max(64)
      .optional()
      .describe("Only events of this multix_run job; omit for every job you start"),
  })
  .strict();

export type JobEventArguments = z.infer<typeof jobEventArguments>;

const jobFields = {
  jobId: z.string().describe("Job id returned by multix_run"),
  command: z.string().describe("CLI command path, e.g. gemini generate"),
  group: z.string().describe("Command group (provider), e.g. gemini"),
  occurredAt: z.string().describe("ISO 8601 time the job reached this state"),
};

function jobPayload(status: string) {
  return z.object({ ...jobFields, status: z.literal(status) }).strict();
}

interface EventDefinition {
  name: string;
  description: string;
  payload: z.ZodType;
}

const DEFINITIONS: EventDefinition[] = [
  {
    name: "multix.job.completed",
    description: "A multix_run job you started finished successfully.",
    payload: jobPayload("succeeded"),
  },
  {
    name: "multix.job.failed",
    description: "A multix_run job you started failed.",
    payload: jobPayload("failed"),
  },
  {
    name: "multix.job.canceled",
    description: "A multix_run job you started was canceled.",
    payload: jobPayload("canceled"),
  },
  {
    name: "multix.job.timed_out",
    description: "A multix_run job you started ran out of time.",
    payload: jobPayload("timed_out"),
  },
  {
    name: "multix.asset.ready",
    description:
      "An output file of a multix_run job you started was stored in your R2 bucket. Read it through multix_job_status.",
    payload: z
      .object({
        jobId: jobFields.jobId,
        assetKey: z.string().describe("Object key in your R2 bucket"),
        contentType: z.string().optional(),
        occurredAt: jobFields.occurredAt,
      })
      .strict(),
  },
];

export interface CatalogEntry {
  name: string;
  description: string;
  delivery: string[];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

let catalog: CatalogEntry[] | undefined;

/** Every event this server offers (the same for every account: all are about the caller's own jobs). */
export function eventCatalog(): CatalogEntry[] {
  catalog ??= DEFINITIONS.map((d) => ({
    name: d.name,
    description: d.description,
    delivery: [...DELIVERY_MODES],
    inputSchema: jsonSchema(jobEventArguments),
    payloadSchema: jsonSchema(d.payload),
  }));
  return catalog;
}

export function isKnownEvent(name: string): boolean {
  return DEFINITIONS.some((d) => d.name === name);
}
