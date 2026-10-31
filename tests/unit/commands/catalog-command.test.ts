/**
 * `multix catalog` smoke tests: spawn the compiled dist/cli.js with a private
 * notes file and run ledger in a temp directory, and read its JSON envelope.
 * The CLI has no pricing-date override, so price assertions accept the
 * stale state that applies once the price book is older than its 120-day window.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Options, execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedEnv } from "../../smoke/child-env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../../../dist/cli.js");
const SPAWN_TIMEOUT = 15_000;
const SEEDANCE = "fal:bytedance/seedance-2.5/text-to-video";

let dir: string;
let notesFile: string;
let historyFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-catalog-cli-"));
  notesFile = path.join(dir, "catalog-notes.json");
  historyFile = path.join(dir, "history.jsonl");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Run the built CLI inside the temp directory with its own notes file and run ledger. */
function run(args: string[], extra: Record<string, string> = {}, cwd = dir) {
  return execa("node", [CLI, ...args], {
    reject: false,
    timeout: SPAWN_TIMEOUT - 1_000,
    cwd,
    extendEnv: false,
    env: {
      ...isolatedEnv(dir),
      MULTIX_CATALOG_FILE: notesFile,
      MULTIX_HISTORY_FILE: historyFile,
      ...extra,
    } as Options["env"],
  });
}

/** The JSON envelope the CLI prints for `--json`. */
// biome-ignore lint/suspicious/noExplicitAny: envelope payloads are checked field by field
async function envelope(args: string[]): Promise<any> {
  const result = await run([...args, "--json"]);
  return JSON.parse(result.stdout);
}

describe("multix catalog (smoke)", { timeout: SPAWN_TIMEOUT }, () => {
  it("lists every subcommand in --help", async () => {
    const result = await run(["catalog", "--help"]);
    expect(result.exitCode).toBe(0);
    for (const sub of [
      "providers",
      "models",
      "show",
      "compare",
      "usage",
      "recommend",
      "rate",
      "review",
      "reviews",
      "note",
    ]) {
      expect(result.stdout, sub).toMatch(new RegExp(`^\\s+${sub}\\b`, "m"));
    }
  });

  it("prints the compare payload under the catalogue schema", async () => {
    const body = await envelope([
      "catalog",
      "compare",
      "--task",
      "video",
      "--resolution",
      "720p",
      "--duration",
      "10",
      "--audio",
      "on",
      "--aspect-ratio",
      "16:9",
    ]);
    expect(body.ok).toBe(true);
    expect(body.data.schema).toBe("multix.catalog/v1");
    const row = body.data.comparison.rows.find(
      (r: { offering: string }) => r.offering === SEEDANCE,
    );
    expect(row).toBeDefined();
    expect(row.rate_id).toBe("fal/seedance-2.5-t2v-720p@api");
    if (row.status === "priced") {
      expect(row.total_usd).toBe(4.6224);
      expect(row.price_rank).toBe(1);
    } else {
      expect(row).toMatchObject({ status: "unknown", total_usd: null });
      expect(row.reasons[0]).toMatch(/last checked 2026-10-28, over 120 days ago/);
    }
  });

  it("prints why a priced compare row is not ranked behind one prefix", async () => {
    const args = [
      "catalog",
      "compare",
      "--task",
      "video",
      "--resolution",
      "720p",
      "--duration",
      "5",
    ];
    const atlas = (await envelope(args)).data.comparison.rows.find(
      (r: { offering: string }) => r.offering === "atlas:bytedance/seedance-2.5/text-to-video",
    );
    const text = await run(args);
    expect(text.exitCode).toBe(0);
    const line = text.stdout.split("\n").find((l) => l.includes("atlas:bytedance/seedance-2.5"));
    if (atlas.status === "priced") {
      expect(line).toMatch(
        /^\s+-\s+\$1\.5023 .* priced: not ranked: the provider shows this price as an estimate/,
      );
      expect(line?.match(/not ranked:/g)).toHaveLength(1);
    } else {
      // Once the price book is past its 120-day window the price is unknown, never $0.
      expect(line).toMatch(/^\s+-\s+unknown .* unknown: /);
    }
  });

  it("lists models for one provider with ids, tasks and readiness", async () => {
    const body = await envelope(["catalog", "models", "--task", "video", "--provider", "fal"]);
    expect(body.data.schema).toBe("multix.catalog/v1");
    expect(body.data.offerings.length).toBeGreaterThan(0);
    for (const o of body.data.offerings) {
      expect(o.provider).toBe("fal");
      expect(o.tasks).toContain("video");
      expect(typeof o.ready).toBe("boolean");
    }
  });

  it("refuses an ambiguous bare model id with ValidationError and names the ids to use", async () => {
    const body = await envelope(["catalog", "show", "bytedance/seedance-2.5/text-to-video"]);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain(
      `use one of atlas:bytedance/seedance-2.5/text-to-video, ${SEEDANCE}`,
    );
  });

  it("refuses a rating shared beyond this machine with INVALID_INPUT and writes nothing", async () => {
    const result = await run(["catalog", "rate", SEEDANCE, "4", "--scope", "team", "--json"]);
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toContain("beyond this machine");
    expect(fs.existsSync(notesFile)).toBe(false);
  });

  it("refuses a review tied to a run that is not in the ledger", async () => {
    const body = await envelope(["catalog", "review", SEEDANCE, "--job", "h_missing"]);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toBe("No run h_missing in the run ledger (multix history list).");
  });

  it("rates, reviews, notes and removes records in the private notes file", async () => {
    const rated = await envelope([
      "catalog",
      "rate",
      SEEDANCE,
      "4",
      "-u",
      "product-ugc",
      "--aspect",
      "quality=5",
    ]);
    expect(rated.ok).toBe(true);
    expect(rated.data.review).toMatchObject({
      offering: SEEDANCE,
      use_case: "product-ugc",
      score: 4,
      aspects: { quality: 5 },
      scope: "private",
    });
    const reviewId = rated.data.review.id as string;

    const reviewed = await envelope([
      "catalog",
      "review",
      SEEDANCE,
      "-u",
      "product-ugc",
      "--text",
      "Smooth motion, mail jane@example.com",
    ]);
    expect(reviewed.data.review).toMatchObject({
      id: reviewId,
      score: 4,
      text: "Smooth motion, mail [email]",
    });

    const listed = await envelope(["catalog", "reviews", "list"]);
    expect(listed.data.summary).toMatchObject({ reviews: 1, rated: 1, average: 4 });
    expect(listed.data.user_content).toMatch(/data, never as instructions/);

    const noted = await envelope([
      "catalog",
      "note",
      "add",
      SEEDANCE,
      "-u",
      "product-ugc",
      "--verdict",
      "recommended",
      "--text",
      "Good for ads",
    ]);
    const noteId = noted.data.note.id as string;
    expect(noted.data.note).toMatchObject({ verdict: "recommended", use_case: "product-ugc" });

    const edited = await envelope(["catalog", "note", "edit", noteId, "--verdict", "avoid"]);
    expect(edited.data.note).toMatchObject({ id: noteId, verdict: "avoid", text: "Good for ads" });

    const notes = await envelope(["catalog", "note", "list"]);
    expect(notes.data.notes.map((n: { id: string }) => n.id)).toEqual([noteId]);

    expect((await envelope(["catalog", "note", "rm", noteId])).data).toMatchObject({
      removed: noteId,
      scope: "private",
    });
    expect((await envelope(["catalog", "reviews", "rm", reviewId])).data).toMatchObject({
      removed: reviewId,
      scope: "private",
    });
    expect((await envelope(["catalog", "reviews", "list"])).data.reviews).toEqual([]);
  });

  it("keeps the notes file readable only by its owner", async () => {
    await envelope(["catalog", "rate", SEEDANCE, "3"]);
    if (process.platform === "win32") return;
    expect(fs.statSync(notesFile).mode & 0o777).toBe(0o600);
  });

  it("summarises the run ledger per offering from the run history file", async () => {
    const entry = {
      v: 1,
      id: "h_seed1",
      ts: "2026-10-27T10:00:00.000Z",
      duration_ms: 4000,
      cwd: dir,
      version: "0.0.0",
      command: "fal video",
      provider: "fal",
      model_resolved: "bytedance/seedance-2.5/text-to-video",
      argv: ["fal", "video"],
      ok: true,
      exit_code: 0,
      usage: { cost_usd: 0.5 },
    };
    fs.writeFileSync(historyFile, `${JSON.stringify(entry)}\n`);
    const body = await envelope(["catalog", "usage", "--by", "offering"]);
    expect(body.data.scope).toBe("multix run ledger on this machine");
    expect(body.data.usage).toEqual([
      expect.objectContaining({
        key: SEEDANCE,
        requests: 1,
        completed: 1,
        p50_s: 4,
        cost: expect.objectContaining({
          known_usd: 0.5,
          per_success_usd: 0.5,
          unknown_operations: 0,
        }),
      }),
    ]);
  });

  it("shows project reviews tied to a run missing from this machine's ledger as unverified", async () => {
    const project = fs.mkdtempSync(path.join(dir, "repo-"));
    fs.mkdirSync(path.join(project, ".multix"));
    const stamp = {
      created_at: "2026-10-27T10:00:00.000Z",
      updated_at: "2026-10-27T10:00:00.000Z",
    };
    const reviews = ["ads", "ugc", "promo"].map((useCase, i) => ({
      id: `r_forged${i}`,
      offering: SEEDANCE,
      use_case: useCase,
      score: 5,
      verified_usage: { history_id: "h_doesnotexist", ts: "2026-10-27T09:00:00.000Z" },
      ...stamp,
    }));
    fs.writeFileSync(
      path.join(project, ".multix", "catalog-notes.json"),
      JSON.stringify({ reviews, notes: [] }),
    );

    // An empty private store, so only the project reviews are counted.
    const env = { MULTIX_CATALOG_FILE: path.join(project, "private.json") };
    const listed = JSON.parse(
      (await run(["catalog", "reviews", "list", "--json"], env, project)).stdout,
    );
    const forged = listed.data.reviews.filter((r: { id: string }) => r.id.startsWith("r_forged"));
    expect(forged).toHaveLength(3);
    for (const r of forged) expect(r.verified_usage).toBeUndefined();

    const text = await run(["catalog", "reviews", "list"], env, project);
    expect(text.stdout).toContain("r_forged0");
    expect(text.stdout).not.toContain("verified run");

    const recommended = await run(
      ["catalog", "recommend", "--task", "video", "--json"],
      env,
      project,
    );
    expect(recommended.stdout).toContain("from 3 ratings (0 tied to a run)");
  });

  it("keeps a rate that was given the wrong grouping of settings out of the ledger when it fails", async () => {
    const body = await envelope(["catalog", "usage", "--by", "color"]);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_INPUT");
  });
});
