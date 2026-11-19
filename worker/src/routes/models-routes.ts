/**
 * GET /models (HTML) and GET /models.json: the public model and price list.
 * No sign-in; live provider prices are cached for LIVE_TTL_S (models-catalog-data.ts).
 */

import type { AppDeps } from "../app-context.js";
import type { WorkerEnv } from "../config.js";
import { html, json, text } from "../http-responses.js";
import { modelsPage } from "../pages/models-page.js";
import { resolvePreferences, withPreferenceCookies } from "../pages/preferences.js";
import { buildModelsData, liveSnapshot } from "./models-catalog-data.js";

export const MODELS_PATH = "/models";
export const MODELS_JSON_PATH = "/models.json";

export function isModelsPath(pathname: string): boolean {
  return pathname === MODELS_PATH || pathname === MODELS_JSON_PATH;
}

export async function handleModels(
  request: Request,
  env: WorkerEnv,
  deps: AppDeps,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return text(405, "Method Not Allowed", { allow: "GET, HEAD" });
  }
  const fetchFn = (deps.fetch as typeof fetch | undefined) ?? ((input, init) => fetch(input, init));
  const key = env.MULTIX_PRICING_FAL_KEY?.trim() || undefined;
  const snap = await liveSnapshot(fetchFn, key).catch(() => undefined);
  const data = buildModelsData(snap);
  const { pathname } = new URL(request.url);
  if (pathname === MODELS_JSON_PATH) {
    return json(200, data, { "access-control-allow-origin": "*" });
  }
  const preferences = resolvePreferences(request);
  return html(200, modelsPage(data, preferences.prefs), withPreferenceCookies(preferences));
}
