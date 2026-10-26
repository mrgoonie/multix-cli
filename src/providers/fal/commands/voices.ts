/**
 * multix fal voices [model] — the fal TTS models `fal tts` has a verified
 * schema for: typed inputs (field per flag), voices, output formats and
 * latency. `--live` adds fal's current text-to-speech catalog (public, no key
 * sent); those ids run through `fal tts --text-field` or `fal run`.
 */

import type { Command } from "commander";
import { run } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { FAL_DEFAULTS } from "../models.js";
import {
  FAL_SPEECH_MODELS,
  type FalSpeechModel,
  findSpeechModel,
  listFalSpeechCatalog,
} from "../speech-models.js";

/** The typed view of one model: which flag fills which input field. */
function describe(m: FalSpeechModel) {
  return {
    model: m.id,
    label: m.label,
    default: m.id === FAL_DEFAULTS.ttsModel,
    latency: m.latency,
    async: true,
    inputs: {
      text: {
        field: m.textField,
        required: true,
        ...(m.maxTextChars ? { max_chars: m.maxTextChars } : {}),
      },
      voice: {
        field: m.voiceField,
        default: m.defaultVoice,
        ...(m.voices ? { values: m.voices } : { examples: m.exampleVoices, open: true }),
      },
      ...(m.styleField ? { style: { field: m.styleField } } : {}),
      ...(m.languageField ? { language: { field: m.languageField } } : {}),
      ...(m.formatField
        ? { format: { field: m.formatField, default: m.defaultFormat, values: m.formats } }
        : {}),
      ...(m.dialogueField ? { dialogue: { field: m.dialogueField, via: "--input" } } : {}),
    },
    output: m.formatField ? `by --format (default ${m.defaultFormat})` : m.output,
    docs: `https://fal.ai/models/${m.id}/api`,
  };
}

export function registerFalVoicesCommand(parent: Command): void {
  parent
    .command("voices [model]")
    .description(
      "List fal TTS models for `fal tts`: typed inputs, voices, output formats, latency (--live: fal's current TTS catalog)",
    )
    .option("--live", "Also list fal's current text-to-speech endpoints from its public catalog")
    .action(async (model: string | undefined, opts: { live?: boolean }) => {
      let models = FAL_SPEECH_MODELS;
      if (model) {
        const found = findSpeechModel(model);
        if (!found) {
          throw new ValidationError(
            `No verified schema for ${model}. Verified: ${FAL_SPEECH_MODELS.map((m) => m.id).join(", ")}. Run it with: multix fal tts --model ${model} --text-field <field>`,
          );
        }
        models = [found];
      }
      const verified = models.map(describe);
      const live = opts.live ? await listFalSpeechCatalog(globalThis.fetch) : undefined;
      const others = live?.filter((c) => !findSpeechModel(c.endpoint_id));

      if (run.json || model) {
        console.log(
          JSON.stringify(
            model ? verified[0] : { verified, ...(others ? { catalog: others } : {}) },
            null,
            run.json ? undefined : 2,
          ),
        );
        return;
      }
      for (const v of verified) {
        const voice = v.inputs.voice;
        const voices =
          "values" in voice && voice.values
            ? `${voice.values.length} voices (default ${voice.default})`
            : `any voice name or id (default ${voice.default})`;
        console.log(`${v.model}${v.default ? "  [default]" : ""}`);
        console.log(`  ${v.label}; ${v.latency} latency; output ${v.output}; ${voices}`);
        console.log(
          `  flags -> fields: ${Object.entries(v.inputs)
            .map(([flag, i]) => `${flag}=${i.field}`)
            .join(", ")}`,
        );
      }
      console.log("\nDetails: multix fal voices <model>   (JSON: add --json)");
      if (others) {
        console.log(`\nOther fal text-to-speech endpoints (${others.length}), unverified schema:`);
        for (const c of others)
          console.log(`  ${c.endpoint_id}${c.display_name ? `  ${c.display_name}` : ""}`);
        console.log(
          "Run one with: multix fal tts --model <id> --text-field <field>  or  multix fal run <id>",
        );
      }
    });
}
