# Code review: PR #212, R2 directory path for job outputs

Branch `feat/mcp-r2-directory-prefix` (commit cd7aec0), issue #209. 18 files, +201/-31. Isolated review: the reviewer did not write this code.

## Verification
- `npm run lint`: clean (401 files).
- `npm run check:mcp`: 15 files / 195 tests pass, wrangler dry-run ok, bundle check clean.

## Critical
None.

## High
None.

## Medium

**M1. Mixed old and new versions during a deploy: jobs with a custom prefix fail with "Invalid job" until the container rollout finishes.** Files: `worker/container/job-runner.mjs:53,60-71` and `worker/src/jobs/job-runner.ts:143-144`.
- Cloudflare's rollout docs say `wrangler deploy` turns on the new Worker first. The container image then rolls out gradually (about 10%, then 100%). Until that finishes, the new Worker code can still reach instances running the old image.
- The old image checks keys against `^multix\/[0-9a-f]{16}\/…$`.
- Failure scenario: a user saves `agents/outputs` right after the deploy. Their next `multix_run` lands on an old-image instance. `validateSpec` throws `SpecError("Invalid job")`, so the job fails with no outputs. Users on the default prefix are not affected.
- The problem goes away once the rollout finishes. Nothing is lost or written to the wrong place, but it shows up as a confusing error.
- Fix options, any one of these:
  - (a) Ship the container change in its own deploy first. The new `validKeyPrefix` accepts the old `multix/…` keys, so the image is backward compatible. Then ship the Worker and UI change.
  - (b) Deploy with `--containers-rollout=immediate` and say so in the PR. This shortens the mixed window but does not remove it.
  - (c) At minimum, note the deploy order in the PR or release notes.

## Low

**L1. A PUT to `/storage` without `prefix` quietly resets the prefix to `multix`.** Files: `worker/src/api/account-api-handlers.ts:170` and `worker/src/accounts/r2-settings.ts:111-113`.
- A client that saved `prefix: "team/out"` earlier and later rotates its keys without resending `prefix` starts writing to `multix/` with no warning.
- This fits full-replace PUT semantics, since secrets are also required each time. But the docs only say "optional, default `multix`".
- Fix: add one sentence to rest-api.md (EN and VI) saying PUT replaces every field, including `prefix`.

**L2. Rolling back the Worker silently drops custom prefixes.**
- The old `isR2Settings` ignores the extra `prefix` field, so after a rollback outputs go back to `multix/…`. Saving again from the old dashboard deletes the field for good.
- No data is lost. Mention it in the rollback notes.

**L3. OpenAPI `StorageInput.prefix.maxLength: 256` describes the raw input, but the server limits the normalised value.**
- Files: `worker/src/api/openapi-document.ts:366-372` and `r2-settings.ts:65-67`.
- Example: the raw value `"/" + "a".repeat(255) + "/"` is 257 characters. It breaks the schema's `maxLength` but the server accepts it. A schema-validating client would reject a request the server allows.
- The schema also has no `pattern`. A possible value is `^/*[A-Za-z0-9._-]+(/+[A-Za-z0-9._-]+)*/*$`, either here or as a description note. Cosmetic.

**L4. Stale doc comment** at `worker/src/jobs/job-runner.ts:67`. It still says `multix/<sha256(userId)[0:16]>/<jobId>` and should say `<directory>/…`.

**L5. Behaviour change for default users: the probe object moved from the bucket root to `multix/.multix-probe-*`.** `r2-access-check.ts:54` is called with `r2Prefix(...)`, which is never empty.
- This is harmless, and the docs and OpenAPI wording ("under/into the directory path") covers it.
- The `directory = ""` default branch now has no production caller. Keep it or drop it.

## Checked, no issue found
- **Traversal / key injection:** each segment must match `[A-Za-z0-9._-]+`, and `.` and `..` are rejected (`r2-settings.ts:64-70`). The container checks again (`job-runner.mjs:60-71`). Both R2 clients refuse empty, `.` and `..` segments and encode each segment per RFC 3986 (`r2-client.ts:63-84`, `container/r2-upload.mjs:47-63`).
  - `%`, `?`, `#`, spaces, unicode, backslash and control characters are all rejected before encoding.
  - The prefix comes before the account hash, and each user writes only to their own bucket with their own credentials. A prefix therefore cannot reach another tenant's data.
- **Normalisation edge cases:**
  - Whitespace around the value is trimmed; whitespace inside it is rejected.
  - Repeated slashes collapse (`a//b` becomes `a/b`).
  - `/`, `" / "` and blank all mean the default.
  - `/multix/` normalises to the default and is not stored. This is tested.
  - `...` and `.hidden` are allowed. Both are valid R2 keys and not dot-segments.
  - The length check runs after normalisation (at most 256). The HTML `maxlength` limits the raw input, so it can only be stricter.
- **Key length budget:** prefix (256) + `/` + hash (16) + `/` + uuid (36) + `/` + name. The name is at most 200 UTF-16 units, so at most 600 UTF-8 bytes. The total is at most 912 bytes, under R2's 1024. The container allows a 512-character prefix, which covers the 310 the Worker can produce.
- **XSS:** the input `value` and the status line both pass through `escapeHtml`, which encodes `& < > " '` (`http-responses.ts:63`). The stored value is also restricted to safe characters. The error notices are fixed text and never repeat the input. `r2-invalid-prefix` is registered automatically through the `PROBLEM_NOTICES` mapping (`r2-settings-routes.ts:68`).
- **Stored settings and in-flight jobs:** settings saved without `prefix` read back as `multix`, the same layout as before. A job's key prefix is computed once when the spec is built, so changing the prefix does not affect running jobs. Nothing else lists or cleans up by prefix (searched `worker/src`).
- **OpenAPI:** `Storage.prefix` is always a string, which matches `r2Prefix()` never returning null. The PUT example and description match the behaviour.
- **Docs EN/VI:** mcp-server.md and rest-api.md match in content (charset, 256 limit, no dot segments, default, probe placement). The VI mcp-server page mentions slashes being dropped, as EN does; the VI rest-api page leaves it out, as EN does. README updated. `skill/SKILL.md` does not describe the R2 layout, so no update is needed.
- **Tests:** they cover normalisation, probe placement, prefill, rejecting bad input before any R2 call, the REST 400 response, the job spec key prefix, and the container validator (including traversal and the missing-directory case). Missing: a test for the container validator's 512-character limit. Minor.

## Recommended actions
1. M1: decide on the deploy order (container image first, or an immediate rollout) and record it in the PR body.
2. L1: document in EN/VI that a PUT without `prefix` resets it to the default.
3. L4: fix the comment. Optionally tighten the OpenAPI schema (L3).

## Unresolved questions
- Will production be deployed with a single `wrangler deploy` (mixed window applies) or with the container image deployed first?

Status: DONE_WITH_CONCERNS
Summary: Prefix validation, encoding and escaping are sound and lint plus check:mcp pass. The one real concern is the deploy window, when an old container image rejects jobs with a custom prefix. Docs and OpenAPI have small gaps.
