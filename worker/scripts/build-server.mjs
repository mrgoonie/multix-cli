/**
 * Bundles the standalone server (server/multix-server.ts) into one ESM file,
 * dist-server/multix-server.mjs, with the same Worker source the Cloudflare
 * deployment uses. `cloudflare:workers` is aliased to the Node shim; Node
 * built-ins stay external. Run `npm run skills` first (the skills catalogue
 * JSON is generated and imported).
 *
 *   node scripts/build-server.mjs [--version 1.2.3]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const versionFlag = args.indexOf("--version");
const version =
  versionFlag >= 0
    ? args[versionFlag + 1]
    : JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")).version;

await build({
  entryPoints: [join(root, "server", "multix-server.ts")],
  outfile: join(root, "dist-server", "multix-server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "linked",
  alias: { "cloudflare:workers": join(root, "server", "cloudflare-workers-shim.ts") },
  define: { MULTIX_SERVER_VERSION: JSON.stringify(version) },
  // Some bundled CommonJS dependencies call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __multixCreateRequire } from 'node:module'; const require = __multixCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
