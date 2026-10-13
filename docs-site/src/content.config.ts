import { defineCollection } from "astro:content";
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Starlight always reads this collection for UI string overrides and Astro
  // warns when it is missing or empty. Keep at least one file in
  // src/content/i18n/: en.json is an empty override, so the built-in English
  // and Vietnamese UI strings still apply.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
