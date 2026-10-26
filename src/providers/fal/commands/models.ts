/**
 * multix fal models — find fal endpoint ids: live from fal's public catalog
 * (by category or search text; no key needed, none is sent), or offline with
 * --typed for the endpoints `fal tts` knows field by field.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { listFalModels } from "../catalog.js";
import { FAL_TTS_PROFILES, type FalTtsProfile, findTtsProfile } from "../tts-models.js";

/** What `fal tts` accepts for a typed endpoint, in flag terms. */
export function describeTtsProfile(p: FalTtsProfile) {
  return {
    endpoint_id: p.id,
    command: `multix fal tts -m ${p.id}`,
    text_field: p.textField,
    ...(p.maxChars ? { max_chars: p.maxChars } : {}),
    ...(p.dialogueField ? { dialogue_field: p.dialogueField } : {}),
    voice: { default: p.defaultVoice, ...(p.voices ? { values: p.voices } : {}) },
    ...(p.styleField ? { style_field: p.styleField } : {}),
    ...(p.formats ? { formats: { default: p.defaultFormat, values: p.formats } } : {}),
    ...(p.languageField ? { language_field: p.languageField } : {}),
    output: p.output,
    latency: p.latency,
    async: true,
  };
}

export function registerFalModelsCommand(parent: Command): void {
  parent
    .command("models")
    .description(
      "List fal endpoint ids from fal's live catalog (e.g. --category text-to-speech), or --typed TTS profiles offline",
    )
    .option("-c, --category <name>", "Catalog category, e.g. text-to-speech, text-to-image")
    .option("-q, --query <text>", "Search text, e.g. gemini tts")
    .option("--limit <n>", "Max models to list", "50")
    .option("--typed", "Offline: the TTS endpoints `fal tts` validates field by field")
    .option("--json", "Print JSON")
    .action(
      async (opts: {
        category?: string;
        query?: string;
        limit: string;
        typed?: boolean;
        json?: boolean;
      }) => {
        if (opts.typed) {
          const rows = FAL_TTS_PROFILES.map(describeTtsProfile);
          if (opts.json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
          }
          for (const r of rows) {
            console.log(`${r.endpoint_id}`);
            console.log(
              `  text: ${r.text_field}${r.max_chars ? ` (max ${r.max_chars} chars)` : ""}`,
            );
            console.log(
              `  voice: ${r.voice.default}${r.voice.values ? ` (one of ${r.voice.values.length})` : " (any voice name or id)"}`,
            );
            if (r.style_field) console.log(`  --style -> ${r.style_field}`);
            if (r.formats) console.log(`  --format: ${r.formats.values.join(", ")}`);
            if (r.language_field) console.log(`  --language -> ${r.language_field}`);
            console.log(`  output: ${r.output}, ${r.latency}`);
          }
          return;
        }

        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new ValidationError(`Invalid --limit: ${opts.limit} (1-1000)`);
        }
        const models = await listFalModels({
          category: opts.category?.trim() || undefined,
          query: opts.query?.trim() || undefined,
          limit,
        });
        const rows = models.map((m) => ({
          ...m,
          ...(findTtsProfile(m.endpoint_id) ? { typed: true } : {}),
        }));
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log("No fal models matched.");
          return;
        }
        const width = Math.max(...rows.map((r) => r.endpoint_id.length));
        for (const r of rows) {
          const tags = [r.category, r.status !== "active" ? r.status : "", r.typed ? "typed" : ""]
            .filter(Boolean)
            .join(", ");
          console.log(`${r.endpoint_id.padEnd(width)}  ${r.display_name ?? ""}  [${tags}]`);
        }
      },
    );
}
