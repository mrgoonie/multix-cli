/**
 * Durable receipts for submitted fal queue jobs, so a request can be checked
 * or collected with `fal status` / `fal result` after the CLI, terminal or
 * agent session that submitted it is gone, without submitting (and paying)
 * again. One JSON file per request in ~/.multix/fal-jobs/ (override with
 * MULTIX_FAL_JOBS_DIR), written atomically with mode 0600. A receipt holds no
 * key and no input: only a hash of the input, and the queue URLs, which are
 * useless without FAL_KEY.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FalSubmitResponse } from "./types.js";

export const FAL_RECEIPT_SCHEMA = "multix.fal.job/v1";

export interface FalJobReceipt {
  schema: typeof FAL_RECEIPT_SCHEMA;
  provider: "fal";
  model: string;
  request_id: string;
  /** Last queue status this CLI saw: IN_QUEUE, IN_PROGRESS or COMPLETED. */
  status: string;
  submitted_at: string;
  updated_at: string;
  /** sha256 of the input JSON with sorted keys (the input itself is not stored). */
  input_hash: string;
  status_url: string;
  response_url: string;
  cancel_url?: string;
  /** Input fields that were filled from uploaded local files (names only). */
  uploaded_fields?: string[];
}

export function falJobsDir(): string {
  return process.env.MULTIX_FAL_JOBS_DIR
    ? path.resolve(process.env.MULTIX_FAL_JOBS_DIR)
    : path.join(os.homedir(), ".multix", "fal-jobs");
}

/** JSON with object keys sorted at every level, so equal inputs hash equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function inputHash(input: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(input)).digest("hex")}`;
}

/** File name for a request id; ids that are not plain tokens are hashed. */
function receiptFile(requestId: string, dir = falJobsDir()): string {
  const safe = /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
    ? requestId
    : createHash("sha256").update(requestId).digest("hex");
  return path.join(dir, `${safe}.json`);
}

/** Write `data` to `file` atomically (temp file + rename) with mode 0600. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function buildReceipt(
  model: string,
  input: unknown,
  submit: FalSubmitResponse,
  uploadedFields: string[] = [],
  now = new Date(),
): FalJobReceipt {
  const ts = now.toISOString();
  const receipt: FalJobReceipt = {
    schema: FAL_RECEIPT_SCHEMA,
    provider: "fal",
    model,
    request_id: submit.request_id,
    status: "IN_QUEUE",
    submitted_at: ts,
    updated_at: ts,
    input_hash: inputHash(input),
    status_url: submit.status_url,
    response_url: submit.response_url,
  };
  if (typeof submit.cancel_url === "string") receipt.cancel_url = submit.cancel_url;
  if (uploadedFields.length > 0) receipt.uploaded_fields = uploadedFields;
  return receipt;
}

/** Persist a receipt in the jobs dir; returns its path. */
export function saveReceipt(receipt: FalJobReceipt): string {
  const file = receiptFile(receipt.request_id);
  writeJsonAtomic(file, receipt);
  return file;
}

function isReceipt(value: unknown): value is FalJobReceipt {
  const r = value as Partial<FalJobReceipt> | null;
  return (
    !!r &&
    r.schema === FAL_RECEIPT_SCHEMA &&
    typeof r.model === "string" &&
    typeof r.request_id === "string" &&
    typeof r.status_url === "string" &&
    typeof r.response_url === "string"
  );
}

export function readReceipt(requestId: string): FalJobReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptFile(requestId), "utf8"));
    return isReceipt(parsed) && parsed.request_id === requestId ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Update a stored receipt's status, when one exists. Never throws: the receipt is a convenience. */
export function updateReceiptStatus(requestId: string, status: string): void {
  try {
    const receipt = readReceipt(requestId);
    if (!receipt || receipt.status === status) return;
    saveReceipt({ ...receipt, status, updated_at: new Date().toISOString() });
  } catch {
    // A read-only or missing jobs dir must not fail a status or result call.
  }
}

/** Stored receipts, newest submission first. */
export function listReceipts(limit = 50): FalJobReceipt[] {
  let names: string[];
  try {
    names = fs.readdirSync(falJobsDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const receipts: FalJobReceipt[] = [];
  for (const name of names) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(falJobsDir(), name), "utf8"));
      if (isReceipt(parsed)) receipts.push(parsed);
    } catch {
      // skip unreadable entries
    }
  }
  receipts.sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
  return receipts.slice(0, limit);
}
