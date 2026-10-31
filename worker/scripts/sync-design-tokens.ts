#!/usr/bin/env node
/**
 * Regenerate src/pages/design-tokens.ts from docs-site/src/styles/tokens.css,
 * the single token source shared by the landing page, the docs and the dashboard.
 * Usage (from worker/): npm run tokens
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { designTokensModule } from "./design-tokens-module.js";

const source = fileURLToPath(new URL("../../docs-site/src/styles/tokens.css", import.meta.url));
const output = fileURLToPath(new URL("../src/pages/design-tokens.ts", import.meta.url));

writeFileSync(output, designTokensModule(readFileSync(source, "utf8")));
console.log(`wrote ${output}`);
