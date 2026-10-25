/**
 * Node-only: durable receipts for fal jobs submitted with `fal run --detach`.
 * A receipt is written as soon as the queue accepts the job, so the request
 * can be resumed with `fal status` / `fal result` after the CLI, terminal or
 * agent session has gone. It holds ids and a hash of the input, never the
 * key, the input itself (it may hold private URLs) or signed URLs.
 *
 * Default location: ~/.multix/fal/requests/<request_id>.json (dir 0700,
 * file 0600, written to a temp file then renamed).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../../agent/agent-runtime.js";

export const RECEIPT_SCHEMA = "multix.fal-receipt/v1";

export interface FalReceipt {
  schema: typeof RECEIPT_SCHEMA;
  provider: "fal";
  model: string;
  request_id: string;
  status: string;
  queue_position?: number;
  submitted_at: string;
  /** sha256 of the submitted input (keys sorted), to spot duplicate submissions. */
  input_hash: string;
  /** Where this receipt was saved; absent when saving failed. */
  receipt_path?: string;
  next: { status: string; result: string };
}

/** JSON with object keys sorted, so equal inputs hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function inputHash(input: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

export function defaultReceiptDir(): string {
  return path.join(os.homedir(), ".multix", "fal", "requests");
}

/** Receipt file for a request id; ids are reduced to a safe file name. */
export function defaultReceiptPath(requestId: string): string {
  return path.join(defaultReceiptDir(), `${requestId.replace(/[^\w.-]/g, "_")}.json`);
}

export function buildReceipt(fields: {
  model: string;
  requestId: string;
  status?: string;
  queuePosition?: number;
  input: Record<string, unknown>;
  submittedAt?: Date;
}): FalReceipt {
  const id = shellQuote(fields.requestId);
  const model = shellQuote(fields.model);
  return {
    schema: RECEIPT_SCHEMA,
    provider: "fal",
    model: fields.model,
    request_id: fields.requestId,
    status: fields.status ?? "IN_QUEUE",
    ...(fields.queuePosition !== undefined ? { queue_position: fields.queuePosition } : {}),
    submitted_at: (fields.submittedAt ?? new Date()).toISOString(),
    input_hash: inputHash(fields.input),
    next: {
      status: `multix fal status ${model} ${id}`,
      result: `multix fal result ${model} ${id} --download`,
    },
  };
}

/** Write the receipt atomically with owner-only permissions; returns its path. */
export function writeReceipt(receipt: FalReceipt, file: string): string {
  const target = path.resolve(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const body = `${JSON.stringify({ ...receipt, receipt_path: target }, null, 2)}\n`;
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}
