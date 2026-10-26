/**
 * MCP tool over the caller's usage ledger: multix_usage_summary reads totals,
 * the top groups and budget status for a recent window. Offered only when the
 * deployment has the ledger binding (see index.ts).
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { RunToolFn } from "../jobs/job-tools.js";
import { toolInput } from "../jobs/tool-input-schema.js";
import type { AccountLedgerStub } from "./account-ledger.js";
import { GROUP_BYS, type GroupBy } from "./ledger-types.js";

const DAY_MS = 86_400_000;
export const DEFAULT_SUMMARY_DAYS = 30;
export const MAX_SUMMARY_DAYS = 90;
export const MAX_SUMMARY_GROUPS = 10;
export const UNKNOWN_COST_NOTE =
  "Operations whose cost the provider did not report are counted in unknown_cost_operations and not in known_cost_usd; known_cost_usd is a record, not a bill.";

export async function usageSummaryPayload(
  ledger: AccountLedgerStub,
  days: number,
  groupBy: GroupBy | null,
  now: number,
): Promise<Record<string, unknown>> {
  const filter = { from: now - days * DAY_MS, to: now };
  const [summary, budgets] = await Promise.all([
    ledger.summary(filter, groupBy, 0),
    ledger.budgetStatuses(),
  ]);
  return {
    from: new Date(summary.from).toISOString(),
    to: new Date(summary.to).toISOString(),
    days,
    totals: summary.totals,
    group_by: summary.group_by,
    groups: summary.groups.slice(0, MAX_SUMMARY_GROUPS),
    budgets,
    note: UNKNOWN_COST_NOTE,
  };
}

export function registerUsageTools(
  server: McpServer,
  ledger: AccountLedgerStub | undefined,
  runTool: RunToolFn,
): void {
  if (!ledger) return;
  server.registerTool(
    "multix_usage_summary",
    {
      title: "multix usage summary",
      description: `Summarise your multix usage over the last days (default ${DEFAULT_SUMMARY_DAYS}, max ${MAX_SUMMARY_DAYS}, UTC): operations, success rate, known cost (provider-reported + estimated + adjustments), operations with unknown cost, tokens, latency, and every budget's status. group_by splits the totals (top ${MAX_SUMMARY_GROUPS}). Covers multix_run jobs, REST jobs and pushed CLI history.`,
      inputSchema: toolInput({
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_SUMMARY_DAYS)
          .optional()
          .describe(`Days back from now (default ${DEFAULT_SUMMARY_DAYS})`),
        group_by: z
          .enum(GROUP_BYS as [GroupBy, ...GroupBy[]])
          .optional()
          .describe("Split totals by this field"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool("multix_usage_summary", { group_by: args.group_by }, async () =>
        usageSummaryPayload(
          ledger,
          args.days ?? DEFAULT_SUMMARY_DAYS,
          args.group_by ?? null,
          Date.now(),
        ),
      ),
  );
}
