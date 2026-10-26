# Code review: Veo download sends the API key only to Files API URIs (#259)

Commit: 5d16773 `fix(gemini): send the API key only to Files API paths in Veo downloads`
Files: src/providers/gemini/veo.ts (+7/-6), tests/unit/providers/gemini/veo.test.ts (+18)

## Verdict
Correct and minimal. It reuses `geminiFileNameFromUri`, the helper Omni already uses, instead of adding a second rule. No blocking issues.

## Verification run
- `npx vitest run tests/unit/providers/gemini/veo.test.ts tests/unit/providers/keyed-redirects.test.ts`: 43/43 passed.
- `npx biome check` on the touched files: clean. `npx tsc --noEmit`: clean.
- Worker bundle: `client.ts` imports nothing from `node:*`. `veo.ts` already imports `node:fs`, and `worker/src` does not import `veo.ts` (it only appears as a name in cli-catalog.json). So the worker bundle surface does not change.

## Correctness probe (WHATWG URL, the same parser undici fetch uses, so the path that is checked is the path that is requested)
| Input | Keyed? | Notes |
|---|---|---|
| `https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media` (real Veo URI) | yes | No regression |
| explicit `:443` | yes | Default port is stripped, same origin |
| uppercase host | yes | Host is lowercased |
| `:8443` | no | `parsed.host` includes the port |
| trailing dot host, `%2e` in host | no | Safe direction (fails closed) |
| `/files/../models/x`, `/files/%2e%2e/models`, `/files/abc/..` | no | Dot segments are resolved before the regex runs |
| `/files%2Fabc`, `abc%3Adownload` | no | `%` is outside the id charset |
| backslash form `https:\\host\v1beta\files\abc` | yes | Normalizes to the real Files path; harmless |
| `evil.com\@host/...` | no | Host parses as evil.com |
| userinfo `u:p@host/v1beta/files/abc` | yes | fetch refuses URLs with credentials before sending, so no request goes out |
| query / fragment | yes | Only the pathname is checked. The query goes to the same Files endpoint; the fragment is never sent |

None of these probes sent the key on the first hop to a path other than `/v1beta/files/<id>[:download]` on the API origin.

## Findings
1. **Optional (doc accuracy). Same-origin redirects keep the key on any path.** `fetchFollowingRedirects` (src/core/redirect-fetch.ts) drops headers only when a hop changes origin. If a Files URI 3xx-redirects to `https://generativelanguage.googleapis.com/<other path>`, the key follows. The new docstring says "so the key never goes to another path, host, or over plain http", which overclaims for "path". Real risk is negligible: the key is valid on the whole host, the origin is Google's, and Omni has the same behavior. Fix: reword to "the first request goes only to a Files API path; downloadFile drops the key on any cross-origin redirect". The alternative is a `validateUrl`/per-hop header policy, which would be out of scope.
2. **Optional (dead code).** In `downloadVeoVideo`, `parsed` is now only assigned. It survives as the "invalid video URI" guard, and biome does not flag it. A bare `new URL(uri)` inside the try, or a short comment, would make the intent clear. Cosmetic.
3. **Optional (test coverage).** The new `it.each` actually catches the old behavior: three of its four cases would have been keyed before (the non-Files path, the nested path, and port 8443). Coverage of URL normalization is still missing: there is no case for a dot-segment path (`/v1beta/files/../models/x`), `%2F`, or explicit `:443` (which should stay keyed). These are guarded by `geminiFileNameFromUri` and pass today, but a regression test would pin them. keyed-redirects.test.ts was not changed and still covers cross-origin and https-to-http redirect stripping for the real URI. It has no same-origin redirect case (see finding 1).
4. **Info (behavior change).** A Gemini-host URI that is not a Files path, such as a hypothetical future `/v1/files/...` or `/upload/...` form, is now fetched without the key and will fail with 401/403 rather than succeed. That fails closed and is the intended trade-off from #259. Veo's documented URI shape matches the regex today.

## Plan / task status
Issue #259's acceptance criteria are met: the key is limited to Files API URIs via the shared helper, real Veo URIs still work, there are tests, and there is no worker impact.

Status: DONE
Summary: The fix is correct and catches the old behavior. On the first hop, no URL normalization or encoding trick can send the key to a non-Files path, and real Veo URIs are still keyed. Only optional findings remain.
Concerns:
- optional: The docstring says the key "never goes to another path", but same-origin redirects keep the header (same behavior as Omni). Reword it.
- optional: `parsed` in downloadVeoVideo is now only a validation guard; simplify it or add a comment.
- optional: Add normalization regression cases (dot-segments, %2F, explicit :443 stays keyed).
- info: Non-Files URIs on the Gemini host now download without the key. This fails closed, as intended.

## Follow-up (b8e3764)

All optional findings were applied: the docstring no longer claims the key never reaches another path, the `parsed` guard became `URL.canParse`, and tests now cover dot segments, an encoded slash, the default port and an invalid URI.
