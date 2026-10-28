/**
 * Language and theme of the HTML pages, chosen without JavaScript.
 *
 * The EN/VI and Auto/Light/Dark switches are plain links that add `?lang=` or
 * `?theme=` to the current page. A valid value wins for that response and is
 * stored in a cookie (`multix-lang`, `multix-theme`) for later visits.
 * Otherwise the cookie decides, then Accept-Language (language) or the system
 * preference (theme "auto": the page carries no `data-theme`, so the design
 * tokens' `prefers-color-scheme` rule applies). Rendering the theme on the
 * server is what keeps the page from flashing the wrong colours.
 */

import { type Lang, isLang, negotiateLanguage } from "./i18n.js";

export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const LANG_COOKIE = "multix-lang";
export const THEME_COOKIE = "multix-theme";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export interface Preferences {
  lang: Lang;
  theme: Theme;
}

export const DEFAULT_PREFERENCES: Preferences = { lang: "en", theme: "auto" };

/** Preferences for one request, plus the Set-Cookie values that store a new choice. */
export interface ResolvedPreferences {
  prefs: Preferences;
  cookies: string[];
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function preferenceCookie(name: string, value: string): string {
  return `${name}=${value}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax; Secure`;
}

export function resolvePreferences(request: Request): ResolvedPreferences {
  const params = new URL(request.url).searchParams;
  const cookies: string[] = [];

  const langParam = params.get("lang");
  let lang: Lang;
  if (isLang(langParam)) {
    lang = langParam;
    cookies.push(preferenceCookie(LANG_COOKIE, langParam));
  } else {
    const stored = cookieValue(request, LANG_COOKIE);
    lang = isLang(stored) ? stored : negotiateLanguage(request.headers.get("accept-language"));
  }

  const themeParam = params.get("theme");
  let theme: Theme;
  if (isTheme(themeParam)) {
    theme = themeParam;
    cookies.push(preferenceCookie(THEME_COOKIE, themeParam));
  } else {
    const stored = cookieValue(request, THEME_COOKIE);
    theme = isTheme(stored) ? stored : "auto";
  }

  return { prefs: { lang, theme }, cookies };
}

/** Headers for an HTML response, with the cookies that store a new choice appended. */
export function withPreferenceCookies(
  resolved: ResolvedPreferences,
  headers: HeadersInit = {},
): Headers {
  const out = new Headers(headers);
  for (const cookie of resolved.cookies) out.append("set-cookie", cookie);
  return out;
}

/**
 * The page's own URL (path and query) without the switch parameters and
 * one-time notices, used as the base of the switch links.
 */
export function selfPath(request: Request): string {
  const url = new URL(request.url);
  for (const key of ["lang", "theme", "notice"]) url.searchParams.delete(key);
  return `${url.pathname}${url.search}`;
}

/** `here` with one switch parameter set, e.g. `/dashboard?lang=vi`. */
export function switchHref(here: string, key: "lang" | "theme", value: string): string {
  const url = new URL(here, "https://multix.invalid");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}
