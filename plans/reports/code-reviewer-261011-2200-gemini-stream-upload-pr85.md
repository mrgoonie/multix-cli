# Code Review: PR #85, perf(gemini) streaming Files API upload (closes #73)

## Scope
- Branch `perf/gemini-stream-upload` @ `6d9074f`
- Files: `src/providers/gemini/client.ts`, `tests/unit/providers/gemini/upload.test.ts` (new), `docs-site/src/content/docs/commands/gemini.md`, `docs-site/src/content/docs/vi/commands/gemini.md`
- Method: Bash returned no output in this session, and no local worktree exists for the branch. PR files were inspected through targeted queries against `raw.githubusercontent.com` at the branch head. Base code, callers, and `key-pool.ts` were read locally. CI check runs were read from the GitHub API. Line numbers for PR files come from those remote queries, so treat them as approximately right.
- CI at `6d9074f`: all green. Node 20 and 22 on ubuntu-latest and windows-latest (each job took 25 to 70 s), plus the docs site.

## Overall Assessment
The core change is correct. The file is opened lazily with `await fs.openAsBlob(filePath)` (client.ts:108) and placed in `new Blob([head, file, tail])` (client.ts:113), so undici streams it with `Content-Length = blob.size`. `redirect: "error"` (client.ts:133) is load-bearing and its comment is accurate: in undici's `httpNetworkOrCacheFetch`, the request is used uncloned only when `window === "no-window"` and `redirect === "error"`. Otherwise `cloneRequest` tees the body, and the unread branch buffers the whole upload. The 2 GB check (client.ts:86) runs before `withKey`, so no request is made. The test's assertions are behavioural, not phantom: no `readFileSync`/`readFile` calls, peak `arrayBuffers` growth below size/2, byte-exact multipart framing, and `Content-Length` equal to the bytes received. No blocking defects found.

## Critical Issues
None.

## High Priority
None.

## Medium Priority

### M1. The 300 s default timeout caps uploads well below the 2 GB the docs now promise
- `client.ts:103` (`timeoutMs = 300_000`) and `client.ts:134` (`AbortSignal.timeout(timeoutMs)`). No caller passes `timeoutMs`: `analyze.ts:66`, `transcribe.ts:67`, `extract.ts:66`, `doc/convert.ts:84`.
- Failure scenario: a 1 GB video on a 20 Mbps uplink needs about 430 s. The upload aborts at 300 s with `TimeoutError: The operation was aborted due to timeout`. The PR keeps the existing default, but the new docs line says "files up to 2 GB" are accepted. Above roughly 375 MB at 10 Mbps, or 1.8 GB at 50 Mbps, every upload fails after minutes of wasted bandwidth. This is not an `HttpError`, so it is surfaced as-is.
- Fix: base the upload signal on size. For example `Math.max(timeoutMs, size / (1 MB/s) * 1000)`, or a separate `uploadTimeoutMs` with no cap. Keep `timeoutMs` for the polling deadline (client.ts:148). Alternatively, document the effective limit. Either way, open a follow-up issue if it is not fixed here.

### M2. Multipart upload for files up to 2 GB has not been checked against the live API
- `client.ts:113-135` still sends `X-Goog-Upload-Protocol: multipart`. Issue #73 offered `openAsBlob` or the resumable protocol. Google's own REST samples for the Gemini Files API use resumable (`start` → `upload, finalize`), and Google upload APIs generally recommend multipart only for small payloads.
- Failure scenario: if the endpoint rejects or truncates very large multipart bodies, users get a 4xx or 5xx after uploading hundreds of MB. The new test only proves the local framing against a drain server, not that the server accepts it. The PR shows no live evidence above about 20 MB.
- Fix: either attach a redacted live smoke run (for example 300 MB+ with a real key, behind an env opt-in), or switch to resumable. A resumable `start` call is small JSON (`X-Goog-Upload-Header-Content-Length: size`), then the `upload, finalize` PUT takes the bare file Blob. That removes the hand-built envelope and boundary entirely, and streaming plus `redirect: "error"` stay unchanged.

## Low Priority

### L1. A redirect or file-read failure surfaces as an opaque error
- `client.ts:133`. `redirect: "error"` rejects with `TypeError: fetch failed` (cause: unexpected redirect). If the file is modified or truncated mid-upload, the file-backed Blob fails with a `DOMException` (Node docs: "must not be modified after the Blob is created"). Neither is an `HttpError`, which is correct because they should not rotate keys. But the CLI prints only "fetch failed" or a terse DOMException.
- Fix (optional): wrap the `fetch` call and rethrow as `ProviderError("File upload failed: <cause>", "gemini")`, with `cause` preserved. Google's upload host does not redirect today, so this rarely fires.

### L2. The 256 MB test relies on vitest's default 5 s timeout
- `upload.test.ts:69` has no per-test timeout, and `vitest.config.ts` sets no `testTimeout`. 256 MB over loopback passed on all four CI legs, but a busy windows-latest runner can come close to 5 s.
- Fix: `it("...", async () => {...}, 30_000)`. Optionally move the `startDrainServer()` call (line 78) inside the `try`, so a setup failure between lines 78 and 95 cannot leak the listening server.

### L3. The 429 test does not exercise rotation
- The test asserts only that `HttpError.status === 429` with a single key. Rotation still works: `isGeminiRateLimitError` (`key-pool.ts:53-58`) keys on `HttpError`, and the outer `withGeminiKey` in each command re-runs the whole `fn` with the next key. A retry re-opens the Blob and streams again, with no buffering. Verified by reading the code, not by a test. Acceptable; adding a two-key case would cost little.

### L4. Worker-reusability rule (AGENTS.md): no regression, but debt is deepened
- `client.ts` already imported `node:fs` and `node:path` before this PR. The PR adds `fs.statSync` and `fs.openAsBlob` to the same function, so it adds no new module-level coupling. The cleaner design under the rule is for the command layer to stat and open the file and pass a `Blob` plus `displayName` into the client. A Worker could then pass its own `Blob`/`File`. Out of scope here; track it as a separate issue together with `inlinePart` and `shouldUseFileApi`.

### L5. Duplicated 2 GiB constant
- `FILES_API_MAX_BYTES = 2 * 1024 ** 3` (client.ts:73) duplicates `MAX_STDIN_BYTES` (`src/core/stdin-file.ts:22`). Both encode the same Files API ceiling and the docs present them together. Consider defining one from the other so they cannot drift.

### L6. Predictable multipart boundary (pre-existing)
- `multix_${Date.now()}` is unchanged. A file whose bytes contain `\r\n--multix_<ms>` would break the framing. This is practically impossible by accident. Using `crypto.randomUUID()` costs nothing, and the issue disappears if M2 switches to resumable.

## Node 20 compatibility (requested check)
- `fs.openAsBlob` was added in v19.8.0, so it is present in every Node 20 release (`engines: >=20`). The Node 20 docs mark it "Stability: 1 - Experimental", and v22.17.0 marked it stable.
- No runtime warning: the v20.x `lib/fs.js` `openAsBlob` does not call `emitExperimentalWarning`. CI on Node 20 (both OSes) passed.
- Types: `@types/node ^22.10.0` declares it, and typecheck passed in CI.

## Docs EN/VI
- EN: "Files over 20 MB are streamed from disk to the Gemini Files API, which accepts files up to 2 GB; a larger file is rejected before anything is uploaded." This matches `shouldUseFileApi` (> 20 MiB) and client.ts:86 (`>` 2 GiB).
- VI: the translation is faithful ("File lớn hơn 20 MB được stream từ ổ đĩa lên Gemini Files API, vốn nhận file tối đa 2 GB; file lớn hơn sẽ bị từ chối trước khi upload.").
- Caveat: "accepts up to 2 GB" is accurate for the API, but see M1. The CLI's default timeout makes multi-GB uploads fail on typical connections. README and `skill/SKILL.md` do not mention the 2 GB Files API limit (README:153 covers only stdin), which is optional.

## Edge cases checked
- Missing file: `statSync` now throws ENOENT before key selection. Callers pin `apiKey` inside their own `withGeminiKey`, so the error is reported per file as before.
- Piped stdin (`-`): it is already capped at 2 GiB in `stdin-file.ts`, so the new check never fires for it.
- Exactly 2 GiB is allowed (`>`), which matches the stdin cap semantics.
- Memory test: `arrayBuffers` sampling every 1 ms with no forced GC. A missed peak can only make the test pass more easily, not fail. A tee regression would push growth to about 256 MB and fail it. `redirect` is also asserted directly.
- Test cleanup: `afterEach` restores mocks and globals and removes the temp dir (`rmSync`, `force`). The server and interval are released in `finally` (lines 98-100).

## Recommended Actions
1. M1: make the upload timeout size-aware, or open a follow-up issue and soften the docs.
2. M2: attach live evidence for a large multipart upload, or switch to the resumable protocol.
3. L2: add an explicit timeout to the 256 MB test.
4. L1, L3 to L6: optional, or file as follow-up issues per AGENTS.md.

## Metrics
- Type coverage: no new `any`; the existing `biome-ignore` for the response JSON is unchanged.
- Tests: 3 new (streaming/memory, >2 GB rejection, 429 → HttpError). All CI legs green.
- Lint issues: 0 (CI lint passed).

## Unresolved Questions
- Has anyone uploaded a file of hundreds of MB through `X-Goog-Upload-Protocol: multipart` against the real endpoint?
- Is the "2 GB" limit 2 GiB or 2,000,000,000 bytes on Google's side? If decimal, files between those sizes pass the local check and get a server 400. That is harmless but inconsistent.

Status: DONE_WITH_CONCERNS
Summary: Mergeable. The streaming implementation and `redirect: "error"` are correct, and the memory test is a real behavioural check. Critical 0, High 0, Medium 2 (300 s timeout vs the advertised 2 GB; multipart at large sizes not verified live), Low 6.
