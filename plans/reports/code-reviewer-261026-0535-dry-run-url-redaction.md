# Code review: redact URL query strings in dry-run request bodies (HEAD 5900ea9, issue #318)

## Scope
- src/agent/fetch-telemetry.ts (URL_QUERY + shorten), tests/unit/agent/fetch-telemetry.test.ts,
  tests/smoke/agent-mode.test.ts, docs-site for-ai-agents.md (en, vi). REVIEW.md: not present.
- Checks run: `npx vitest run tests/unit/agent` (19/19 pass); `npm run build` + smoke test
  "dry run never prints a URL query value" (pass); regex probes with node.

## Findings

### Medium: an apostrophe in the URL path or query stops redaction, so the signature still leaks
`URL_QUERY = /(https?:\/\/[^\s?#"'<>]*)\?[^\s#"'<>]*/gi` treats `'`, `"`, `<` and `>` as the end of the URL.
`'` is a legal, unencoded character in a URL path (WHATWG `new URL()` keeps it as-is in the path), and
a user-typed query string can contain it too. CLI options go into the body unchanged
(for example `image_url: opts.imageUrl` in src/providers/fal/commands/video.ts:53), so normalization does not catch these:

| Input (body string) | Output |
|---|---|
| `https://cdn.example.com/it's.png?sig=SECRET` | `https://cdn.example.com/it's.png?sig=SECRET` (whole query leaks: the path part stops at `'`, no `?` follows, no match) |
| `https://a/x?name=it's&sig=SECRET` | `https://a/x?[redacted]'s&sig=SECRET` (query ends early at `'`) |

The same applies to raw `"`, `<`, `>` in a user-supplied URL, but those are less likely in practice.
Fix: fail closed. End the URL only at whitespace and end the query only at whitespace or `#`:
`/(https?:\/\/[^\s?#]*)\?[^\s#]*/gi`. Strings are already JSON-unescaped by `JSON.parse`, so the
quote exclusions only protect prose or embedded JSON. There the worst case is over-redacting a
closing quote or bracket, which is acceptable. Add the two inputs above as unit cases.

## Checked, no defect
- Backtracking: the path class excludes `?`, so each start position is linear. Inputs are capped at
  400 chars (longer strings become `<N chars>`). Probes with repeated `http://` and long paths ran in
  under 1 ms.
- Global regex state: `String.prototype.replace` with a /g regex resets `lastIndex` to 0, so no state carries between calls.
- Uppercase scheme (`HTTPS://`, `i` flag), several URLs in one prose string, a URL nested in a query
  (`?u=https://b/y?sig=S`, all redacted), a URL without a query (unchanged), and a fragment (kept, as
  documented and tested) all behave correctly. A literal `?` cannot sit in a path; `%3F` stays in the path, which is correct.
- Body paths: JSON string bodies are redacted at every depth that is shown. Strings in arrays are
  redacted at any depth. Objects deeper than 4 levels become `<object>`. Bodies that are not JSON,
  ArrayBuffers and views show only their size. FormData string fields go through `shorten` and file
  fields show only their size. URLSearchParams, Blob, stream and `Request` bodies are not described
  at all, so nothing leaks. Secret-named keys are still replaced first.

## Informational (no change required for #318)
- Object keys are not redacted (`{"https://x/a?sig=S": 1}` leaks). No provider body uses URL keys.
- `user:pass@` userinfo and path-embedded tokens are not redacted. The docs promise only "URL query strings", so the docs are accurate.
- History uses a different rule: `redactArgv` (src/agent/history-store.ts:78) redacts only when a known
  signature parameter is present (SIGNED_QUERY). The body rule redacts every query. The difference
  in direction is acceptable; it is noted only so the two are not merged by mistake.
- Over-redaction in prose: `(https://a/x?sig=S), next` becomes `(https://a/x?[redacted] next`. This is cosmetic.

## Tests and docs
- The unit tests assert both that the secrets are absent and the exact redacted shape (nested
  object, array, prose, fragment, a URL without a query, FormData), and `afterEach` resets `run.dryRun`. The smoke test drives the real
  `fal video --image-url` path. The tests are good apart from the missing apostrophe cases.
- The English and Vietnamese doc rows are accurate and consistent with each other.

## Verdict
No blocking findings. One medium leak path (apostrophe or raw quote in a user-supplied URL) is worth a one-line regex fix and two test cases.

Status: DONE_WITH_CONCERNS
Summary: The fix is correct for normal pre-signed URLs and the tests and docs are sound, but a URL with `'` in its path or query still leaks its signature.
Concerns/Blockers: The URL_QUERY character classes should stop only at whitespace (and `#` for the query) so redaction fails closed.
