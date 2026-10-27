/**
 * `media check-receipt`: does a verify receipt vouch for this exact file?
 * A receipt names the sha256 of the bytes it judged, so a receipt for a
 * source does not vouch for a file transcoded, remuxed or re-encoded from it:
 * verify the final file itself. Receipts are not signed: they record a
 * local run, so trust one only as far as you trust where it came from.
 */

import fs from "node:fs";
import { ValidationError } from "../../core/errors.js";
import { resolveMediaSource } from "./media-source.js";
import { VERIFY_ENGINE, VERIFY_SCHEMA, type VerifyReceipt } from "./media-verify.js";

export interface ReceiptCheck {
  ok: boolean;
  hash_matches: boolean;
  receipt_status: VerifyReceipt["status"];
  receipt_sha256: string;
  file_sha256: string;
  profile: { id: string; version: number };
  /** The verify engine that made the receipt; an older one may miss defects the current one finds. */
  engine: { receipt: string | null; current: string; current_matches: boolean };
  reason?: string;
  warnings: string[];
}

export function readReceipt(file: string): VerifyReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new ValidationError(`Invalid receipt ${file}: ${(e as Error).message}`);
  }
  // Accept a bare receipt or the multix.result/v1 envelope that carries one as `data`.
  const outer = raw as { schema?: string; data?: unknown } | null;
  const r = outer?.schema === "multix.result/v1" ? outer.data : raw;
  const receipt = (r ?? undefined) as Partial<VerifyReceipt> | undefined;
  if (
    receipt?.schema !== VERIFY_SCHEMA ||
    typeof receipt.source?.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(receipt.source.sha256) ||
    !["pass", "fail", "incomplete"].includes(receipt.status as string) ||
    typeof receipt.profile?.id !== "string"
  )
    throw new ValidationError(
      `Invalid receipt ${file}: not a ${VERIFY_SCHEMA} receipt with a source sha256, status and profile`,
    );
  return receipt as VerifyReceipt;
}

export async function checkReceipt(receiptFile: string, mediaFile: string): Promise<ReceiptCheck> {
  const receipt = readReceipt(receiptFile);
  const src = await resolveMediaSource(mediaFile);
  const hashMatches = src.sha256 === receipt.source.sha256;
  const ok = hashMatches && receipt.status === "pass";
  // An older engine's verdict still stands as a record of its run, so it is reported, not failed.
  const receiptEngine = typeof receipt.engine?.id === "string" ? receipt.engine.id : null;
  const engineMatches = receiptEngine === VERIFY_ENGINE;
  return {
    ok,
    hash_matches: hashMatches,
    receipt_status: receipt.status,
    receipt_sha256: receipt.source.sha256,
    file_sha256: src.sha256,
    profile: { id: receipt.profile.id, version: receipt.profile.version },
    engine: { receipt: receiptEngine, current: VERIFY_ENGINE, current_matches: engineMatches },
    ...(!hashMatches
      ? {
          reason:
            "the file's bytes differ from the bytes the receipt judged; run media verify on this file",
        }
      : receipt.status !== "pass"
        ? { reason: `the receipt's verdict is ${receipt.status}` }
        : {}),
    warnings: engineMatches
      ? []
      : [
          `the receipt was made by verify engine ${receiptEngine ?? "(unknown)"}, current is ${VERIFY_ENGINE}; rerun media verify on this file to apply the current checks`,
        ],
  };
}
