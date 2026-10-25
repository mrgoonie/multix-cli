/**
 * Resolve `<model> <requestId>`, or just `<requestId>` when a saved receipt
 * names the model, for `fal status` and `fal result`.
 */

import { ValidationError } from "../../../core/errors.js";
import { readReceipt } from "../job-receipts.js";

export function resolveJobRef(
  first: string,
  second?: string,
): { model: string; requestId: string } {
  if (second) return { model: first, requestId: second };
  const receipt = readReceipt(first);
  if (!receipt) {
    throw new ValidationError(
      `No saved receipt for request ${first}; pass the model too: <model> <requestId>`,
    );
  }
  return { model: receipt.model, requestId: receipt.request_id };
}
