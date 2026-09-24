import { describe, expect, it } from "vitest";
import {
  buildUpdateCommand,
  compareVersions,
  detectPackageManager,
  formatUpdateCommand,
  isNewerVersion,
} from "../../../src/core/package-manager.js";

describe("detectPackageManager", () => {
  it("detects pnpm from a global pnpm install path", () => {
    expect(
      detectPackageManager(
        "/home/user/.local/share/pnpm/global/5/node_modules/multix/dist/cli.js",
        {},
      ),
    ).toBe("pnpm");
  });

  it("detects yarn from a yarn global path", () => {
    expect(
      detectPackageManager("/home/user/.yarn/global/node_modules/multix/dist/cli.js", {}),
    ).toBe("yarn");
  });

  it("detects bun from a bun install path", () => {
    expect(detectPackageManager("/home/user/.bun/install/global/multix/dist/cli.js", {})).toBe(
      "bun",
    );
  });

  it("detects npm from a standard global npm path", () => {
    expect(detectPackageManager("/usr/local/lib/node_modules/multix/dist/cli.js", {})).toBe("npm");
  });

  it("falls back to npm_config_user_agent when path has no markers", () => {
    expect(
      detectPackageManager("/opt/custom/bin/multix", { npm_config_user_agent: "pnpm/9.0.0" }),
    ).toBe("pnpm");
  });

  it("defaults to npm when nothing matches", () => {
    expect(detectPackageManager("/opt/custom/bin/multix", {})).toBe("npm");
  });
});

describe("buildUpdateCommand", () => {
  it("builds npm install command for latest by default", () => {
    const cmd = buildUpdateCommand("npm");
    expect(cmd).toEqual({ command: "npm", args: ["i", "-g", "@mrgoonie/multix@latest"] });
  });

  it("builds pnpm command", () => {
    expect(buildUpdateCommand("pnpm")).toEqual({
      command: "pnpm",
      args: ["add", "-g", "@mrgoonie/multix@latest"],
    });
  });

  it("builds yarn command", () => {
    expect(buildUpdateCommand("yarn")).toEqual({
      command: "yarn",
      args: ["global", "add", "@mrgoonie/multix@latest"],
    });
  });

  it("builds bun command", () => {
    expect(buildUpdateCommand("bun")).toEqual({
      command: "bun",
      args: ["add", "-g", "@mrgoonie/multix@latest"],
    });
  });

  it("respects a custom dist-tag", () => {
    expect(buildUpdateCommand("npm", "beta")).toEqual({
      command: "npm",
      args: ["i", "-g", "@mrgoonie/multix@beta"],
    });
  });
});

describe("formatUpdateCommand", () => {
  it("joins command and args with spaces", () => {
    expect(formatUpdateCommand({ command: "npm", args: ["i", "-g", "pkg@latest"] })).toBe(
      "npm i -g pkg@latest",
    );
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("0.6.0", "0.7.0")).toBe(-1);
    expect(compareVersions("1.9.0", "2.0.0")).toBe(-1);
  });

  it("returns 1 when a > b", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("treats a release as newer than a prerelease with the same core", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });

  it("compares prerelease tags lexically when cores match", () => {
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
  });

  it("tolerates a leading v prefix", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });
});

describe("isNewerVersion", () => {
  it("is true when latest > current", () => {
    expect(isNewerVersion("0.6.0", "0.7.0")).toBe(true);
  });

  it("is false when latest === current", () => {
    expect(isNewerVersion("0.6.0", "0.6.0")).toBe(false);
  });

  it("is false when latest < current", () => {
    expect(isNewerVersion("0.7.0", "0.6.0")).toBe(false);
  });
});
