# Review: PR #125 — chore(worker): bump @modelcontextprotocol/sdk 1.30.1 -> 1.31.0 (closes #102)

Head `16353ad`. Isolated review. The Bash tool was dead, so evidence comes from the GitHub API and reading the local worktree `agent-a58b20a4143747152`.

## Verdict: MERGE

No Critical, High, or Medium findings. Low: 1. Info: 1.

## Checks

| Check | Result | Evidence |
|---|---|---|
| Lockfile only moves the SDK | Pass | `worker/package-lock.json` +4/-4: the root `packages[""]` dependency, plus SDK `version`, `resolved`, and `integrity`. No transitive entries added or removed, because the SDK's dependency list is unchanged. |
| Registry and integrity | Pass | `resolved: https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.31.0.tgz`, `integrity: sha512-UvTMgnNl...VL/pw==` (lock line 1227-1228) |
| Exact pin kept | Pass | `worker/package.json:16` is `"1.31.0"` with no caret |
| Peer ranges | Pass | Peer `zod ^3.25 \|\| ^4.0` is satisfied by 3.25.76. Peer `@cfworker/json-schema ^4.1.1` (optional) is satisfied by 4.1.1. |
| Single SDK copy | Pass | Only `node_modules/@modelcontextprotocol/sdk` appears, with no nested copies. `zod` and `@cfworker/json-schema` each have one entry. |
| API or behaviour drift | None affecting worker | 1.31.0 contains only #2888 (bind stored OAuth credentials to their issuing authorization server) and the version bump. Its upgrade notes cover the OAuth *client* only: the `issuer` field in stored tokens and `expectedIssuer` on the credential providers. The worker uses `McpServer`, `WebStandardStreamableHTTPServerTransport`, `CfWorkerJsonSchemaValidator`, and the `CallToolResult` type, and none of them changed. |
| Advisory fixed | Yes | GHSA-6qxp-vccf-f47h (High, CVSS 7.5): affects 1.12.0-1.30.1, patched in 1.31.0 |
| CI | Green | All 6 runs passed: Ubuntu and Windows on Node 20 and 22, MCP Worker, and Documentation site |

## Findings

- **Low: the vulnerable code path is not used by the worker.** The advisory is in the SDK's OAuth *client* (`authProvider`, `withOAuth()`, `auth()`, `fetchToken()`). The worker is a server only and imports none of these. The bump clears scanner noise (the Dependabot/audit alert) rather than closing a real exposure. The PR body and changelog should not claim the worker was vulnerable. No code change is needed.
- **Info: 1.32.x is already out upstream.** 1.32.0 adds `maxToolInputElements` on `McpServer` (opt-in, may suit the public worker) and same-origin-only redirects for client transports. Consider a follow-up issue. Do not widen this PR.

## Unresolved questions

- I could not view the 15-file diff of #2888 itself (the GitHub compare page does not list file paths). The "client-only" conclusion rests on the release notes and the advisory text, and CI passing the worker typecheck and tests corroborates it.
