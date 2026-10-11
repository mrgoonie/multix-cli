/**
 * HeyGen catalog commands: avatars (looks or groups), voices, Video Agent
 * styles, translation languages, and the current account (`me`).
 * Lists are cursor-paginated: pass the printed `--cursor` to get the next page.
 */

import type { Command } from "commander";
import { AVATAR_TYPES, LIMITS, OWNERSHIP_VALUES } from "../models.js";
import { createHeygenClientFromEnv } from "../node-helpers.js";
import { numberInRange, oneOf } from "../request-builders.js";
import type { HeygenPage } from "../types.js";

function pageLimit(raw: string | undefined, max: number): number | undefined {
  return numberInRange(raw, "--limit", 1, max, true);
}

/** Print rows as aligned columns, then the next-page cursor. */
function printTable<T>(page: HeygenPage<T>, columns: Array<[string, (row: T) => unknown]>): void {
  if (page.items.length === 0) {
    console.log("No results.");
  } else {
    const cells = page.items.map((row) =>
      columns.map(([, get]) => {
        const v = get(row);
        return Array.isArray(v) ? v.join(",") : v === null || v === undefined ? "-" : String(v);
      }),
    );
    const widths = columns.map(([h], i) =>
      Math.min(48, Math.max(h.length, ...cells.map((c) => (c[i] ?? "").length))),
    );
    const fmt = (vals: string[]) =>
      vals
        .map((v, i) => v.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd();
    console.log(fmt(columns.map(([h]) => h)));
    for (const c of cells) console.log(fmt(c));
  }
  if (page.hasMore && page.nextToken) console.log(`\nMore results: --cursor ${page.nextToken}`);
}

function printPage<T>(
  page: HeygenPage<T>,
  json: boolean | undefined,
  columns: Array<[string, (row: T) => unknown]>,
): void {
  if (json) {
    console.log(
      JSON.stringify(
        { data: page.items, has_more: page.hasMore, next_token: page.nextToken },
        null,
        2,
      ),
    );
  } else {
    printTable(page, columns);
  }
}

export function registerHeygenCatalogCommands(parent: Command): void {
  parent
    .command("avatars")
    .description(
      "List avatar looks (the look ID is the --avatar for videos); --groups lists characters instead",
    )
    .option("--groups", "List avatar groups (characters) instead of looks")
    .option("--group <group-id>", "Only looks in this avatar group")
    .option("--type <t>", `Look type: ${AVATAR_TYPES.join(" | ")}`)
    .option("--ownership <o>", "public (presets) | private (yours)")
    .option("--limit <n>", `Page size (1-${LIMITS.avatarListMax})`)
    .option("--cursor <token>", "Next-page cursor from a previous call")
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        groups?: boolean;
        group?: string;
        type?: string;
        ownership?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const ownership = oneOf(opts.ownership, OWNERSHIP_VALUES, "--ownership");
        const avatarType = oneOf(opts.type, AVATAR_TYPES, "--type");
        const limit = pageLimit(opts.limit, LIMITS.avatarListMax);
        const client = createHeygenClientFromEnv();
        if (opts.groups) {
          const page = await client.listAvatarGroups({ ownership, limit, token: opts.cursor });
          printPage(page, opts.json, [
            ["GROUP_ID", (g) => g.id],
            ["NAME", (g) => g.name],
            ["LOOKS", (g) => g.looks_count],
            ["GENDER", (g) => g.gender],
            ["DEFAULT_VOICE", (g) => g.default_voice_id],
          ]);
          if (!opts.json)
            console.log("\nUse `heygen avatars --group <GROUP_ID>` to list its looks.");
          return;
        }
        const page = await client.listAvatarLooks({
          group_id: opts.group,
          avatar_type: avatarType,
          ownership,
          limit,
          token: opts.cursor,
        });
        printPage(page, opts.json, [
          ["LOOK_ID", (l) => l.id],
          ["NAME", (l) => l.name],
          ["TYPE", (l) => l.avatar_type],
          ["GROUP_ID", (l) => l.group_id],
          ["ENGINES", (l) => l.supported_api_engines],
          ["DEFAULT_VOICE", (l) => l.default_voice_id],
        ]);
      },
    );

  parent
    .command("voices")
    .description("List voices (voice_id for `heygen video`, `video-agent`, and `tts`)")
    .option("--language <name>", "Filter by language, e.g. English")
    .option("--gender <g>", "male | female")
    .option("--engine <e>", "Filter by engine, e.g. starfish | orca | elevenlabs")
    .option("--type <t>", "public (default) | private (your cloned voices)")
    .option("--limit <n>", `Page size (1-${LIMITS.voiceListMax})`)
    .option("--cursor <token>", "Next-page cursor from a previous call")
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        language?: string;
        gender?: string;
        engine?: string;
        type?: string;
        limit?: string;
        cursor?: string;
        json?: boolean;
      }) => {
        const type = oneOf(opts.type, OWNERSHIP_VALUES, "--type");
        const limit = pageLimit(opts.limit, LIMITS.voiceListMax);
        const client = createHeygenClientFromEnv();
        const page = await client.listVoices({
          language: opts.language,
          gender: opts.gender,
          engine: opts.engine,
          type,
          limit,
          token: opts.cursor,
        });
        printPage(page, opts.json, [
          ["VOICE_ID", (v) => v.voice_id],
          ["NAME", (v) => v.name],
          ["LANGUAGE", (v) => v.language],
          ["GENDER", (v) => v.gender],
          ["ENGINES", (v) => v.available_engines],
        ]);
      },
    );

  parent
    .command("styles")
    .description("List Video Agent visual styles (style_id for `heygen video-agent --style`)")
    .option("--tag <tag>", "Filter by tag, e.g. cinematic")
    .option("--limit <n>", `Page size (1-${LIMITS.stylesListMax})`)
    .option("--cursor <token>", "Next-page cursor from a previous call")
    .option("--json", "Print JSON")
    .action(async (opts: { tag?: string; limit?: string; cursor?: string; json?: boolean }) => {
      const limit = pageLimit(opts.limit, LIMITS.stylesListMax);
      const client = createHeygenClientFromEnv();
      const page = await client.listVideoAgentStyles({ tag: opts.tag, limit, token: opts.cursor });
      printPage(page, opts.json, [
        ["STYLE_ID", (s) => s.style_id],
        ["NAME", (s) => s.name],
        ["TAGS", (s) => s.tags],
        ["ASPECT", (s) => s.aspect_ratio],
      ]);
    });

  parent
    .command("languages")
    .description("List supported video translation target languages")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createHeygenClientFromEnv();
      const languages = await client.listTranslationLanguages();
      if (opts.json) console.log(JSON.stringify(languages, null, 2));
      else for (const l of languages) console.log(l);
    });

  parent
    .command("me")
    .description("Show the HeyGen account for the API key (billing type, API credits/balance)")
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createHeygenClientFromEnv();
      const me = await client.getCurrentUser();
      if (opts.json) {
        console.log(JSON.stringify(me, null, 2));
        return;
      }
      const name = [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username || "-";
      console.log(`User:         ${name}`);
      if (me.billing_type) console.log(`Billing type: ${me.billing_type}`);
      for (const key of ["wallet", "subscription", "usage_based"] as const) {
        if (me[key] !== undefined && me[key] !== null) {
          console.log(`${key}: ${JSON.stringify(me[key])}`);
        }
      }
    });
}
