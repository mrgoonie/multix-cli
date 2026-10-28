/**
 * `multix catalog` — providers, model offerings, sourced price book,
 * like-for-like price comparison, usage through multix, and the user's own
 * ratings, reviews and use-case notes, with explainable suggestions.
 *
 * Prices and offerings come from src/catalog (the same builders the MCP
 * Worker serves); usage comes from the local run ledger (`multix history`);
 * feedback is stored locally and private by default. `multix models` stays
 * the place to find which command runs a task; this command adds what an
 * offering costs and how it has done.
 */

import path from "node:path";
import type { Command } from "commander";
import {
  addFeedback,
  deleteFeedback,
  feedbackFile,
  findFeedback,
  newFeedbackId,
  readFeedback,
  updateFeedback,
} from "../../agent/feedback-store.js";
import { findHistory, parseSince, readHistory } from "../../agent/history-store.js";
import { run } from "../../agent/run-state.js";
import { TASKS, type Task, isTask } from "../../capabilities/capability-types.js";
import type { QuoteConfig } from "../../catalog/catalog-types.js";
import {
  type Feedback,
  type FeedbackFields,
  type FeedbackKind,
  cleanFields,
  cleanScope,
  cleanSlug,
  feedbackView,
  summariseRatings,
} from "../../catalog/feedback-rules.js";
import { offeringWithQuotes } from "../../catalog/price-book-view.js";
import {
  allRates,
  betterQuote,
  compareFamily,
  filterOfferings,
  listOfferings,
  listProviders,
  parseRef,
  quoteRate,
  showOffering,
} from "../../catalog/price-book.js";
import { type ConfigFlags, quoteConfig, taskOpt } from "../../catalog/quote-config.js";
import { recommend } from "../../catalog/recommend.js";
import { type UsageGroupBy, resolvedModelOf, usageReport } from "../../catalog/usage-analytics.js";
import { ValidationError } from "../../core/errors.js";
import { groupKeyNames, groupReady } from "./provider-group-keys.js";

const CLI_HOOKS = { keys: groupKeyNames, ready: (g: string) => groupReady(g) };

function out(value: unknown, text: () => void): void {
  if (run.json) console.log(JSON.stringify(value));
  else text();
}

function addConfigOptions(cmd: Command): Command {
  return cmd
    .option("-t, --task <task>", `Task (${TASKS.join(", ")})`)
    .option("--resolution <r>", "Output resolution, e.g. 720p")
    .option("--duration <s>", "Clip length in seconds")
    .option("--aspect-ratio <r>", "Aspect ratio, e.g. 16:9")
    .option("--audio <on|off>", "Generated audio on or off")
    .option("--count <n>", "Images per request");
}

function money(amount: number | null, currency: string | null): string {
  if (amount === null || currency === null) return "unknown";
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
}

function requireRef(ref: string): { provider: string; model: string } {
  const parsed = parseRef(ref);
  if (!parsed)
    throw new ValidationError(`Use <provider>:<model>, e.g. fal:${"fal-ai/minimax/speech-2.8-hd"}`);
  return parsed;
}

/** A local history run of this offering that succeeded, for `--job`. */
function verifiedUsage(ref: { provider: string; model: string }, job: string) {
  const entries = readHistory();
  const entry =
    findHistory(job, entries) ??
    [...entries].reverse().find((e) => e.job?.id === job || e.provider_ids?.includes(job));
  if (!entry) throw new ValidationError(`No run "${job}" in the local history`);
  const model = resolvedModelOf(entry);
  if (
    entry.provider !== ref.provider ||
    (model !== ref.model && entry.model_requested !== ref.model)
  ) {
    throw new ValidationError(
      `Run ${entry.id} used ${entry.provider}:${model ?? "(unknown model)"}, not ${ref.provider}:${ref.model}`,
    );
  }
  if (!entry.ok || entry.dry_run || entry.estimate_only) {
    throw new ValidationError(`Run ${entry.id} did not complete; only completed runs verify usage`);
  }
  return { history_id: entry.id, ...(entry.job ? { job_id: entry.job.id } : {}), at: entry.ts };
}

interface FeedbackFlags {
  task?: string;
  useCase?: string;
  score?: string;
  aspect?: string[];
  text?: string;
  pro?: string[];
  con?: string[];
  verdict?: string;
  strength?: string[];
  weakness?: string[];
  limitation?: string[];
  tag?: string[];
  modelVersion?: string;
  source?: string;
  scope?: string;
  job?: string;
}

function fieldsOf(f: FeedbackFlags): FeedbackFields {
  return {
    ...(f.task !== undefined ? { task: f.task } : {}),
    ...(f.useCase !== undefined ? { use_case: f.useCase } : {}),
    ...(f.score !== undefined ? { score: f.score } : {}),
    ...(f.aspect?.length ? { aspects: f.aspect } : {}),
    ...(f.text !== undefined ? { text: f.text } : {}),
    ...(f.pro?.length ? { pros: f.pro } : {}),
    ...(f.con?.length ? { cons: f.con } : {}),
    ...(f.verdict !== undefined ? { verdict: f.verdict } : {}),
    ...(f.strength?.length ? { strengths: f.strength } : {}),
    ...(f.weakness?.length ? { weaknesses: f.weakness } : {}),
    ...(f.limitation?.length ? { limitations: f.limitation } : {}),
    ...(f.tag?.length ? { tags: f.tag } : {}),
    ...(f.modelVersion !== undefined ? { model_version: f.modelVersion } : {}),
    ...(f.source !== undefined ? { source: f.source } : {}),
  };
}

function saveFeedback(kind: FeedbackKind, refText: string, f: FeedbackFlags): void {
  const ref = requireRef(refText);
  const known = listOfferings().some((o) => o.provider === ref.provider && o.model === ref.model);
  const history = readHistory().some(
    (e) => e.provider === ref.provider && resolvedModelOf(e) === ref.model,
  );
  if (!known && !history) {
    throw new ValidationError(
      `${refText} is not in the catalogue or your history; see \`multix catalog models\``,
    );
  }
  const fields = cleanFields(kind, fieldsOf(f));
  const scope = cleanScope(f.scope);
  const now = new Date().toISOString();
  const entry: Feedback = {
    id: newFeedbackId(),
    kind,
    ref: `${ref.provider}:${ref.model}`,
    provider: ref.provider,
    model: ref.model,
    ...fields,
    scope,
    ...(scope === "project" ? { project: path.basename(process.cwd()) } : {}),
    ...(f.job ? { verified_usage: verifiedUsage(ref, f.job) } : {}),
    created_at: now,
    updated_at: now,
  };
  const saved = addFeedback(entry);
  out(feedbackView(saved), () =>
    console.log(`Saved ${kind} ${saved.id} for ${saved.ref} (${saved.scope}) in ${feedbackFile()}`),
  );
}

const collect = (value: string, prev: string[] = []) => [...prev, value];

function addFeedbackOptions(cmd: Command): Command {
  return cmd
    .option("-t, --task <task>", "Task the feedback is about")
    .option("-u, --use-case <slug>", "Use case, e.g. product-ugc, vietnamese-tts")
    .option("--tag <tag>", "Tag (repeatable)", collect, [])
    .option("--model-version <v>", "Model version or date you used")
    .option("--scope <scope>", "private (default) or project", "private")
    .option(
      "--job <id>",
      "Local history run id or provider job id: marks the feedback as verified usage",
    );
}

export function registerCatalogCommand(program: Command): void {
  const catalog = program
    .command("catalog")
    .description(
      "Providers, model offerings, sourced prices, like-for-like price comparison, usage through multix, and your ratings, reviews and use-case notes",
    );

  catalog
    .command("providers")
    .description(
      "Providers with their tasks, docs, pricing page, key readiness and priced offerings",
    )
    .action(() => {
      const providers = listProviders(CLI_HOOKS);
      out(providers, () => {
        for (const p of providers) {
          console.log(
            `${p.provider.padEnd(11)} ${p.ready ? "ready " : "no key"}  ${String(p.offerings).padStart(3)} offerings (${p.priced_offerings} priced)  ${p.tasks.join(",")}`,
          );
        }
        console.log("\nDetails: multix catalog providers --json");
      });
    });

  catalog
    .command("models")
    .description(
      "Model offerings (verified or priced) with their price status; unknown prices stay unknown",
    )
    .option("-t, --task <task>", "Only offerings for this task")
    .option("-p, --provider <group>", "Only this provider group")
    .option("-f, --family <family>", "Only this model family, e.g. seedance-2.0")
    .option("--priced", "Only offerings with a current price")
    .option("--verified", "Only offerings verified by multix")
    .action(
      (opts: {
        task?: string;
        provider?: string;
        family?: string;
        priced?: boolean;
        verified?: boolean;
      }) => {
        const task = taskOpt(opts.task);
        const list = filterOfferings(listOfferings(), {
          ...(task ? { task } : {}),
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.family ? { family: opts.family } : {}),
          ...(opts.priced ? { priced: true } : {}),
          ...(opts.verified ? { verified: true } : {}),
        });
        out(list, () => {
          if (!list.length) console.log("No offerings match.");
          for (const o of list) {
            console.log(
              `${o.ref}  [${o.tasks.join(",")}]  price ${o.price_status}${o.verified ? "  verified" : ""}${o.command ? `  run: multix ${o.command}` : ""}`,
            );
          }
        });
      },
    );

  addConfigOptions(
    catalog
      .command("show <ref>")
      .description(
        "One offering (<provider>:<model>): capabilities, every rate with source and freshness, ratings and notes",
      ),
  ).action((refText: string, flags: ConfigFlags) => {
    requireRef(refText);
    const detail = offeringWithQuotes(refText, flags);
    const quotes = detail.quotes;
    const feedback = readFeedback().filter((f) => f.ref === detail.offering.ref);
    const usage =
      usageReport(readHistory(), "model").rows.find((r) => r.key === detail.offering.ref) ?? null;
    const result = {
      ...detail,
      usage,
      ratings: summariseRatings(feedback.filter((f) => f.kind !== "note")),
      feedback: feedback.map(feedbackView),
    };
    out(result, () => {
      const o = detail.offering;
      console.log(`${o.ref}${o.name ? `  ${o.name}` : ""}`);
      console.log(
        `  family ${o.family}  tasks ${o.tasks.join(",")}  ${o.verified ? "verified" : "not verified"}`,
      );
      if (o.command) console.log(`  run: multix ${o.command}`);
      if (!detail.rates.length) console.log("  price: unknown (no sourced rate on file)");
      for (const r of detail.rates) {
        const comps = r.components.map(
          (c) => `${c.amount} ${r.currency}/${c.per === 1 ? "" : `${c.per} `}${c.unit}`,
        );
        const cond = Object.entries(r.conditions)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        console.log(
          `  rate ${r.id}: ${comps.join(" + ")}  ${cond}  [${r.freshness}, checked ${r.last_checked}]`,
        );
        console.log(`    source ${r.source}`);
      }
      for (const q of quotes ?? []) {
        console.log(
          `  quote ${q.rate_id}: ${q.status} ${q.status === "quoted" ? money(q.amount, q.currency) : (q.reason ?? "")}`,
        );
      }
      const s = result.ratings;
      console.log(
        `  ratings: ${s.count}${s.mean !== null ? `, mean ${s.mean}` : ""} (${s.confidence})`,
      );
      if (usage) console.log(`  usage: ${usage.operations} op(s), success ${usage.success_rate}`);
    });
  });

  addConfigOptions(
    catalog
      .command("compare <family>")
      .description(
        "Compare one model family across providers at the same configuration; non-equivalent or unknown prices are listed, never ranked",
      ),
  ).action((family: string, flags: ConfigFlags) => {
    const result = compareFamily(family, quoteConfig(flags));
    out(result, () => {
      if (!result.comparable.length && !result.not_comparable.length && !result.unpriced.length) {
        console.log(`No offerings of ${family} in the catalogue.`);
        return;
      }
      for (const q of result.comparable) {
        console.log(
          `#${q.rank} ${q.ref}  ${money(q.amount, q.currency)}  (${q.basis})${q.assumed ? `  assumes ${q.assumed.join(", ")}` : ""}`,
        );
      }
      for (const q of result.not_comparable) {
        console.log(`-  ${q.ref}  ${q.status}: ${q.reason ?? ""}`);
      }
      for (const ref of result.unpriced) console.log(`-  ${ref}  unknown: no sourced rate`);
      console.log(`\n${result.note}`);
    });
  });

  catalog
    .command("usage")
    .description(
      "Usage through multix from the local history: runs, operations, attempts, success, latency, actual vs estimated cost",
    )
    .option("--by <dim>", "provider, model, task or command", "model")
    .option("-p, --provider <group>", "Only this provider group")
    .option("--since <age>", "Only runs newer than 30m, 12h, 7d or an ISO date")
    .action((opts: { by: string; provider?: string; since?: string }) => {
      if (!["provider", "model", "task", "command"].includes(opts.by)) {
        throw new ValidationError("--by must be provider, model, task or command");
      }
      const since = opts.since ? parseSince(opts.since) : undefined;
      const entries = readHistory().filter(
        (e) =>
          (!opts.provider || e.provider === opts.provider) &&
          (since === undefined || Date.parse(e.ts) >= since),
      );
      const report = usageReport(entries, opts.by as UsageGroupBy);
      out(report, () => {
        if (!report.rows.length) {
          console.log("No runs recorded for this filter.");
          return;
        }
        for (const r of report.rows) {
          const cost = r.cost.actual_usd !== null ? `$${r.cost.actual_usd}` : "cost unknown";
          const est = r.cost.estimated_usd !== null ? ` (+ est. $${r.cost.estimated_usd})` : "";
          console.log(
            `${r.key}  ${r.operations} op / ${r.runs} run / ${r.attempts} att  success ${r.success_rate ?? "-"}  p50 ${r.latency_s?.p50 ?? "-"}s  ${cost}${est}  [${r.sample.confidence}]`,
          );
        }
        console.log(`\n${report.note}`);
      });
    });

  addConfigOptions(
    catalog
      .command("recommend")
      .description(
        "Suggest offerings for a task and use case, each with its reasons, caveats and evidence",
      )
      .option("-u, --use-case <slug>", "Use case to weigh your notes and ratings for")
      .option("-n, --limit <n>", "How many", "10"),
  ).action((flags: ConfigFlags & { useCase?: string; limit: string }) => {
    const task = taskOpt(flags.task);
    if (!task) throw new ValidationError("--task is required");
    const config = quoteConfig(flags);
    const offerings = listOfferings();
    const rates = allRates(new Date());
    const quotes = new Map<string, ReturnType<typeof quoteRate>>();
    // Quote only when a configuration beyond the task was given.
    if (Object.keys(config).length > 1) {
      for (const r of rates) {
        const q = quoteRate(r, config);
        const prev = quotes.get(q.ref);
        if (!prev || betterQuote(q, prev)) quotes.set(q.ref, q);
      }
    }
    const usage = new Map(usageReport(readHistory(), "model").rows.map((r) => [r.key, r]));
    const result = recommend({
      task,
      ...(flags.useCase ? { use_case: cleanSlug(flags.useCase, "--use-case") } : {}),
      offerings,
      quotes,
      usage,
      feedback: readFeedback(),
      ready: (g) => groupReady(g),
      limit: Math.max(1, Number.parseInt(flags.limit, 10) || 10),
    });
    out(result, () => {
      if (!result.recommendations.length) console.log(`No offerings for ${task}.`);
      for (const r of result.recommendations) {
        console.log(`#${r.rank} ${r.ref}${r.command ? `  (multix ${r.command})` : ""}`);
        for (const line of r.reasons) console.log(`   + ${line}`);
        for (const line of r.caveats) console.log(`   ! ${line}`);
      }
      console.log(`\nOrder: ${result.ranking_basis.join("; then ")}.`);
    });
  });

  addFeedbackOptions(
    catalog
      .command("rate <ref>")
      .description("Rate an offering 1-5 (rating again for the same use case replaces it)")
      .requiredOption("-s, --score <n>", "1 to 5")
      .option(
        "--aspect <name=score>",
        "Aspect score: quality, fidelity, motion, audio, speed, value, reliability (repeatable)",
        collect,
        [],
      )
      .option("--text <text>", "Optional comment"),
  ).action((ref: string, f: FeedbackFlags) => saveFeedback("rating", ref, f));

  addFeedbackOptions(
    catalog
      .command("review <ref>")
      .description("Write a review of an offering")
      .requiredOption(
        "--text <text>",
        "Review text (no prompts, keys, signed URLs or personal data)",
      )
      .option("-s, --score <n>", "Optional 1 to 5")
      .option("--pro <text>", "Pro (repeatable)", collect, [])
      .option("--con <text>", "Con (repeatable)", collect, []),
  ).action((ref: string, f: FeedbackFlags) => saveFeedback("review", ref, f));

  addFeedbackOptions(
    catalog
      .command("note <ref>")
      .description("Record when to use or avoid an offering for a use case")
      .requiredOption("--verdict <use|avoid>", "use or avoid for --use-case")
      .option("--text <text>", "Why")
      .option("--strength <text>", "Strength (repeatable)", collect, [])
      .option("--weakness <text>", "Weakness (repeatable)", collect, [])
      .option("--limitation <text>", "Limitation (repeatable)", collect, [])
      .option("--source <text>", "Where the claim comes from (a run, a benchmark, a doc)"),
  ).action((ref: string, f: FeedbackFlags) => saveFeedback("note", ref, f));

  catalog
    .command("feedback [ref]")
    .description("List your ratings, reviews and notes (all, or one offering); --json exports them")
    .option("-u, --use-case <slug>", "Only this use case")
    .option("--kind <kind>", "rating, review or note")
    .action((ref: string | undefined, opts: { useCase?: string; kind?: string }) => {
      const list = readFeedback().filter(
        (f) =>
          (!ref || f.ref === ref) &&
          (!opts.useCase || f.use_case === opts.useCase) &&
          (!opts.kind || f.kind === opts.kind),
      );
      out(
        {
          file: feedbackFile(),
          summary: summariseRatings(list.filter((f) => f.kind !== "note")),
          entries: list.map(feedbackView),
        },
        () => {
          if (!list.length) {
            console.log(`No feedback yet (${feedbackFile()}).`);
            return;
          }
          for (const f of list) {
            const head =
              f.kind === "note"
                ? `${f.verdict} for ${f.use_case}`
                : f.score !== undefined
                  ? `${f.score}/5`
                  : "";
            console.log(
              `${f.id}  ${f.kind.padEnd(6)} ${f.ref}  ${head}${f.verified_usage ? "  verified usage" : ""}  ${f.text ? `"${f.text.slice(0, 80)}"` : ""}`,
            );
          }
        },
      );
    });

  catalog
    .command("edit <id>")
    .description("Change fields of one of your ratings, reviews or notes")
    .option("-s, --score <n>", "1 to 5")
    .option("--text <text>", "Text")
    .option("-u, --use-case <slug>", "Use case")
    .option("--verdict <use|avoid>", "Note verdict")
    .option("--tag <tag>", "Replace tags (repeatable)", collect, [])
    .action((id: string, f: FeedbackFlags) => {
      const entry = findFeedback(id);
      if (!entry) throw new ValidationError(`No feedback ${id}`);
      const fields = cleanFields(entry.kind, {
        ...fieldsOf({
          ...(entry.task ? { task: entry.task } : {}),
          ...(entry.use_case ? { useCase: entry.use_case } : {}),
          ...(entry.score !== undefined ? { score: String(entry.score) } : {}),
          ...(entry.text !== undefined ? { text: entry.text } : {}),
          ...(entry.verdict ? { verdict: entry.verdict } : {}),
          ...(entry.tags ? { tag: entry.tags } : {}),
        }),
        ...fieldsOf(f),
      });
      const updated: Feedback = { ...entry, ...fields, updated_at: new Date().toISOString() };
      updateFeedback(updated);
      out(feedbackView(updated), () => console.log(`Updated ${id}`));
    });

  catalog
    .command("delete <id>")
    .description("Delete one of your ratings, reviews or notes")
    .action((id: string) => {
      if (!deleteFeedback(id)) throw new ValidationError(`No feedback ${id}`);
      out({ deleted: id }, () => console.log(`Deleted ${id}`));
    });
}
