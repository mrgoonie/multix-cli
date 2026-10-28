import type { SecretRecords, StoredSecret } from "../src/accounts/account-store.js";
import type { DashboardView } from "../src/pages/dashboard-page.js";
import { DEFAULT_PREFERENCES } from "../src/pages/preferences.js";

const SAVED_AT = Date.UTC(2026, 9, 28, 9, 30);

/** A saved-secret record: the page only reads `updatedAt`. */
export function storedSecret(updatedAt = SAVED_AT): StoredSecret {
  return { updatedAt } as StoredSecret;
}

/** A signed-in dashboard view with nothing configured; override what a test needs. */
export function dashboardView(overrides: Partial<DashboardView> = {}): DashboardView {
  return {
    account: {
      id: "gh-583231",
      githubId: 583231,
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231",
      emails: [],
      createdAt: SAVED_AT,
      lastLoginAt: SAVED_AT,
    },
    secrets: {} satisfies SecretRecords,
    r2: null,
    csrf: "csrf-token",
    origin: "https://mcp.example.com",
    mcpUrl: "https://mcp.example.com/mcp",
    apiKeys: [],
    clients: [],
    prefs: DEFAULT_PREFERENCES,
    ...overrides,
  };
}
