/**
 * Durable receipts for submitted fal queue requests. Written atomically (temp
 * file + rename, mode 0600) right after fal accepts a submit, so a request can
 * be resumed with `fal status` / `fal result` after the terminal or agent
 * session that submitted it is gone. A receipt holds ids and a hash of the
 * input, never the input itself, URLs or keys.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../core/logger.js";

export interface FalReceipt {
  provider: "fal";
  model: string;
  request_id: string;
  status: string;
  submitted_at: string;
  /** sha256 of the submitted input (keys sorted), to tell repeated submits apart. */
  input_hash: string;
  /** Commands that resume this request without submitting it again. */
  status_command: string;
  result_command: string;
  /** Where the receipt was saved; absent when saving failed. */
  receipt_path?: string;
}

/** Quote one argument for a POSIX shell when it needs it. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Default receipt directory: ~/.multix/fal/requests. */
export function defaultReceiptDir(): string {
  return path.join(os.homedir(), ".multix", "fal", "requests");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function hashInput(input: Record<string, unknown>): string {
  const digest = crypto.createHash("sha256").update(JSON.stringify(canonical(input)));
  return `sha256:${digest.digest("hex")}`;
}

/**
 * `multix fal result <model> <id> --download` plus extra arguments (quoted when
 * needed): fetches a submitted request's output without submitting it again.
 */
export function resultCommand(model: string, requestId: string, extraArgs: string[] = []): string {
  return [
    `multix fal result ${shellQuote(model)} ${shellQuote(requestId)} --download`,
    ...extraArgs.map(shellQuote),
  ].join(" ");
}

/**
 * The resume command of a waiting run: `base`, saving into `outputDir` when one
 * was given. Without download (`--no-download`), the result JSON only, as the run would print.
 */
export function resumeCommand(
  base: string,
  opts: { outputDir?: string; download?: boolean } = {},
): string {
  if (opts.download === false) return base.replace(/ --download(?= |$).*$/, "");
  return opts.outputDir ? `${base} --output-dir ${shellQuote(opts.outputDir)}` : base;
}

export function buildReceipt(opts: {
  model: string;
  requestId: string;
  status?: string;
  input: Record<string, unknown>;
  /** Extra `fal result` arguments needed to save the output correctly, e.g. ["--format", "pcm_16000"]. */
  resultArgs?: string[];
  now?: Date;
}): FalReceipt {
  const target = `${shellQuote(opts.model)} ${shellQuote(opts.requestId)}`;
  return {
    provider: "fal",
    model: opts.model,
    request_id: opts.requestId,
    status: opts.status || "IN_QUEUE",
    submitted_at: (opts.now ?? new Date()).toISOString(),
    input_hash: hashInput(opts.input),
    status_command: `multix fal status ${target}`,
    result_command: resultCommand(opts.model, opts.requestId, opts.resultArgs),
  };
}

/** File name for a request id, restricted to safe characters. */
function receiptFileName(requestId: string): string {
  return `${requestId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
}

/** Persist a rename by syncing its directory; best effort (not supported on Windows). */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // The receipt is written; only the crash guarantee is weaker here.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Write `receipt` to `target` (a file path) or into `dir`, atomically and with
 * mode 0600. Returns the final path. Never overwrites an existing file with a
 * partial one: the temp file is removed when the rename fails.
 */
export function saveReceipt(
  receipt: FalReceipt,
  opts: { file?: string; dir?: string } = {},
): string {
  const file = path.resolve(
    opts.file ?? path.join(opts.dir ?? defaultReceiptDir(), receiptFileName(receipt.request_id)),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  const body = `${JSON.stringify({ ...receipt, receipt_path: file }, null, 2)}\n`;
  try {
    // fsync before the rename, so a crash cannot leave a renamed but empty receipt.
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  syncDir(path.dirname(file));
  return file;
}

/** Save the receipt; a failure only warns, since the job is already queued and paid for. */
export function persistReceipt(
  receipt: FalReceipt,
  file: string | undefined,
  logger: Logger,
): FalReceipt {
  try {
    const saved = saveReceipt(receipt, { file });
    logger.debug(`Receipt saved to ${saved}`);
    return { ...receipt, receipt_path: saved };
  } catch (e) {
    logger.warn(
      `Could not save the request receipt (${e instanceof Error ? e.message : e}); keep the request_id to resume.`,
    );
    return receipt;
  }
}
