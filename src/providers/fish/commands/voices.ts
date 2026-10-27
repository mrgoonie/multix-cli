/**
 * multix fish voices list|get|delete — Fish Audio voice models. `list` and
 * `get` are free reads; `list` shows your own voices by default and
 * `--public` searches the library. `delete` needs --yes: it cannot be undone.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { requireFishKey } from "../client.js";
import {
  type FishVoice,
  deleteFishVoice,
  fishModelId,
  getFishVoice,
  listFishVoices,
} from "../voices-client.js";

function line(v: FishVoice): string {
  const meta = [v.state, v.visibility, v.languages.join("/")].filter(Boolean).join(", ");
  return `${v.id}  ${v.title ?? "(untitled)"}${meta ? `  (${meta})` : ""}`;
}

function pageNumber(value: string, flag: string, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError(`${flag} must be a whole number from 1 to ${max}`);
  }
  return n;
}

export function registerFishVoicesCommand(parent: Command): void {
  const voices = parent.command("voices").description("List and read Fish Audio voice models");
  voices
    .command("list")
    .description("List your Fish Audio voice models (or public ones with --public)")
    .option("--public", "Search public voices instead of your own")
    .option("--title <text>", "Filter by title")
    .option("--language <code>", "Filter by language (en, zh, ja, vi, ...)")
    .option("--page-size <n>", "Results per page, 1 to 100", "20")
    .option("--page <n>", "Page number", "1")
    .action(
      async (opts: {
        public?: boolean;
        title?: string;
        language?: string;
        pageSize: string;
        page: string;
      }) => {
        const page = await listFishVoices({
          apiKey: requireFishKey(),
          self: !opts.public,
          pageSize: pageNumber(opts.pageSize, "--page-size", 100),
          pageNumber: pageNumber(opts.page, "--page", 10_000),
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.language ? { language: opts.language } : {}),
        });
        if (run.json) {
          console.log(JSON.stringify(page));
          return;
        }
        if (page.items.length === 0) {
          console.log(opts.public ? "No public voices matched." : "No voices in your account yet.");
          return;
        }
        for (const v of page.items) console.log(line(v));
        if (page.has_more) console.log(`... more on --page ${Number(opts.page) + 1}`);
      },
    );
  voices
    .command("get <id>")
    .description("Show one Fish Audio voice model (state, visibility, languages)")
    .action(async (id: string) => {
      const voice = await getFishVoice({ apiKey: requireFishKey(), id: fishModelId(id) });
      console.log(run.json ? JSON.stringify(voice) : line(voice));
    });
  voices
    .command("delete <id>")
    .description("Delete one of your Fish Audio voices (cannot be undone)")
    .option("--yes", "Confirm the deletion")
    .action(async (raw: string, opts: { yes?: boolean }) => {
      const id = fishModelId(raw);
      if (!opts.yes) {
        throw new ValidationError(`Deleting ${id} cannot be undone: re-run with --yes to confirm`);
      }
      run.data = { deleting: id, dry_run: run.dryRun };
      await deleteFishVoice({ apiKey: requireFishKey(), id });
      const result = { deleted: id };
      run.data = result;
      console.log(run.json ? JSON.stringify(result) : `Deleted voice ${id}`);
    });
}
