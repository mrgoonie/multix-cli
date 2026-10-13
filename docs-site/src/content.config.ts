import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Starlight always reads this collection for UI string overrides and Astro
  // warns when it is missing or empty, so src/content/i18n/en.json stays as an
  // empty override: the built-in English and Vietnamese UI strings apply.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
