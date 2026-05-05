/**
 * multix elevenlabs voices — list, get, search shared, design, delete.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { createLogger } from "../../../core/logger.js";
import { apiDelete, apiGet, apiPostJson, requireElevenLabsKey, saveBytes } from "../client.js";
import { TASK_DEFAULTS, extFromFormat } from "../models.js";

interface VoicesListResp {
  voices: Array<{
    voice_id: string;
    name: string;
    category?: string;
    labels?: Record<string, string>;
    description?: string;
  }>;
}

interface SharedVoicesResp {
  voices: Array<{
    voice_id: string;
    name: string;
    description?: string;
    category?: string;
    free_users_allowed?: boolean;
  }>;
  has_more?: boolean;
}

interface VoicePreviewsResp {
  previews: Array<{
    audio_base_64: string;
    media_type: string;
    generated_voice_id: string;
  }>;
  text?: string;
}

export function registerVoicesCommand(parent: Command): void {
  const voices = parent.command("voices").description("Voice library: list, get, search, design");

  voices
    .command("list")
    .description("List voices in your account")
    .option("--category <c>", "Filter category (cloned, generated, premade, professional)")
    .option("--page-size <n>", "Voices per page", "100")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const apiKey = requireElevenLabsKey();
      const data = await apiGet<VoicesListResp>("voices", apiKey, {
        category: opts.category,
        page_size: opts.pageSize,
      });
      for (const v of data.voices) {
        const labels = v.labels ? ` [${Object.values(v.labels).join(", ")}]` : "";
        console.log(`${v.voice_id}\t${v.name}\t(${v.category ?? "?"})${labels}`);
      }
      console.log(`\n${data.voices.length} voices`);
    });

  voices
    .command("get <voiceId>")
    .description("Get a voice's metadata")
    .action(async (voiceId: string) => {
      const apiKey = requireElevenLabsKey();
      const data = await apiGet<unknown>(`voices/${voiceId}`, apiKey);
      console.log(JSON.stringify(data, null, 2));
    });

  voices
    .command("search")
    .description("Search the public Voices Library (shared voices)")
    .option("--search <term>", "Search query")
    .option("--language <code>", "Language filter, e.g. en, es")
    .option("--gender <g>", "male|female|neutral")
    .option("--age <a>", "young|middle_aged|old")
    .option("--accent <a>", "Accent filter, e.g. american, british")
    .option("--category <c>", "Category filter")
    .option("--page-size <n>", "Results per page", "30")
    .action(async (opts) => {
      const apiKey = requireElevenLabsKey();
      const data = await apiGet<SharedVoicesResp>("shared-voices", apiKey, {
        search: opts.search,
        language: opts.language,
        gender: opts.gender,
        age: opts.age,
        accent: opts.accent,
        category: opts.category,
        page_size: opts.pageSize,
      });
      for (const v of data.voices) {
        console.log(`${v.voice_id}\t${v.name}\t${v.description ?? ""}`);
      }
      console.log(`\n${data.voices.length} voices${data.has_more ? " (more available)" : ""}`);
    });

  voices
    .command("design")
    .description("Design a voice from text description (returns previews)")
    .requiredOption("--description <str>", "Voice description (e.g. 'friendly female narrator')")
    .option("--text <str>", "Sample text to generate previews from")
    .option("--auto-text", "Let ElevenLabs generate sample text", false)
    .option("--model <id>", "Voice design model", "eleven_multilingual_ttv_v2")
    .option("--output-prefix <p>", "Filename prefix (default: design)", "design")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();
      if (!opts.autoText && !opts.text) {
        throw new ValidationError("Provide --text or pass --auto-text");
      }
      const payload: Record<string, unknown> = {
        voice_description: opts.description,
        model_id: opts.model,
        auto_generate_text: opts.autoText,
      };
      if (opts.text) payload.text = opts.text;

      const data = await apiPostJson<VoicePreviewsResp>(
        "text-to-voice/create-previews",
        payload,
        apiKey,
      );
      logger.success(`${data.previews.length} previews generated`);
      data.previews.forEach((p, i) => {
        const bytes = Buffer.from(p.audio_base_64, "base64");
        const dest = saveBytes({
          bytes,
          task: `${opts.outputPrefix}_${i + 1}_${p.generated_voice_id}`,
          ext: extFromFormat(TASK_DEFAULTS.ttsFormat),
          logger,
        });
        console.log(`Preview ${i + 1}: voice_id=${p.generated_voice_id}  file=${dest}`);
      });
      console.log(
        '\nTo finalize: multix elevenlabs voices create-from-preview --generated-voice-id <id> --name "..." --description "..."',
      );
    });

  voices
    .command("create-from-preview")
    .description("Persist a designed voice into your library")
    .requiredOption("--generated-voice-id <id>", "ID returned by `voices design`")
    .requiredOption("--name <n>", "Display name")
    .requiredOption("--description <d>", "Voice description")
    .option("--played-not-selected-voice-ids <csv>", "Other previews you considered (CSV)")
    .action(async (opts) => {
      const apiKey = requireElevenLabsKey();
      const payload: Record<string, unknown> = {
        generated_voice_id: opts.generatedVoiceId,
        voice_name: opts.name,
        voice_description: opts.description,
      };
      if (opts.playedNotSelectedVoiceIds) {
        payload.played_not_selected_voice_ids = opts.playedNotSelectedVoiceIds.split(",");
      }
      const data = await apiPostJson<{ voice_id: string }>(
        "text-to-voice/create-voice-from-preview",
        payload,
        apiKey,
      );
      console.log(`Created voice: ${data.voice_id}`);
    });

  voices
    .command("delete <voiceId>")
    .description("Delete a voice from your library")
    .action(async (voiceId: string) => {
      const apiKey = requireElevenLabsKey();
      await apiDelete(`voices/${voiceId}`, apiKey);
      console.log(`Deleted: ${voiceId}`);
    });
}
