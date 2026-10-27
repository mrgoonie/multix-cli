import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflows", () => {
  it("auto-completes stable releases from the main release-please workflow", () => {
    const workflow = fs.readFileSync(".github/workflows/release-please.yml", "utf8");

    expect(workflow).toContain("id: release");
    expect(workflow).toContain("steps.release.outputs.prs_created");
    expect(workflow).toContain("Resolve release PR");
    expect(workflow).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(workflow).toContain("Validate stable release PR");
    expect(workflow).toContain("gh pr merge");
    expect(workflow).toContain(
      'gh pr merge "${{ steps.release-pr.outputs.number }}" --repo "$GITHUB_REPOSITORY"',
    );
    expect(workflow).toContain("skip-github-pull-request: true");
    expect(workflow).toContain("npm publish --access public --tag latest");
    expect(workflow).toContain("npm install -g npm@latest");
    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).toContain("id-token: write");
  });

  it("hands beta releases to publish.yml, the npm trusted publisher", () => {
    const workflow = fs.readFileSync(".github/workflows/release-please-beta.yml", "utf8");
    const publish = fs.readFileSync(".github/workflows/publish.yml", "utf8");

    expect(workflow).toContain("id: release");
    expect(workflow).toContain("steps.release.outputs.release_created");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain(
      'gh workflow run publish.yml --repo "$GITHUB_REPOSITORY" --ref "$TAG_NAME" -f tag=beta',
    );
    expect(workflow).toContain("TAG_NAME: ${{ steps.release.outputs.tag_name }}");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("secrets.NPM_TOKEN");

    expect(publish).toContain("workflow_dispatch:");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain(
      'npm publish --access public --tag "${{ steps.dist-tag.outputs.tag }}"',
    );
    expect(publish).not.toContain("secrets.NPM_TOKEN");
  });
});
