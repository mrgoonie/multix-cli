/**
 * Package-manager detection and self-update command construction.
 * Pure functions only — no I/O — so they are trivially unit-testable.
 * Actual process execution/network calls live in src/commands/update.ts.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const PACKAGE_NAME = "@mrgoonie/multix";

/**
 * Detect which package manager most likely installed/runs this CLI.
 * Inspects the resolved path of the running script (global installs put the
 * package manager's name in the path) and falls back to the
 * `npm_config_user_agent` env var set when invoked from within a pm script.
 * Defaults to "npm" when nothing else matches.
 */
export function detectPackageManager(
  execPath: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  const normalized = execPath.replace(/\\/g, "/").toLowerCase();

  if (normalized.includes("/.bun/") || normalized.includes("/bun/install/")) return "bun";
  if (
    normalized.includes("/.pnpm/") ||
    normalized.includes("/pnpm/") ||
    normalized.includes("/pnpm-global/")
  )
    return "pnpm";
  if (normalized.includes("/yarn/") || normalized.includes("/.yarn/")) return "yarn";
  if (
    normalized.includes("/.npm/") ||
    normalized.includes("/npm/") ||
    normalized.includes("/node_modules/")
  )
    return "npm";

  const userAgent = env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("bun")) return "bun";
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("npm")) return "npm";

  return "npm";
}

export interface UpdateCommand {
  command: string;
  args: string[];
}

/** Build the global-install command for the detected package manager. */
export function buildUpdateCommand(pm: PackageManager, tag = "latest"): UpdateCommand {
  const spec = `${PACKAGE_NAME}@${tag}`;
  switch (pm) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "-g", spec] };
    case "yarn":
      return { command: "yarn", args: ["global", "add", spec] };
    case "bun":
      return { command: "bun", args: ["add", "-g", spec] };
    default:
      return { command: "npm", args: ["i", "-g", spec] };
  }
}

/** Format an UpdateCommand for display/dry-run output. */
export function formatUpdateCommand(cmd: UpdateCommand): string {
  return [cmd.command, ...cmd.args].join(" ");
}

/**
 * Compare two semver-ish version strings (major.minor.patch[-prerelease]).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * A version without a prerelease tag is considered newer than one with the
 * same numeric core plus a prerelease tag (standard semver precedence).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) => {
    const [core, prerelease] = v.replace(/^v/, "").split("-", 2);
    const parts = (core ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    return { parts, prerelease };
  };

  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < 3; i++) {
    const na = pa.parts[i] ?? 0;
    const nb = pb.parts[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }

  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === undefined) return 1; // a is release, b is prerelease -> a newer
  if (pb.prerelease === undefined) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareVersions(latest, current) === 1;
}
