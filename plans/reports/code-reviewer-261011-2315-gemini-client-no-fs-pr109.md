# Code review: PR #109 refactor(gemini): move file-system work out of the Gemini client

- PR: https://github.com/mrgoonie/multix-cli/pull/109 (branch `refactor/gemini-client-no-fs`, head `b1e523b`), Closes #93
- Reviewed: 2026-10-11 (Asia/Saigon), isolated context. The reviewer did not write this code.
- Worktree: `D:\www\oss\multix-cli\.claude\worktrees\agent-ab0140bb8f2dc72b3`
- CI at `b1e523b`: all 6 check runs passed (Node 20/22 on ubuntu and windows, MCP Worker, Documentation site). Bash was unavailable in this session, so nothing was run locally. The review used Read/Grep and GitHub only.

## Code Review Summary

### Scope
- Files: `src/providers/gemini/client.ts`, `src/providers/gemini/local-files.ts` (new), `src/providers/gemini/commands/{analyze,extract,transcribe}.ts`, `src/commands/doc/convert.ts`, `tests/unit/providers/gemini/{upload,key-pool}.test.ts`
- Focus: behaviour parity, caller coverage, whether the change is actually safe for a Worker, and test quality
- Scout findings: the Worker bundle has no `nodejs_compat` (`worker/wrangler.jsonc:8`) and is checked by `worker/scripts/check-bundle.mjs`, which fails on `node:*`, bare built-ins and `dotenv`-style imports. `client.ts` still pulls in Node modules through its relative imports. `downloadGeneratedFile` has no callers.

### Overall Assessment
The mechanical refactor is correct. Behaviour is the same as before, every caller was updated, and the streaming tests still prove no full-file read, peak memory below size/2, and `redirect: "error"` on both requests. The issue's literal acceptance criterion ("`client.ts` contains no `node:*` imports") is met. The issue's goal (reuse the client in a Cloudflare Worker) is not. Through `env-loader.ts`, `http-client.ts` and `task-resolver.ts`, `client.ts` still imports `node:fs`, `node:os`, `node:path`, `node:stream`, `node:stream/promises` and `dotenv`. It also reads `process.env` on every upload, which throws in a Worker without `nodejs_compat`. The new guard test checks direct imports only, so it gives false confidence. The fix is small (about 30 LOC) and fits the issue.

### Critical Issues
None.

### High Priority

**H1. `client.ts` cannot be bundled into the Worker: the Node-free claim holds only at depth 1.**
- `src/providers/gemini/client.ts:11` imports `resolveKey` from `core/env-loader.ts`, which imports `node:fs`, `node:os`, `node:path` and `dotenv` (`env-loader.ts:16-19`).
- `src/providers/gemini/client.ts:13` imports `downloadFile` and `httpJson` from `core/http-client.ts`, which imports `node:fs`, `node:path`, `node:stream`, `node:stream/promises` and `env-loader` (`http-client.ts:7-11`).
- `src/providers/gemini/client.ts:17` imports `requiresProcessingWait` from `task-resolver.ts`, which imports `node:path` (`task-resolver.ts:6`).
- `worker/wrangler.jsonc:8` says "No nodejs_compat: the bundle must not depend on Node built-ins", and `worker/scripts/check-bundle.mjs:13-20` enforces it. A Worker adapter that imports `client.ts` today would fail `check:bundle`, or fail at runtime on `fs`/`os` module evaluation. So the issue's purpose ("so the client can be reused from non-Node runtimes such as a Cloudflare Worker", and AGENTS.md "Keep provider HTTP clients free of `node:*` imports ... so they can be reused by non-Node runtimes") is not delivered, even though the regex test passes.
- The answer to the agent's concern: yes, it defeats the goal. All three edges are value imports, not type-only imports, and none is load-bearing:

| Edge | Used for | Smallest fix |
|---|---|---|
| `http-client.downloadFile` | `downloadGeneratedFile` (`client.ts:425-427`), which writes to disk and has **zero callers** in `src/`, `tests/` or `worker/` | Delete `downloadGeneratedFile`. It is file-system work the issue asked to move out anyway. |
| `http-client.httpJson` | polling (`:289`), `generateContent`, `createInteraction`, `listModels` | `httpJson` just forwards to `fetchJson` (`http-client.ts:28-30`). Import `fetchJson` from `../../core/fetch-json.js`, which `worker-safe-http.test.ts:16` already treats as Worker-safe. |
| `task-resolver.requiresProcessingWait` | processing poll (`:285`) | Move the one-line predicate into `client.ts`, or into a new Node-free `mime-types.ts`, and re-export it from `task-resolver.ts` so existing imports keep working. Don't rewrite `path.extname` by hand: the edge cases (dotfiles, trailing dots) aren't worth the parity risk. |
| `env-loader.resolveKey` | `minUploadBytesPerSec()` (`:86-96`), called unconditionally in `uploadFile` (`:144`) | See H2. A type-only import does not help here. |

**H2. `uploadFile` reads `process.env` on every call. This throws `ReferenceError: process is not defined` in a Worker without `nodejs_compat`.**
- `client.ts:144` calls `minUploadBytesPerSec()`, which calls `resolveKey`, which reads `process.env[name]` (`env-loader.ts:134-136`). Fixing the import alone is not enough: a Worker that bundles `client.ts` still crashes on the first upload.
- Smallest fix that keeps the "bad value fails fast before any request, never retried" behaviour: give `uploadFile` an optional `minUploadBytesPerSec?: number` option, defaulting to `DEFAULT_MIN_UPLOAD_BYTES_PER_SEC`. Move `UPLOAD_MIN_KBPS_ENV` and `minUploadBytesPerSec()` to `local-files.ts`, and have `uploadLocalFile` call it before `fs.openAsBlob`. This matches the AGENTS.md rule that the command layer owns env loading and clients take their inputs as parameters. Update the imports in `upload.test.ts:16`. The `rejects MULTIX_UPLOAD_MIN_KBPS=... before any request` tests already go through `uploadLocalFile`, so they keep passing.
- Alternative, if `MULTIX_UPLOAD_MIN_KBPS` should keep applying to every caller: split `resolveKey`/`resolveFirstKey` into a Node-free `core/env.ts` that reads `globalThis.process?.env`, and re-export it from `env-loader.ts`. This is less clean, because it hides an env dependency inside a client that is meant to take its inputs as parameters.

**Recommendation for H1 and H2: fix in this PR.** The PR says `Closes #93`, and #93's motivation is Worker reuse. Both fixes together are about 30 LOC across `client.ts`, `local-files.ts`, `task-resolver.ts` and one test import, with no behaviour change for the CLI. If the maintainer wants to keep this PR to the literal acceptance criterion, then change `Closes #93` to `Refs #93` and open a follow-up issue for transitive Worker safety, so #93 is not closed with its goal unmet.

### Medium Priority

**M1. The runtime-neutrality test checks direct imports only, so it passes while the module is not Worker-safe** (`tests/unit/providers/gemini/upload.test.ts:395-400`).
- It reads one file and applies a regex. It would not catch any of the H1 edges. The same weakness applies to `tests/unit/core/worker-safe-http.test.ts:16-23`, although its four modules happen to be clean today (`errors.ts` imports only `redact.ts`).
- Recommended: one shared test helper that starts from an entry file and walks the **value** imports with relative specifiers (skipping `import type` and `export type`). For each import it resolves `./x.js` to `x.ts`, collects every reached file, and asserts that no reached file imports `node:*`, a bare built-in (reuse the `BARE_BUILTINS` list from `worker/scripts/check-bundle.mjs:10-11`), or `dotenv`. Run it for `src/providers/gemini/client.ts` and for the `WORKER_SAFE_MODULES` list. Give the failure message the import chain so a regression is easy to trace. This needs no new dependency; don't import `esbuild` directly from tests, since it is only a transitive dependency of `tsup`.
- Better still once a Gemini Worker adapter exists: rely on `worker`'s `check:bundle`. Until then, the graph-walk test is the guard. Also cover `process` usage: either assert that reached files do not reference the `process.` identifier, or accept H2's option-based fix and add a test that `uploadFile` succeeds with `vi.stubGlobal("process", undefined)`-style isolation. The first is simpler.

**M2. `listModels` always goes through the key pool, which reads `process.env`** (`client.ts:413-420` → `key-pool.ts:30` default `env = process.env`).
- `generateContent`, `createInteraction` and `uploadFile` avoid the pool when `apiKey` is passed (`withKey`, `client.ts:65-67`). `listModels` takes no `apiKey`, so it cannot be used from a Worker. This is outside #93's literal scope. Either give `listModels` a `GeminiCallOptions` parameter in the same pass (a 2-line change), or list it in the follow-up issue. Not blocking.

### Low Priority

**L1. The upload request now carries a Content-Type when the caller's Blob has a type.** `fs.openAsBlob(filePath)` (`local-files.ts:23`) creates an untyped Blob, so the CLI path is unchanged. A Worker passing `new File([...], name, { type })` makes fetch add `Content-Type: <type>` to the `upload, finalize` request (`client.ts:268-280`). This is harmless for Google's resumable protocol, which takes the type from `X-Goog-Upload-Header-Content-Type` on `start`. Worth a one-line note in the `UploadSource.blob` doc, or set `Content-Type` explicitly to `mimeType` so every caller sends the same request.

**L2. The processing-error label is untested.** `label` defaults to `displayName` (`client.ts:237`). `uploadLocalFile` passes the full path (`local-files.ts:29`), so `File processing failed: <path>` keeps its old text. No test covers the FAILED/PROCESSING message for either the label or the default.

**L3. `inlinePart` and `shouldUseFileApi` were moved unchanged and are still untested** (`local-files.ts:38-48`), including the 20 MB boundary (`>` rather than `>=`). This is not a regression, but `INLINE_MAX_BYTES` is now a named constant, so a boundary test costs very little.

**L4. The no-node regex misses `require("node:…")`, `export … from "node:…"` and bare built-ins** (`upload.test.ts:398`). M1's helper would replace it.

### Behaviour parity (verified)

| Area | Before (main) | After (PR) | Verdict |
|---|---|---|---|
| 2 GB limit before any request | `fs.statSync(filePath).size`, message names `path.basename(filePath)` | `source.blob.size` (`client.ts:137-142`), message names `displayName = path.basename(filePath)` (`local-files.ts:27`) | Same message and same order. The test proves `fetch` is not called (`upload.test.ts:170-187`). |
| Streaming | `fs.openAsBlob(filePath)` inside each key attempt | `fs.openAsBlob` once in `uploadLocalFile` (`local-files.ts:23`); the blob is sent as the `body` (`client.ts:276`) | Streaming kept; no `readFile`. A file-backed Blob can be re-read if the pool retries. The 256 MB test still asserts no `readFileSync`/`readFile` and peak memory below size/2 (`upload.test.ts:105-168`). |
| `redirect: "error"` | both requests | unchanged (`client.ts:176`) and asserted (`upload.test.ts:145`) | Same. |
| Error classes | HttpError(0) for network failures and a timed-out `start`; ProviderError for a refused redirect or a timed-out byte upload | `uploadFetch` unchanged (`client.ts:164-199`); the tests at `:280-327` still pass | Same. |
| `MULTIX_UPLOAD_MIN_KBPS` fail-fast | read before `withKey` | read before `withKey` (`client.ts:144`), now after `openAsBlob`, which makes no request | Same (still before any request). |
| Key rotation and pinned key | `withKey` | unchanged; callers pin `apiKey` inside `withGeminiKey` (`analyze.ts:53-78`, `convert.ts:111-136`) | Same. Rotation test at `upload.test.ts:213-234`. |
| Processing-error text | `File processing failed: ${filePath}` | `label = filePath` (`local-files.ts:29`) | Same text, but untested (L2). |
| Inline vs Files API threshold | `> 20 * 1024 * 1024` | `INLINE_MAX_BYTES`, same value and comparison (`local-files.ts:13,47`) | Same. |
| Piped stdin | temp file from `resolveFileInputs`, then the path-based helpers | unchanged; the helpers receive the temp path | Same. |
| Missing file | `statSync` ENOENT before any request | `shouldUseFileApi` → `statSync` ENOENT first, as before; `openAsBlob` ENOENT otherwise | Same class of error; it is not an HttpError, so it is not retried. |

Callers: `uploadFile(path)` has no remaining callers. `inlinePart`, `shouldUseFileApi` and `uploadLocalFile` are imported from `local-files.ts` in `analyze.ts:11`, `extract.ts:10`, `transcribe.ts:10` and `convert.ts:21-25`, and in the tests (`upload.test.ts:21`, `key-pool.test.ts:237`). `worker/` has no Gemini adapter, so there is nothing to update there. The other `client.js` importers (`speech.ts`, `image-to-image.ts`, `generate.ts`, the speech tests) do not use the moved symbols.

### Edge Cases Found by Scout
- `downloadGeneratedFile` is dead code that writes to disk, and it is the only reason `client.ts` imports `downloadFile` (H1).
- The Worker runtime has neither `process` nor `nodejs_compat`, so env access inside the client is a runtime failure, not just a bundling one (H2, M2).
- An untyped Blob from `openAsBlob` versus a typed Worker `File` changes the request headers (L1).

### Positive Observations (risk calibration only)
- `UploadSource` with a required `mimeType` and `displayName` avoids guessing from `blob.type`, and the in-memory test checks that the exact Blob instance is sent as the body (`upload.test.ts:207`), so the client does not copy it.
- The `HugeBlob` subclass removes the `fs.statSync` stub and tests the real size path.

### Recommended Actions
1. (H1) Delete `downloadGeneratedFile`. Switch `httpJson` to `fetchJson` from `core/fetch-json.js`. Move `requiresProcessingWait` into a Node-free module and re-export it from `task-resolver.ts`.
2. (H2) Make the minimum upload speed an `uploadFile` option, and move `minUploadBytesPerSec`/`UPLOAD_MIN_KBPS_ENV` to `local-files.ts`, read before `openAsBlob`.
3. (M1) Replace the one-file regex with a transitive value-import walker shared with `worker-safe-http.test.ts`. Assert no `node:*`, bare built-in, or `dotenv` import, and no `process.` use, in anything reachable from `client.ts`.
4. (M2) Add an optional `GeminiCallOptions` to `listModels`, or record it in a follow-up issue.
5. If 1-3 are deferred, change `Closes #93` to `Refs #93` and open the follow-up issue before merge.
6. Low: label test, 20 MB boundary test, a note on Content-Type from the Blob.

### Metrics
- Type coverage: no new `any`. The existing `biome-ignore` comments in `listModels` are unchanged.
- Test coverage: upload paths covered well; label and inline/threshold helpers not covered.
- Lint: CI green on all 6 checks at `b1e523b`; not run locally (Bash unavailable).

### Docs impact
None user-facing: no CLI flag, env var or output changed. If H2 moves `MULTIX_UPLOAD_MIN_KBPS` handling into `local-files.ts`, the CLI behaviour stays the same and no docs change is needed. Optionally, AGENTS.md "Code conventions" could add that a client's relative imports must be Node-free too, not just the file itself. That is a maintainer decision.

### Unresolved Questions
- Should `MULTIX_UPLOAD_MIN_KBPS` apply to Worker callers (keep the env read in the client through a Node-free `core/env.ts`), or only to the CLI (option-based, recommended)?
- Is a Gemini Worker adapter planned soon? If so, its `check:bundle` run would make M1's graph walker redundant for `client.ts`.

Status: DONE_WITH_CONCERNS
Summary: Fix-first. The refactor is behaviour-identical and CI is green, but `client.ts` still reaches Node built-ins and `process.env` through its imports, so the Worker-reuse goal of #93 is not met. Counts: 0 critical, 2 high, 2 medium, 4 low.
