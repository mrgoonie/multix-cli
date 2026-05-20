import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflows", () => {
  it("auto-completes stable releases from the main release-please workflow", () => {
    const workflow = fs.readFileSync(".github/workflows/release-please.yml", "utf8");

    expect(workflow).toContain("id: release");
    expect(workflow).toContain("steps.release.outputs.prs_created");
    expect(workflow).toContain("Resolve release PR");
    expect(workflow).toContain("Validate stable release PR");
    expect(workflow).toContain("gh pr merge");
    expect(workflow).toContain("skip-github-pull-request: true");
    expect(workflow).toContain("npm publish --access public --tag latest --provenance");
    expect(workflow).toContain("id-token: write");
  });

  it("publishes beta npm releases in the release-please workflow", () => {
    const workflow = fs.readFileSync(".github/workflows/release-please-beta.yml", "utf8");

    expect(workflow).toContain("id: release");
    expect(workflow).toContain("steps.release.outputs.release_created");
    expect(workflow).toContain("npm publish --access public --tag beta --provenance");
    expect(workflow).toContain("id-token: write");
  });
});
