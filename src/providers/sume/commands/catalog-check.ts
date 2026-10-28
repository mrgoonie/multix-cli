/**
 * Pre-submit check of a request against the model's entry in Sume's public
 * catalogue (cached like `multix models --live`). The catalogue is read
 * around the fetch telemetry: it is free, keyless, and not part of the paid
 * request a --dry-run shows.
 */

import { untrackedFetch } from "../../../agent/fetch-telemetry.js";
import { discoverSumeCatalog } from "../../../commands/agent/model-discovery-cache.js";
import { ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { type SumeCatalogModel, validateAgainstCatalog } from "../catalog.js";
import type { SumeRouter } from "../request.js";
import type { SumeRequestBody } from "../types.js";

/**
 * The catalogue entry for `model`, or undefined when the catalogue cannot be
 * read (the server's own 400 then reports bad input). A model missing from a
 * cached copy is looked up again in a fresh read before it is called unknown.
 */
export async function findCatalogModel(
  model: string,
  logger: Logger,
): Promise<SumeCatalogModel | undefined> {
  let result = await discoverSumeCatalog({ fetchFn: untrackedFetch });
  let found = result.catalog?.models.find((m) => m.id === model);
  if (!found && result.catalog && result.state !== "fresh") {
    const fresh = await discoverSumeCatalog({ fetchFn: untrackedFetch, refresh: true });
    if (fresh.catalog) {
      result = fresh;
      found = fresh.catalog.models.find((m) => m.id === model);
    } else {
      logger.debug(`Sume catalogue refresh failed (${fresh.error}); not checking model ${model}`);
      return undefined;
    }
  }
  if (!result.catalog) {
    logger.debug(
      `Sume catalogue unavailable (${result.error}); sending ${model} without a local check`,
    );
    return undefined;
  }
  if (!found) {
    throw new ValidationError(
      `Unknown Sume model "${model}". Run \`multix sume models\` for the current model ids`,
    );
  }
  return found;
}

/** Validate `body` for `router` against the catalogue (when it can be read). */
export async function checkAgainstCatalog(
  router: SumeRouter,
  body: SumeRequestBody,
  logger: Logger,
): Promise<SumeCatalogModel | undefined> {
  const model = await findCatalogModel(body.model, logger);
  if (model) validateAgainstCatalog(model, body, router);
  return model;
}
