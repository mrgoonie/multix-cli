/**
 * `multix catalog`: the model & provider catalogue. Official facts (verified
 * capabilities, configuration-aware prices with source and check date), what
 * multix observed (usage from the local run ledger) and what you wrote
 * (ratings, reviews, use-case notes in a local store) are shown apart.
 * A price that is unknown, unverified or stale stays unknown, never $0.
 */

import type { Command } from "commander";
import { findHistory, parseSince, readHistory } from "../../agent/history-store.js";
import { run } from "../../agent/run-state.js";
import { TASKS, type Task, isTask } from "../../capabilities/capability-types.js";
import {
  PROVIDER_INFO,
  buildOfferings,
  filterOfferings,
  findOfferings,
} from "../../catalog/catalog-build.js";
import {
  type CatalogQuery,
  type CatalogView,
  catalogQuery,
  quoteRequestOf,
} from "../../catalog/catalog-query.js";
import {
  CATALOG_SCHEMA,
  type Offering,
  type ProviderView,
  type Review,
  type ReviewScope,
} from "../../catalog/catalog-types.js";
import type { Comparison } from "../../catalog/price-compare.js";
import { recommend } from "../../catalog/recommend.js";
import {
  LIMITS,
  USER_CONTENT_NOTICE,
  cleanNote,
  cleanReview,
  parseAspects,
  parseOffering,
  parseScope,
  parseScore,
  slug,
  summarizeReviews,
} from "../../catalog/reviews.js";
import {
  USAGE_GROUPS,
  type UsageGroup,
  aggregateUsage,
  resolvedModel,
} from "../../catalog/usage-aggregate.js";
import { ValidationError } from "../../core/errors.js";
import {
  addNote,
  locate,
  readAll,
  removeRecord,
  replaceNote,
  storeFile,
  upsertReview,
} from "./catalog-store.js";
import { GROUP_KEY_ROWS, groupReady } from "./provider-group-keys.js";

function collect(value: string, prev: string[] = []): string[] {
  return [...prev, value];
}

const print = (payload: Record<string, unknown>) =>
  console.log(JSON.stringify({ schema: CATALOG_SCHEMA, ...payload }));

const usd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "unknown"
    : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(n < 1 ? 4 : 2)}`;

function parseTask(value: string | undefined): Task | undefined {
  if (value === undefined) return undefined;
  if (!isTask(value))
    throw new ValidationError(`Invalid --task: ${value}. Valid: ${TASKS.join(", ")}`);
  return value;
}

function parseAudio(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "on" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "no") return false;
  throw new ValidationError(`Invalid --audio: ${value}. Use on or off.`);
}

function parsePositive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new ValidationError(`${name} must be a positive number.`);
  return n;
}

function knownProviders(offerings: Offering[]): Set<string> {
  return new Set([...Object.keys(PROVIDER_INFO), ...offerings.map((o) => o.provider)]);
}

/** One offering by "<provider>:<model>" or an unambiguous model id. */
function oneOffering(offerings: Offering[], ref: string): Offering {
  const found = findOfferings(offerings, ref);
  if (found.length === 1) return found[0] as Offering;
  if (found.length > 1) {
    throw new ValidationError(
      `${ref} is offered by ${found.map((o) => o.provider).join(", ")}; use one of ${found.map((o) => o.id).join(", ")}.`,
    );
  }
  throw new ValidationError(`No offering ${ref}. List them: multix catalog models`);
}

/** Offering id a review or note is about: a catalogue id, or any well-formed id of a known provider. */
function offeringRef(offerings: Offering[], ref: string): string {
  const found = findOfferings(offerings, ref);
  if (found.length === 1) return (found[0] as Offering).id;
  if (found.length > 1) return oneOffering(offerings, ref).id;
  return parseOffering(ref, knownProviders(offerings));
}

/** A successful, non-dry run of this offering in the run ledger. */
function verifiedUsage(ref: string, offering: string): Review["verified_usage"] {
  const e = findHistory(ref);
  if (!e) throw new ValidationError(`No run ${ref} in the run ledger (multix history list).`);
  if (!e.ok || e.dry_run || e.estimate_only) {
    throw new ValidationError(
      `Run ${e.id} did not complete a real request; it cannot back a review.`,
    );
  }
  const model = resolvedModel(e);
  if (`${e.provider}:${model}` !== offering) {
    throw new ValidationError(
      `Run ${e.id} used ${e.provider}:${model ?? "an unknown model"}, not ${offering}.`,
    );
  }
  return { history_id: e.id, ts: e.ts };
}

/** The shared catalogue query for these flags (same views as the MCP tool and REST API). */
function queryOf(view: CatalogView, opts: QuoteFlags): CatalogQuery {
  const audio = parseAudio(opts.audio);
  const duration = parsePositive("--duration", opts.duration);
  const images = parsePositive("--images", opts.images);
  return {
    view,
    ...(opts.task !== undefined ? { task: opts.task } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.family ? { family: opts.family } : {}),
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.priced ? { priced: true } : {}),
    ...(opts.ready ? { ready: true } : {}),
    ...(opts.resolution ? { resolution: opts.resolution } : {}),
    ...(audio !== undefined ? { audio } : {}),
    ...(duration !== undefined ? { duration_s: duration } : {}),
    ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(opts.sort ? { sort: opts.sort } : {}),
  };
}

const PROVIDER_GROUPS = Object.keys(GROUP_KEY_ROWS);

interface FilterFlags {
  task?: string;
  provider?: string;
  family?: string;
  query?: string;
  priced?: boolean;
  ready?: boolean;
  resolution?: string;
  audio?: string;
  sort?: string;
}

interface QuoteFlags extends FilterFlags {
  duration?: string;
  aspectRatio?: string;
  images?: string;
}

/** Offerings for a task, provider and family (recommend scores the rest itself). */
function selected(opts: FilterFlags): Offering[] {
  const task = parseTask(opts.task);
  return filterOfferings(buildOfferings(), {
    ...(task ? { task } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.family ? { family: opts.family } : {}),
  });
}

function addFilters(cmd: Command): Command {
  return cmd
    .option("-t, --task <task>", `Only this task: ${TASKS.join(", ")}`)
    .option("-p, --provider <group>", "Only this provider (fal, atlas, openai, ...)")
    .option("--family <name>", "Only this model family (seedance-2.5, kling-v3-pro, ...)")
    .option("--ready", "Only providers whose API key is set");
}

function addConfig(cmd: Command): Command {
  return cmd
    .option("--resolution <res>", "Output resolution: 480p, 720p, 1080p, 4k")
    .option("--audio <on|off>", "Generated audio on or off");
}

function rateLine(r: Offering["rates"][number]): string {
  const config = [
    r.config.resolution,
    r.config.audio === undefined ? "" : `audio ${r.config.audio ? "on" : "off"}`,
    r.config.variant ?? "",
    r.config_independent?.length ? `any ${r.config_independent.join("/")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const price =
    r.status === "current"
      ? `${r.units.join(" + ")}${r.basis === "estimated" ? " (estimate)" : ""}`
      : `price ${r.status}${r.detail ? `: ${r.detail}` : ""}`;
  return `${config ? `[${config}] ` : ""}${price}  checked ${r.last_checked}  ${r.source}`;
}

function printOfferings(rows: Offering[]): void {
  if (rows.length === 0) {
    console.log("No matching offerings. Try fewer filters.");
    return;
  }
  for (const o of rows) {
    const ready = groupReady(o.provider) ? "ready" : "no key";
    const run = o.command ? `multix ${o.command}` : "no multix command";
    console.log(`${o.id}  ${o.tasks.join(", ")}  [${ready}]  ${run}`);
    if (o.rates.length === 0) console.log("    price: unknown (no price on file)");
    for (const r of o.rates) console.log(`    ${rateLine(r)}`);
  }
}

function registerBrowse(catalog: Command): void {
  catalog
    .command("providers")
    .description("Providers multix runs: links, key readiness, offerings with a current price")
    .option("--ready", "Only providers whose API key is set")
    .action((opts: { ready?: boolean }) => {
      const payload = catalogQuery(queryOf("providers", opts), groupReady, PROVIDER_GROUPS);
      if (run.json) return console.log(JSON.stringify(payload));
      const rows = payload.providers as ProviderView[];
      for (const p of rows) {
        console.log(
          `${p.id.padEnd(12)} ${p.name}  [${p.ready ? "ready" : "no key"}]  ${p.offerings} offerings, ${p.priced_offerings} priced`,
        );
        if (p.pricing_url) console.log(`${"".padEnd(13)}pricing: ${p.pricing_url}`);
      }
    });

  addConfig(
    addFilters(
      catalog
        .command("models")
        .description(
          "Offerings (provider + model): tasks, the command that runs them, prices per configuration with source and check date",
        ),
    ),
  )
    .option("-q, --query <text>", "Text in the offering id, name or family")
    .option("--priced", "Only offerings with a current price")
    .option("--sort <field>", "id, provider, price (per billing unit) or checked", "id")
    .action((opts: FilterFlags) => {
      const payload = catalogQuery(queryOf("models", opts), groupReady, PROVIDER_GROUPS);
      if (run.json) return console.log(JSON.stringify(payload));
      printOfferings(payload.offerings as Offering[]);
    });

  catalog
    .command("show <offering>")
    .description("One offering: prices, your usage through multix, ratings and use-case notes")
    .action((ref: string) => {
      const o = oneOffering(buildOfferings(), ref);
      const usage = aggregateUsage(readHistory(), "offering").find((u) => u.key === o.id) ?? null;
      const store = readAll();
      const reviews = store.reviews.filter((r) => r.offering === o.id);
      const notes = store.notes.filter((n) => n.offering === o.id);
      const ratings = summarizeReviews(reviews);
      if (run.json) {
        return print({
          offering: { ...o, ready: groupReady(o.provider) },
          provider: PROVIDER_INFO[o.provider] ?? null,
          usage,
          ratings,
          reviews,
          notes,
          user_content: USER_CONTENT_NOTICE,
        });
      }
      printOfferings([o]);
      const info = PROVIDER_INFO[o.provider];
      if (info?.docs_url) console.log(`  docs: ${info.docs_url}`);
      console.log(
        usage
          ? `  usage through multix: ${usage.requests} runs, ${usage.operations} operations, success ${usage.success_rate}, known spend ${usd(usage.cost.known_usd)}${usage.cost.unknown_operations ? ` (+${usage.cost.unknown_operations} unknown)` : ""}`
          : "  usage through multix: none recorded",
      );
      console.log(
        `  ratings: ${ratings.average === null ? "none" : `${ratings.average}/5 from ${ratings.rated}`} (${ratings.reviews} reviews, ${ratings.verified} tied to a run)`,
      );
      for (const n of notes)
        console.log(
          `  note ${n.id}: ${n.verdict} for ${n.use_case}${n.text ? ` — ${n.text}` : ""}`,
        );
    });

  addConfig(
    addFilters(
      catalog
        .command("compare")
        .description(
          "Quote every offering for one exact request; only prices the source confirms for that configuration are ranked",
        ),
    ),
  )
    .option("-d, --duration <seconds>", "Video length in seconds")
    .option("--aspect-ratio <ratio>", "Aspect ratio (16:9) for token-billed video")
    .option("--images <n>", "Images to return (image prices)")
    .action((opts: QuoteFlags) => {
      const payload = catalogQuery(queryOf("compare", opts), groupReady, PROVIDER_GROUPS);
      if (run.json) return console.log(JSON.stringify(payload));
      const result = payload.comparison as Comparison;
      if (result.rows.length === 0) {
        console.log("No offerings match. Try another --task or fewer filters.");
        return;
      }
      for (const r of result.rows) {
        const rank = r.price_rank ? `#${r.price_rank}` : "  -";
        const detail =
          r.status === "priced"
            ? [
                r.basis === "estimated" ? "estimate" : "",
                ...(r.open_settings?.length
                  ? [`not ranked: pin ${r.open_settings.join(", ")}`]
                  : []),
                ...(r.assumptions ?? []).map((a) => `assumes ${a}`),
              ]
            : (r.reasons ?? []);
        console.log(
          `${rank.padStart(3)} ${usd(r.total_usd).padStart(9)}  ${r.offering}${r.rate_id ? ` (${r.rate_id})` : ""}  ${r.status}${detail.filter(Boolean).length ? `: ${detail.filter(Boolean).join("; ")}` : ""}`,
        );
      }
      console.log(`\n${result.note}`);
    });

  catalog
    .command("usage")
    .description(
      "What went through multix (local run ledger only, not the provider account): requests, operations, retries, success, latency, spend",
    )
    .option("--by <field>", `Group by ${USAGE_GROUPS.join(", ")}`, "offering")
    .option("-p, --provider <group>", "Only this provider")
    .option("--since <age>", "Only runs newer than 30m, 12h, 7d or an ISO date")
    .action((opts: { by: string; provider?: string; since?: string }) => {
      if (!(USAGE_GROUPS as readonly string[]).includes(opts.by)) {
        throw new ValidationError(`Invalid --by: ${opts.by}. Valid: ${USAGE_GROUPS.join(", ")}`);
      }
      const since = opts.since ? parseSince(opts.since) : undefined;
      const entries = readHistory().filter(
        (e) =>
          (!opts.provider || e.provider === opts.provider) &&
          (since === undefined || Date.parse(e.ts) >= since),
      );
      const rows = aggregateUsage(entries, opts.by as UsageGroup);
      if (run.json)
        return print({ by: opts.by, scope: "multix run ledger on this machine", usage: rows });
      if (rows.length === 0) {
        console.log(
          "No runs recorded. The ledger is ~/.multix/history.jsonl (MULTIX_HISTORY=0 disables it).",
        );
        return;
      }
      for (const r of rows) {
        const cost = [
          `known ${usd(r.cost.known_usd)}`,
          r.cost.unknown_operations ? `${r.cost.unknown_operations} ops cost unknown` : "",
          r.cost.uncertain_operations ? `${r.cost.uncertain_operations} ops uncertain` : "",
          r.cost.per_success_usd !== null ? `${usd(r.cost.per_success_usd)}/success` : "",
        ]
          .filter(Boolean)
          .join(", ");
        console.log(
          `${r.key}  ${r.requests} req, ${r.operations} ops, ${r.completed} ok, ${r.failed} failed, ${r.canceled} canceled, ${r.retries} retries, p50 ${r.p50_s ?? "-"}s p95 ${r.p95_s ?? "-"}s  ${cost}  (n=${r.sample.n}, ${r.sample.confidence} confidence)`,
        );
      }
    });

  addConfig(
    addFilters(
      catalog
        .command("recommend")
        .description(
          "Rank offerings for a task (and use case) from your runs, ratings, notes and the quoted price, with the evidence behind each score",
        ),
    ),
  )
    .option("-u, --use-case <name>", "Use case, e.g. product-ugc")
    .option("-d, --duration <seconds>", "Video length in seconds (for the price factor)")
    .option("--aspect-ratio <ratio>", "Aspect ratio (16:9)")
    .option("--images <n>", "Images to return")
    .action((opts: QuoteFlags & { useCase?: string }) => {
      const req = quoteRequestOf(queryOf("compare", opts));
      if (!req.task) throw new ValidationError("recommend needs --task.");
      const useCase = slug("use case", opts.useCase, LIMITS.useCase);
      const store = readAll();
      const result = recommend({
        offerings: selected(opts),
        request: req,
        ...(useCase ? { use_case: useCase } : {}),
        usage: aggregateUsage(readHistory(), "offering"),
        reviews: store.reviews,
        notes: store.notes,
        ready: groupReady,
        ready_only: Boolean(opts.ready),
      });
      if (run.json) return print({ ...result, user_content: USER_CONTENT_NOTICE });
      for (const r of result.recommendations.slice(0, 15)) {
        console.log(
          `${r.score.toFixed(3)}  ${r.offering}  [${r.ready ? "ready" : "no key"}]  coverage ${Math.round(r.coverage * 100)}%  quote ${usd(r.quote_usd)}`,
        );
        for (const [name, f] of Object.entries(r.factors))
          console.log(`        ${name}: ${f.evidence}`);
        if (r.reasons.length) console.log(`        missing: ${r.reasons.join("; ")}`);
      }
      for (const x of result.excluded) console.log(`excluded ${x.offering}: ${x.reason}`);
      console.log(`\n${result.note}`);
    });
}

interface ReviewFlags {
  useCase?: string;
  aspect?: string[];
  text?: string;
  pro?: string[];
  con?: string[];
  tag?: string[];
  modelVersion?: string;
  job?: string;
  scope?: string;
}

function saveReview(ref: string, score: string | undefined, opts: ReviewFlags): void {
  const offerings = buildOfferings();
  const offering = offeringRef(offerings, ref);
  const scope = parseScope(opts.scope);
  const review = upsertReview(
    cleanReview({
      offering,
      scope,
      ...(opts.useCase ? { use_case: opts.useCase } : {}),
      ...(score !== undefined ? { score: parseScore("score", score) as number } : {}),
      ...(opts.aspect?.length ? { aspects: parseAspects(opts.aspect) } : {}),
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.pro?.length ? { pros: opts.pro } : {}),
      ...(opts.con?.length ? { cons: opts.con } : {}),
      ...(opts.tag?.length ? { tags: opts.tag } : {}),
      ...(opts.modelVersion ? { version: opts.modelVersion } : {}),
      ...(opts.job ? { verified_usage: verifiedUsage(opts.job, offering) } : {}),
    }),
  );
  if (run.json) {
    print({ review, file: storeFile(scope), user_content: USER_CONTENT_NOTICE });
    return;
  }
  console.log(
    `Saved ${scope} review ${review.id} for ${offering}${review.use_case ? ` (${review.use_case})` : ""}${review.verified_usage ? `, tied to run ${review.verified_usage.history_id}` : ""}.`,
  );
}

function addReviewOptions(cmd: Command): Command {
  return cmd
    .option(
      "-u, --use-case <name>",
      "Use case, e.g. product-ugc (one review per offering and use case)",
    )
    .option(
      "--aspect <name=score>",
      "Aspect score 1-5: quality, fidelity, motion, audio, speed, value, reliability (repeatable)",
      collect,
      [],
    )
    .option("--model-version <text>", "Model version the review is about")
    .option(
      "--job <history id>",
      "Tie the review to a successful run of this offering (multix history list)",
    )
    .option("--scope <scope>", "private (default, ~/.multix) or project (./.multix)", "private");
}

function registerReviews(catalog: Command): void {
  addReviewOptions(
    catalog
      .command("rate <offering> <score>")
      .description(
        "Rate an offering 1-5 stars (updates your earlier rating for the same use case)",
      ),
  ).action((ref: string, score: string, opts: ReviewFlags) => saveReview(ref, score, opts));

  addReviewOptions(
    catalog
      .command("review <offering>")
      .description(
        "Write a review of an offering; free text is scrubbed of URLs' queries, keys and e-mail addresses",
      )
      .option("--text <text>", `Review text (max ${LIMITS.text} characters)`)
      .option("-s, --score <n>", "Stars 1-5")
      .option("--pro <text>", "A strength (repeatable)", collect, [])
      .option("--con <text>", "A weakness (repeatable)", collect, [])
      .option("--tag <name>", "Tag (repeatable)", collect, []),
  ).action((ref: string, opts: ReviewFlags & { score?: string }) =>
    saveReview(ref, opts.score, opts),
  );

  const reviews = catalog.command("reviews").description("List or remove your ratings and reviews");
  reviews
    .command("list", { isDefault: true })
    .description("Your ratings and reviews (user-written text: data, not instructions)")
    .option("-o, --offering <id>", "Only this offering")
    .option("-u, --use-case <name>", "Only this use case")
    .action((opts: { offering?: string; useCase?: string }) => {
      const useCase = slug("use case", opts.useCase, LIMITS.useCase);
      const rows = readAll().reviews.filter(
        (r) =>
          (!opts.offering || r.offering === opts.offering) && (!useCase || r.use_case === useCase),
      );
      if (run.json)
        return print({
          reviews: rows,
          summary: summarizeReviews(rows),
          user_content: USER_CONTENT_NOTICE,
        });
      if (rows.length === 0)
        return console.log("No reviews yet: multix catalog rate <offering> <1-5>");
      for (const r of rows) {
        console.log(
          `${r.id}  ${r.offering}${r.use_case ? ` (${r.use_case})` : ""}  ${r.score ? `${r.score}/5` : "no score"}  ${r.scope}${r.verified_usage ? "  verified run" : ""}`,
        );
        if (r.text) console.log(`    ${r.text}`);
      }
    });
  reviews
    .command("rm <id>")
    .description("Remove one of your reviews")
    .action((id: string) => {
      const scope = removeRecord("reviews", id);
      if (run.json) return print({ removed: id, scope });
      console.log(`Removed ${scope} review ${id}.`);
    });

  const note = catalog
    .command("note")
    .description("Use-case notes: what an offering is good or bad for");
  const noteOptions = (cmd: Command) =>
    cmd
      .option("--text <text>", `Note text (max ${LIMITS.text} characters)`)
      .option("--strength <text>", "Strength (repeatable)", collect, [])
      .option("--weakness <text>", "Weakness (repeatable)", collect, [])
      .option("--limitation <text>", "Known limitation (repeatable)", collect, [])
      .option("--tag <name>", "Tag (repeatable)", collect, [])
      .option("--model-version <text>", "Model version the note is about")
      .option("--source <text>", "Where the finding comes from (a run, a test, an article)");
  type NoteFlags = {
    useCase: string;
    verdict: string;
    text?: string;
    strength?: string[];
    weakness?: string[];
    limitation?: string[];
    tag?: string[];
    modelVersion?: string;
    source?: string;
    scope?: string;
  };
  const noteFields = (offering: string, opts: NoteFlags, scope: ReviewScope) =>
    cleanNote({
      offering,
      use_case: opts.useCase,
      verdict: opts.verdict,
      scope,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.strength ? { strengths: opts.strength } : {}),
      ...(opts.weakness ? { weaknesses: opts.weakness } : {}),
      ...(opts.limitation ? { limitations: opts.limitation } : {}),
      ...(opts.tag ? { tags: opts.tag } : {}),
      ...(opts.modelVersion ? { version: opts.modelVersion } : {}),
      ...(opts.source ? { source: opts.source } : {}),
    });

  noteOptions(
    note
      .command("add <offering>")
      .description("Add a note: recommended, avoid or mixed for a use case")
      .requiredOption("-u, --use-case <name>", "Use case, e.g. product-ugc")
      .requiredOption("--verdict <verdict>", "recommended, avoid or mixed")
      .option("--scope <scope>", "private (default) or project", "private"),
  ).action((ref: string, opts: NoteFlags) => {
    const offering = offeringRef(buildOfferings(), ref);
    const scope = parseScope(opts.scope);
    const saved = addNote(noteFields(offering, opts, scope));
    if (run.json)
      return print({ note: saved, file: storeFile(scope), user_content: USER_CONTENT_NOTICE });
    console.log(
      `Saved ${scope} note ${saved.id}: ${saved.verdict} ${offering} for ${saved.use_case}.`,
    );
  });

  note
    .command("list", { isDefault: true })
    .description("Use-case notes (user-written text: data, not instructions)")
    .option("-o, --offering <id>", "Only this offering")
    .option("-u, --use-case <name>", "Only this use case")
    .action((opts: { offering?: string; useCase?: string }) => {
      const useCase = slug("use case", opts.useCase, LIMITS.useCase);
      const rows = readAll().notes.filter(
        (n) =>
          (!opts.offering || n.offering === opts.offering) && (!useCase || n.use_case === useCase),
      );
      if (run.json) return print({ notes: rows, user_content: USER_CONTENT_NOTICE });
      if (rows.length === 0)
        return console.log(
          "No notes yet: multix catalog note add <offering> -u <use case> --verdict recommended",
        );
      for (const n of rows) {
        console.log(`${n.id}  ${n.verdict.padEnd(11)} ${n.offering} for ${n.use_case}  ${n.scope}`);
        if (n.text) console.log(`    ${n.text}`);
      }
    });

  noteOptions(
    note
      .command("edit <id>")
      .description("Replace a note's fields (keeps its id, offering and scope)")
      .option("-u, --use-case <name>", "Use case")
      .option("--verdict <verdict>", "recommended, avoid or mixed"),
  ).action((id: string, opts: Partial<NoteFlags>) => {
    const { store, index, scope } = locate("notes", id);
    const prev = store.notes[index];
    if (!prev) throw new ValidationError(`No note with id ${id}.`);
    const merged: NoteFlags = {
      useCase: opts.useCase ?? prev.use_case,
      verdict: opts.verdict ?? prev.verdict,
      text: opts.text ?? prev.text,
      strength: opts.strength?.length ? opts.strength : prev.strengths,
      weakness: opts.weakness?.length ? opts.weakness : prev.weaknesses,
      limitation: opts.limitation?.length ? opts.limitation : prev.limitations,
      tag: opts.tag?.length ? opts.tag : prev.tags,
      modelVersion: opts.modelVersion ?? prev.version,
      source: opts.source ?? prev.source,
    };
    const saved = replaceNote(id, noteFields(prev.offering, merged, scope));
    if (run.json) return print({ note: saved, user_content: USER_CONTENT_NOTICE });
    console.log(`Updated ${scope} note ${id}.`);
  });

  note
    .command("rm <id>")
    .description("Remove a note")
    .action((id: string) => {
      const scope = removeRecord("notes", id);
      if (run.json) return print({ removed: id, scope });
      console.log(`Removed ${scope} note ${id}.`);
    });
}

export function registerCatalogCommands(program: Command): void {
  const catalog = program
    .command("catalog")
    .description(
      "Model & provider catalogue: prices per configuration with sources, comparisons, your usage, ratings, reviews and use-case notes",
    );
  registerBrowse(catalog);
  registerReviews(catalog);
}
