/**
 * multix elevenlabs account / models — user info, subscription, model list.
 */

import type { Command } from "commander";
import { apiGet, requireElevenLabsKey } from "../client.js";

interface UserResp {
  subscription?: {
    tier?: string;
    character_count?: number;
    character_limit?: number;
    next_character_count_reset_unix?: number;
    voice_limit?: number;
    professional_voice_limit?: number;
    can_extend_character_limit?: boolean;
  };
  is_new_user?: boolean;
  xi_api_key?: string;
  first_name?: string;
}

interface ModelsResp
  extends Array<{
    model_id: string;
    name?: string;
    can_do_text_to_speech?: boolean;
    can_do_voice_conversion?: boolean;
    languages?: Array<{ language_id: string; name: string }>;
    maximum_text_length_per_request?: number;
    model_rates?: { character_cost_multiplier?: number };
  }> {}

export function registerAccountCommands(parent: Command): void {
  parent
    .command("account")
    .description("Show ElevenLabs account info, subscription tier, and usage")
    .action(async () => {
      const apiKey = requireElevenLabsKey();
      const user = await apiGet<UserResp>("user", apiKey);
      const sub = user.subscription ?? {};
      console.log(`Tier:           ${sub.tier ?? "?"}`);
      console.log(`Characters:     ${sub.character_count ?? "?"} / ${sub.character_limit ?? "?"}`);
      if (sub.next_character_count_reset_unix) {
        console.log(
          `Resets:         ${new Date(sub.next_character_count_reset_unix * 1000).toISOString()}`,
        );
      }
      console.log(
        `Voice slots:    ${sub.voice_limit ?? "?"} (PVC: ${sub.professional_voice_limit ?? 0})`,
      );
      if (user.first_name) console.log(`Name:           ${user.first_name}`);
    });

  parent
    .command("models")
    .description(
      "List ElevenLabs models live: capabilities, languages, character limit and cost multiplier",
    )
    .action(async () => {
      const apiKey = requireElevenLabsKey();
      const models = await apiGet<ModelsResp>("models", apiKey);
      for (const m of models) {
        const caps: string[] = [];
        if (m.can_do_text_to_speech) caps.push("tts");
        if (m.can_do_voice_conversion) caps.push("vc");
        const details = [
          m.languages?.length ? `${m.languages.length} langs` : "",
          m.maximum_text_length_per_request ? `max ${m.maximum_text_length_per_request} chars` : "",
          m.model_rates?.character_cost_multiplier !== undefined
            ? `x${m.model_rates.character_cost_multiplier} char cost`
            : "",
        ].filter(Boolean);
        console.log(`${m.model_id}\t${m.name ?? ""}\t[${caps.join(",")}] ${details.join(", ")}`);
      }
      console.log(`\n${models.length} models`);
    });
}
