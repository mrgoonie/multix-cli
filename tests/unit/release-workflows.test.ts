import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflows", () => {
  it("publishes beta npm releases in the release-please workflow", () => {
    const workflow = fs.readFileSync(".github/workflows/release-please-beta.yml", "utf8");

    expect(workflow).toContain("id: release");
    expect(workflow).toContain("steps.release.outputs.release_created");
    expect(workflow).toContain("npm publish --access public --tag beta --provenance");
    expect(workflow).toContain("id-token: write");
  });
});
