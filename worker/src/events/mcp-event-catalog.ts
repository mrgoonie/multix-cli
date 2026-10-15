/**
 * The MCP Events view of the event catalog (event-catalog.ts), served by
 * `events/list`: each event with its delivery modes, the JSON Schema of the
 * subscription `arguments` and of the `data` a delivery carries.
 */

import { z } from "zod";
import { EVENT_CATALOG } from "./event-catalog.js";

/** Delivery modes this server supports. ChatGPT supports webhook only. */
export const DELIVERY_MODES = ["webhook"] as const;

/** Subscription arguments of every event: optionally narrow to one job. */
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

export interface McpCatalogEntry {
  name: string;
  description: string;
  delivery: string[];
  inputSchema: Record<string, unknown>;
  payloadSchema: object;
}

let catalog: McpCatalogEntry[] | undefined;

/** Every event this server offers (the same for every account: all are about the caller's own jobs). */
export function mcpEventCatalog(): McpCatalogEntry[] {
  if (!catalog) {
    const { $schema: _, ...inputSchema } = z.toJSONSchema(jobEventArguments) as Record<
      string,
      unknown
    >;
    catalog = EVENT_CATALOG.map((entry) => ({
      name: entry.name,
      description: entry.description,
      delivery: [...DELIVERY_MODES],
      inputSchema,
      payloadSchema: entry.data_schema,
    }));
  }
  return catalog;
}
