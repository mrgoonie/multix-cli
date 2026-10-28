/**
 * Languages of the HTML pages. English is the default; Vietnamese is used
 * when the visitor chose it (`?lang=vi`, then the `multix-lang` cookie) or,
 * without a choice, when Accept-Language ranks `vi` above `en`.
 */

import { EN, type Messages } from "./i18n-en.js";
import { VI } from "./i18n-vi.js";

export type { Messages } from "./i18n-en.js";

export const LANGS = ["en", "vi"] as const;
export type Lang = (typeof LANGS)[number];

const MESSAGES: Record<Lang, Messages> = { en: EN, vi: VI };

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "vi";
}

export function messagesFor(lang: Lang): Messages {
  return MESSAGES[lang];
}

/**
 * The supported language the Accept-Language header ranks highest, by
 * q-value and then by order; `en` when it names neither.
 */
export function negotiateLanguage(header: string | null): Lang {
  if (!header) return "en";
  let best: { lang: Lang; q: number } | undefined;
  for (const part of header.split(",")) {
    const [range = "", ...params] = part.trim().split(";");
    const primary = range.trim().toLowerCase().split("-")[0];
    if (!isLang(primary)) continue;
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { lang: primary, q };
  }
  return best?.lang ?? "en";
}
