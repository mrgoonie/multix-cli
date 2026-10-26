/**
 * Best-effort activity recording for write handlers outside the usage
 * ledger (API keys, provider keys, storage, subscriptions). A missing
 * MULTIX_USAGE binding or a failed RPC never fails the user's request.
 * Callers pass names and ids only, never key values.
 */

import type { AccountUsageStub } from "./account-usage.js";
import type { ActivityInput } from "./usage-types.js";

export async function recordActivity(
  usage: AccountUsageStub | undefined,
  input: ActivityInput,
): Promise<void> {
  if (!usage) return;
  try {
    await usage.recordActivity(input);
  } catch {
    // The activity log is an audit aid; losing one entry must not fail the write.
  }
}
