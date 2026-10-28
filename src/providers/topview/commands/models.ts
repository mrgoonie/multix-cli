/**
 * multix topview models — what each TopView API offers through multix.
 * Platform routes are the ones its docs list (with source and date); --live
 * reads the public model index (https://platform.topview.ai/llms.txt) and
 * marks models multix has not verified. Legacy tasks are fixed endpoints.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ProviderError } from "../../../core/errors.js";
import { readCappedText } from "../../../core/response-read.js";
import {
  LEGACY_TASKS,
  PLATFORM_DOCS_SOURCE,
  PLATFORM_ROUTES,
  PLATFORM_VERIFIED_AT,
  TOPVIEW_PROVIDER,
  routeId,
} from "../models.js";

const LIVE_INDEX_URL = "https://platform.topview.ai/llms.txt";

/** `owner/model` ids listed under "## Models" in the public llms.txt index. */
export function parseModelIndex(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(/^- \[([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)\]/gim)) {
    if (m[1] && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

async function fetchLiveModels(): Promise<string[]> {
  let response: Response;
  try {
    response = await globalThis.fetch(LIVE_INDEX_URL, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ProviderError(
      `Could not read ${LIVE_INDEX_URL}: ${e instanceof Error ? e.message : String(e)}`,
      TOPVIEW_PROVIDER,
    );
  }
  if (!response.ok) {
    throw new ProviderError(`${LIVE_INDEX_URL} answered HTTP ${response.status}`, TOPVIEW_PROVIDER);
  }
  return parseModelIndex(await readCappedText(response, 256 * 1024));
}

export function registerModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description("List verified API Platform routes and legacy task kinds; --live checks the index")
    .option("--live", "Also read the Platform's public model index and flag unverified models")
    .action(async (opts: { live?: boolean }) => {
      const verified = new Set(PLATFORM_ROUTES.map((r) => `${r.owner}/${r.model}`));
      const live = opts.live ? await fetchLiveModels() : undefined;
      const unverified = live?.filter((id) => !verified.has(id)) ?? [];
      run.data = {
        platform: {
          source: PLATFORM_DOCS_SOURCE,
          verified_at: PLATFORM_VERIFIED_AT,
          routes: PLATFORM_ROUTES.map((r) => ({ route: routeId(r), output: r.output })),
          ...(live ? { live_index: live, unverified } : {}),
        },
        legacy: Object.keys(LEGACY_TASKS),
      };
      console.log(
        `API Platform (TOPVIEW_API_PLATFORM_KEY, USD balance) — verified ${PLATFORM_VERIFIED_AT} from ${PLATFORM_DOCS_SOURCE}:`,
      );
      for (const r of PLATFORM_ROUTES) console.log(`  ${routeId(r)}  (${r.output})`);
      if (live) {
        console.log(
          unverified.length > 0
            ? `\nListed in the live index but not verified by multix (not accepted): ${unverified.join(", ")}`
            : "\nThe live index lists no models beyond the verified ones.",
        );
      }
      console.log(
        "\nLegacy API (TOPVIEW_API_KEY + TOPVIEW_UID, topview.ai plan credits) task kinds:",
      );
      for (const kind of Object.keys(LEGACY_TASKS)) console.log(`  ${kind}`);
    });
}
