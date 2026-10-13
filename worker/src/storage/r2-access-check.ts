/**
 * Prove that R2 credentials can read and write one bucket before they are
 * saved: ListObjectsV2 max-keys=1 (allowed for every R2 token type, including
 * bucket-scoped ones), then PUT and DELETE of an empty probe object.
 *
 * The result is a fixed code, never text from R2, so nothing the user typed
 * (or R2 echoed back) can reach the page or the logs.
 */

import type { FetchLike } from "../../../src/core/fetch-json.js";
import { R2Client, type R2Credentials, R2RequestError } from "./r2-client.js";

/** Object written and removed again by the write check. */
export const R2_PROBE_KEY = ".multix-probe";
/** Per-request timeout for the checks, so a hung connection cannot stall the dashboard. */
const CHECK_TIMEOUT_MS = 10_000;

export type R2AccessResult =
  | "ok"
  /** 401/403 on list: wrong key pair, or a token not scoped to this bucket. */
  | "denied"
  /** 404 NoSuchBucket on list. */
  | "no-bucket"
  /** List works, upload is refused: a read-only token. */
  | "read-only"
  /** Upload works, deleting the probe object is refused. */
  | "no-delete"
  /** Network error or timeout. */
  | "unreachable"
  /** Any other HTTP failure. */
  | "error";

function classify(error: unknown, step: "list" | "put" | "delete"): R2AccessResult {
  if (!(error instanceof R2RequestError)) return "error";
  if (error.status === 0) return "unreachable";
  if (step === "list") {
    if (error.status === 401 || error.status === 403) return "denied";
    if (error.status === 404) return "no-bucket";
    return "error";
  }
  if (error.status === 401 || error.status === 403) {
    return step === "put" ? "read-only" : "no-delete";
  }
  return "error";
}

export async function checkR2Access(
  settings: R2Credentials & { bucket: string },
  fetch?: FetchLike,
): Promise<R2AccessResult> {
  const client = new R2Client({ ...settings, fetch, timeoutMs: CHECK_TIMEOUT_MS });
  const steps: ["list" | "put" | "delete", () => Promise<void>][] = [
    ["list", () => client.listProbe(settings.bucket)],
    ["put", () => client.putObject(settings.bucket, R2_PROBE_KEY, new Uint8Array(0), "text/plain")],
    ["delete", () => client.deleteObject(settings.bucket, R2_PROBE_KEY)],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      return classify(error, step);
    }
  }
  return "ok";
}
