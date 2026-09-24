/**
 * multix update — self-update the CLI to the latest (or a given dist-tag)
 * published version.
 *
 * Detects the package manager that installed the running binary and runs its
 * matching global-install command. `--check` only compares versions against
 * the npm registry without installing. `--dry-run` prints the command instead
 * of running it.
 */

import { createRequire } from "node:module";
import type { Command } from "commander";
import { execa } from "execa";
import { HttpError } from "../core/errors.js";
import { httpJson } from "../core/http-client.js";
import { createLogger } from "../core/logger.js";
import {
  buildUpdateCommand,
  compareVersions,
  detectPackageManager,
  formatUpdateCommand,
} from "../core/package-manager.js";

const PACKAGE_NAME = "@mrgoonie/multix";
const REGISTRY_BASE = "https://registry.npmjs.org";

const require = createRequire(import.meta.url);

export function getCurrentVersion(): string {
  // biome-ignore lint/suspicious/noExplicitAny: JSON import
  const pkg = require("../../package.json") as any;
  return pkg.version as string;
}

interface RegistryVersionDoc {
  version: string;
}

/** Fetch the published version for a dist-tag (default "latest") from the npm registry. */
export async function fetchRegistryVersion(tag = "latest"): Promise<string> {
  try {
    const doc = await httpJson<RegistryVersionDoc>({
      url: `${REGISTRY_BASE}/${PACKAGE_NAME}/${encodeURIComponent(tag)}`,
    });
    if (!doc.version) {
      throw new Error(`Registry response for tag "${tag}" is missing a version field`);
    }
    return doc.version;
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 404) {
        throw new Error(`Dist-tag "${tag}" does not exist for ${PACKAGE_NAME}`);
      }
      throw new Error(`Failed to reach npm registry: ${e.message}`);
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to reach npm registry: ${msg}`);
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update multix to the latest (or a given dist-tag) published version")
    .option("--check", "Only compare current vs. latest version; do not install")
    .option(
      "--tag <tag>",
      "Install a specific dist-tag instead of latest (always installs, skipping the up-to-date check)",
    )
    .option("--dry-run", "Print the install command instead of running it")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: { check?: boolean; tag?: string; dryRun?: boolean; verbose?: boolean }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const currentVersion = getCurrentVersion();
        const explicitTag = opts.tag !== undefined;
        const tag = opts.tag ?? "latest";

        logger.info(`Current version: ${currentVersion}`);
        logger.info(`Checking npm registry for "${tag}"...`);

        let latestVersion: string;
        try {
          latestVersion = await fetchRegistryVersion(tag);
        } catch (e) {
          logger.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }

        const cmp = compareVersions(latestVersion, currentVersion);

        if (opts.check) {
          if (cmp > 0) {
            logger.info(`Update available: ${currentVersion} -> ${latestVersion}`);
            console.log(`Run \`multix update\` to install ${latestVersion}.`);
          } else {
            logger.success(`Already up to date (${currentVersion}).`);
          }
          return;
        }

        if (!explicitTag && cmp <= 0) {
          logger.success(`Already up to date (${currentVersion}).`);
          return;
        }
        if (explicitTag && cmp <= 0) {
          logger.info(
            `Requested tag "${tag}" (${latestVersion}) — installing regardless of current version (${currentVersion}).`,
          );
        }

        const pm = detectPackageManager(process.argv[1] ?? process.execPath);
        const updateCmd = buildUpdateCommand(pm, tag);
        const commandStr = formatUpdateCommand(updateCmd);

        logger.info(`Detected package manager: ${pm}`);
        logger.info(`Updating ${currentVersion} -> ${latestVersion}`);

        if (opts.dryRun) {
          console.log(commandStr);
          return;
        }

        logger.info(`Running: ${commandStr}`);
        try {
          await execa(updateCmd.command, updateCmd.args, { stdio: "inherit" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(`Update command failed: ${msg}`);
          logger.info(`You can run it manually: ${commandStr}`);
          process.exit(1);
        }

        logger.success(`Updated to ${latestVersion}.`);
      },
    );
}
