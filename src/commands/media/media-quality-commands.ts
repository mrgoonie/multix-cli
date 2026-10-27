/**
 * The read-only quality commands of the `media` group. They run offline on
 * local files and never call a provider: inspect, verify, frames,
 * check-receipt and profiles. With --json each prints one JSON document,
 * which becomes the `data` of the multix.result/v1 envelope.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import { ValidationError } from "../../core/errors.js";
import { MAX_FRAMES, extractFrames } from "./media-frames.js";
import { type InspectReport, inspectMedia } from "./media-inspect.js";
import { checkReceipt } from "./media-receipt.js";
import { type VerifyReceipt, verifyMedia } from "./media-verify.js";
import { BUILTIN_PROFILES, builtinProfile, loadProfileFile } from "./verify-profiles.js";

const DEFAULT_TIMEOUT_S = "1800";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function numberFlag(
  flag: string,
  value: string | undefined,
  opts: { min?: number; positive?: boolean } = {},
) {
  if (value === undefined) return undefined;
  // Number("") is 0: an empty value must not become a 0 target.
  const n = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(n) || (opts.positive && n <= 0) || (opts.min !== undefined && n < opts.min))
    throw new ValidationError(`Invalid ${flag}: ${value}`);
  return n;
}

function timeoutMs(value: string): number {
  return (numberFlag("--timeout", value, { positive: true }) as number) * 1000;
}

function emit(data: unknown, human: () => string): void {
  console.log(run.json ? JSON.stringify(data) : human());
}

/** Shell exit status for a run stopped by each signal: 128 + the signal number. */
const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Ctrl-C, SIGTERM or a closed terminal (SIGHUP) cancels the running ffmpeg/ffprobe and
 * rule processes, and the command's own cleanup (temp and staging directories) runs
 * before it exits with 128 + the signal number, as a shell reports a killed command.
 * The listeners stay registered for the whole run: a once-listener would be gone by the
 * time execa's exit handler looks, and it would then re-raise the signal and skip that
 * cleanup. A second signal skips the cleanup: it re-raises the signal so the process dies
 * as a killed command does, without a result claiming nothing was left behind.
 */
async function cancellable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let caught: NodeJS.Signals | undefined;
  const signals = Object.keys(SIGNAL_EXIT) as NodeJS.Signals[];
  const stop = (signal: NodeJS.Signals) => {
    if (caught) {
      for (const s of signals) process.off(s, stop);
      process.kill(process.pid, signal);
      return;
    }
    caught = signal;
    ac.abort();
  };
  for (const signal of signals) process.on(signal, stop);
  let result: T | undefined;
  try {
    result = await fn(ac.signal);
  } catch (e) {
    if (!caught) throw e;
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
  if (caught) {
    process.stderr.write("Cancelled\n");
    process.exit(SIGNAL_EXIT[caught] ?? 1);
  }
  return result as T;
}

function fmtS(n: number | null | undefined): string {
  return n === null || n === undefined ? "unknown" : `${n}s`;
}

function humanInspect(r: InspectReport): string {
  const lines = [
    `${r.source.path}`,
    `  sha256     ${r.source.sha256}`,
    `  bytes      ${r.source.bytes}`,
    `  container  ${r.sniff.container ?? "unknown"} (extension ${r.sniff.extension || "none"}: ${r.sniff.extension_matches === null ? "unknown" : r.sniff.extension_matches ? "matches" : "MISMATCH"})`,
    `  kind       ${r.kind ?? "unknown"}  format ${r.format?.format_name ?? "unknown"}  duration ${fmtS(r.format?.duration_s)}`,
  ];
  if (r.video) {
    const v = r.video;
    const rate = v.avg_frame_rate ? `${v.avg_frame_rate.num}/${v.avg_frame_rate.den}` : "unknown";
    lines.push(
      `  video      #${v.index} ${v.codec ?? "?"} ${v.width ?? "?"}x${v.height ?? "?"} (display ${v.display_width ?? "?"}x${v.display_height ?? "?"}, rotation ${v.rotation_deg}) fps ${rate}${v.variable_frame_rate ? " VFR" : ""} timebase ${v.time_base ?? "?"}`,
    );
  }
  lines.push(
    r.audio
      ? `  audio      #${r.audio.index} ${r.audio.codec ?? "?"} ${r.audio.sample_rate_hz ?? "?"} Hz, ${r.audio.channels ?? "?"} ch (${r.audio.channel_layout ?? "?"})`
      : "  audio      none",
  );
  if (r.decode)
    lines.push(
      `  decode     ${r.decode.completed ? "completed" : "incomplete"}, ${fmtS(r.decode.decoded_s)} decoded, ${r.decode.error_count} error(s)`,
      ...r.decode.errors.slice(0, 5).map((e) => `    ${e}`),
    );
  for (const e of r.errors) lines.push(`  error      ${e}`);
  return lines.join("\n");
}

function humanVerify(r: VerifyReceipt): string {
  const lines = [
    `${r.status.toUpperCase()}  ${r.source.path}  (profile ${r.profile.id}@${r.profile.version}, sha256 ${r.source.sha256.slice(0, 16)}…)`,
  ];
  for (const c of r.checks) {
    const real = (c.findings ?? []).filter((f) => !f.intentional);
    const measured = Object.entries(c.measured ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const extra = c.reason
      ? ` — ${c.reason}`
      : real.length
        ? ` — ${real.map((f) => `${f.start_s}-${f.end_s}s`).join(", ")}`
        : c.status !== "pass" && measured
          ? ` — ${measured}`
          : "";
    lines.push(`  ${c.status.padEnd(7)} ${c.id}${extra}`);
  }
  for (const n of r.not_measured) lines.push(`  n/a     ${n.id} — ${n.reason}`);
  if (r.cache?.hit) lines.push(`  (cached result ${r.cache.key.slice(0, 12)}…)`);
  return lines.join("\n");
}

export function registerMediaQualityCommands(media: Command): void {
  media
    .command("inspect <file>")
    .description(
      "Read-only facts about a local media file: sha256, magic bytes vs extension, container, streams, rational fps/timebase, rotation, audio; --decode also counts decode errors",
    )
    .option("--decode", "Fully decode the file and report decode errors and decoded duration")
    .option("--timeout <s>", "Stop ffprobe/ffmpeg after this many seconds", DEFAULT_TIMEOUT_S)
    .action(async (file: string, opts: { decode?: boolean; timeout: string }) => {
      const t = timeoutMs(opts.timeout);
      const report = await cancellable((signal) =>
        inspectMedia(file, { decode: opts.decode, timeoutMs: t, signal }),
      );
      emit(report, () => humanInspect(report));
      if (!report.ok) {
        console.error(`media inspect: ${report.errors[0] ?? "decode errors found"}`);
        process.exitCode = 1;
      }
    });

  media
    .command("verify <file>")
    .description(
      "Check a local media file against a versioned profile (decode integrity, black/frozen frames, silence, clipping, expected duration/aspect) and print a receipt bound to its sha256",
    )
    .option("--profile <id>", `Built-in profile: ${Object.keys(BUILTIN_PROFILES).join(", ")}`)
    .option(
      "--profile-file <json>",
      "Custom profile JSON (see docs: id, version, extends, media, checks)",
    )
    .option("--expect-duration <s>", "Expected duration in seconds")
    .option(
      "--duration-tolerance <s>",
      "Allowed duration difference in seconds (default: max(0.1, one frame))",
    )
    .option(
      "--expect-aspect <W:H>",
      "Expected display aspect ratio, e.g. 16:9, 1:1, 9:16 (rotation applied)",
    )
    .option("--aspect-tolerance <ratio>", "Relative aspect tolerance", "0.01")
    .option("--loudness <LUFS>", "Target integrated loudness; checked only when given")
    .option("--loudness-tolerance <LU>", "Allowed loudness difference", "1")
    .option(
      "--allow-black <start-end>",
      "Declare an intentional black range in seconds (repeatable)",
      collect,
    )
    .option(
      "--allow-freeze <start-end>",
      "Declare an intentional static hold (repeatable)",
      collect,
    )
    .option("--allow-silence <start-end>", "Declare an intentional silence (repeatable)", collect)
    .option(
      "--rule <file>",
      "Custom deterministic rule script: JSON on stdin, JSON verdict on stdout (repeatable)",
      collect,
    )
    .option("--rule-timeout <s>", "Time limit per custom rule", "30")
    .option(
      "--cache-dir <dir>",
      "Reuse and store receipts keyed by source sha256 + profile + expectations + rules + ffmpeg version",
    )
    .option("--receipt-out <file>", "Also write the receipt JSON to this file")
    .option(
      "--timeout <s>",
      "Stop ffprobe/ffmpeg after this many seconds (the receipt is then incomplete)",
      DEFAULT_TIMEOUT_S,
    )
    .action(
      async (
        file: string,
        opts: {
          profile?: string;
          profileFile?: string;
          expectDuration?: string;
          durationTolerance?: string;
          expectAspect?: string;
          aspectTolerance: string;
          loudness?: string;
          loudnessTolerance: string;
          allowBlack?: string[];
          allowFreeze?: string[];
          allowSilence?: string[];
          rule?: string[];
          ruleTimeout: string;
          cacheDir?: string;
          receiptOut?: string;
          timeout: string;
        },
      ) => {
        if (!opts.profile === !opts.profileFile)
          throw new ValidationError("Pass exactly one of --profile or --profile-file");
        const profile = opts.profile
          ? builtinProfile(opts.profile)
          : loadProfileFile(opts.profileFile as string);
        const hasLoudness = opts.loudness !== undefined;
        const expect = {
          duration_s: numberFlag("--expect-duration", opts.expectDuration, { positive: true }),
          duration_tolerance_s: numberFlag("--duration-tolerance", opts.durationTolerance, {
            min: 0,
          }),
          aspect_ratio: opts.expectAspect,
          aspect_tolerance: opts.expectAspect
            ? numberFlag("--aspect-tolerance", opts.aspectTolerance, { min: 0 })
            : undefined,
          loudness_lufs: numberFlag("--loudness", opts.loudness),
          loudness_tolerance_lu: hasLoudness
            ? numberFlag("--loudness-tolerance", opts.loudnessTolerance, { min: 0 })
            : undefined,
          allow_black: opts.allowBlack,
          allow_freeze: opts.allowFreeze,
          allow_silence: opts.allowSilence,
        };
        const t = timeoutMs(opts.timeout);
        const ruleTimeout =
          (numberFlag("--rule-timeout", opts.ruleTimeout, { positive: true }) as number) * 1000;
        const receipt = await cancellable((signal) =>
          verifyMedia(file, {
            profile,
            profileOrigin: opts.profile ? "builtin" : "file",
            expect,
            rules: opts.rule,
            ruleTimeoutMs: ruleTimeout,
            timeoutMs: t,
            cacheDir: opts.cacheDir,
            signal,
          }),
        );
        if (opts.receiptOut) {
          fs.mkdirSync(path.dirname(path.resolve(opts.receiptOut)), { recursive: true });
          fs.writeFileSync(opts.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`);
        }
        emit(receipt, () => humanVerify(receipt));
        if (receipt.status !== "pass") {
          console.error(
            `media verify: ${receipt.status} (${receipt.summary.errors} failed, ${receipt.summary.unknown} unknown check(s))`,
          );
          process.exitCode = 1;
        }
      },
    );

  media
    .command("frames <file>")
    .description(
      "Extract evenly spaced frames (and an optional contact sheet) with a manifest pinned to the source sha256; extraction only, nothing is reviewed or uploaded",
    )
    .requiredOption(
      "--output-dir <dir>",
      "Directory for frame-NNN.png, sheet.png and frames.json (existing ones are not overwritten)",
    )
    .option("--count <n>", `Number of frames, 1-${MAX_FRAMES}`, "9")
    .option("--sheet", "Also build sheet.png, a grid of all frames")
    .option("--sheet-width <px>", "Tile width in the contact sheet", "320")
    .option("--timeout <s>", "Time limit per ffmpeg call", "300")
    .action(
      async (
        file: string,
        opts: {
          outputDir: string;
          count: string;
          sheet?: boolean;
          sheetWidth: string;
          timeout: string;
        },
      ) => {
        const manifest = await cancellable((signal) =>
          extractFrames(file, {
            outDir: opts.outputDir,
            count: Number(opts.count),
            sheet: opts.sheet,
            sheetWidth: numberFlag("--sheet-width", opts.sheetWidth, { positive: true }),
            timeoutMs: timeoutMs(opts.timeout),
            signal,
          }),
        );
        emit(manifest, () =>
          [
            `Wrote ${manifest.frames.length} frame(s)${manifest.sheet ? " and sheet.png" : ""} to ${opts.outputDir}`,
            `  source sha256 ${manifest.source.sha256}`,
            ...manifest.frames.map((f) => `  ${f.file}  t=${f.pts_time_s ?? f.requested_s}s`),
            `  manifest ${path.join(opts.outputDir, "frames.json")}`,
          ].join("\n"),
        );
      },
    );

  media
    .command("check-receipt <receipt> <file>")
    .description(
      "Check that a media verify receipt vouches for this exact file (sha256 match and a pass verdict)",
    )
    .action(async (receiptFile: string, file: string) => {
      const result = await checkReceipt(receiptFile, file);
      emit(result, () =>
        result.ok
          ? `OK  receipt (${result.profile.id}@${result.profile.version}) matches ${file}`
          : `NOT OK  ${result.reason}`,
      );
      if (!result.ok) {
        console.error(`media check-receipt: ${result.reason}`);
        process.exitCode = 1;
      }
    });

  media
    .command("profiles")
    .description("List the built-in verify profiles with their versions and thresholds")
    .action(() => {
      const list = Object.values(BUILTIN_PROFILES);
      emit(list, () =>
        list.map((p) => `${p.id}@${p.version} (${p.media})\n  ${p.description}`).join("\n"),
      );
    });
}
