/**
 * Which env keys make each command group usable, so discovery commands can
 * say "ready" without calling a provider. Rows are AND-ed; names in a row are
 * alternatives (any one is enough). Groups not listed need no key.
 */

import { resolveKey } from "../../core/env-loader.js";

export const GROUP_KEY_ROWS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  gemini: [["GEMINI_API_KEY"]],
  doc: [["GEMINI_API_KEY"]],
  minimax: [["MINIMAX_API_KEY"]],
  openai: [["OPENAI_API_KEY"]],
  openrouter: [["OPENROUTER_API_KEY"]],
  leonardo: [["LEONARDO_API_KEY"]],
  byteplus: [["BYTEPLUS_API_KEY", "ARK_API_KEY"]],
  cloudflare: [["CLOUDFLARE_ACCOUNT_ID"], ["CLOUDFLARE_API_TOKEN"]],
  elevenlabs: [["ELEVENLABS_API_KEY"]],
  fal: [["FAL_KEY"]],
  fish: [["FISH_API_KEY"]],
  atlas: [["ATLASCLOUD_API_KEY"]],
  replicate: [["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]],
  runway: [["RUNWAYML_API_SECRET"]],
  heygen: [["HEYGEN_API_KEY"]],
  sume: [["SUME_API_KEY"]],
  // `multix speech` routes to one provider; any one of their keys makes it usable.
  speech: [
    [
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "ELEVENLABS_API_KEY",
      "MINIMAX_API_KEY",
      "ATLASCLOUD_API_KEY",
      "FISH_API_KEY",
      "OPENROUTER_API_KEY",
      "FAL_KEY",
    ],
  ],
  // A scene renders through the providers its voice profiles name; `scene
  // render` itself checks those exact keys before its first request.
  scene: [["GEMINI_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY"]],
};

/** Key env names a group reads (first of each row), for messages. */
export function groupKeyNames(group: string): string[] {
  return (GROUP_KEY_ROWS[group] ?? []).map((row) => row.join("|"));
}

/** True when every required row has at least one non-blank key set. */
export function groupReady(group: string): boolean {
  const rows = GROUP_KEY_ROWS[group];
  if (!rows) return true;
  return rows.every((row) => row.some((name) => Boolean(resolveKey(name)?.trim())));
}
