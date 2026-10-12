# Code review: PR #101 fix(core): never forward API key headers on cross-origin redirects

- Branch `fix/core-keyed-redirects`, head `6a6f2c8a` (one commit on `c5410181`), closes #86
- Reviewed in worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-a2b90c6fbce2704dd`. The local branch ref matches the PR head.
- Bash was unavailable in this session, so nothing ran locally. Evidence is the source, the PR diff (GitHub API), and CI. All 5 check runs on `6a6f2c8a` pass: Node 20/22 on ubuntu and windows, plus the docs site.

## Scope
- 20 files, +533 / -175. Core: `src/core/redirect-fetch.ts` (new), `fetch-json.ts`, `http-client.ts`. Providers: atlascloud, cloudflare, elevenlabs (client, dub), gemini (client, veo), heygen (client, node-helpers), openai, openrouter video-status, replicate. Also EN/VI env docs and 3 test files.
- Issue #86 acceptance: covers the core helper and keyed provider clients, and adds tests that mock a 3xx to another origin. **Met.**

## Overall assessment
The core design is sound. `fetchFollowingRedirects` follows each hop by hand and compares origins with WHATWG `URL.origin`. Requests that carry a key now go through it on every path I could find in `src/`.

No defect in this PR leaks a key. The main risks are:
- merge order with #91, which would reintroduce the #86 bug for the Cloudflare video token;
- one over-broad behaviour change in `fetchJson`;
- one leak of the same class that this PR leaves out of scope (fal).

## Completeness audit: every credential path in `src/`

| Path | Header | Transport after PR | Verdict |
|---|---|---|---|
| Gemini generateContent, interactions (TTS), listModels, Files poll (`gemini/client.ts:138,162,183,265`) | x-goog-api-key | `httpJson` → `fetchJson`, cross-origin redirect is an error | covered |
| Gemini check ping (`commands/check-helpers/gemini-ping.ts:23`) | x-goog-api-key | `httpJson` | covered (not touched, inherits the fix) |
| Gemini Files upload (`gemini/client.ts:111`) | x-goog-api-key | `fetchSameOrigin`, Buffer body (can be re-sent) | covered |
| Veo submit/poll (`veo.ts:112,136`) | x-goog-api-key | `httpJson` | covered |
| Veo download (`veo.ts:165-174`) | x-goog-api-key | key only for `https:` plus the exact API host; `downloadFile` drops headers on an origin change | covered |
| Gemini generated-file download (`gemini/client.ts:290`) | none | — | n/a |
| ElevenLabs JSON (`elevenlabs/client.ts:44,58`) | xi-api-key | `httpJson` | covered |
| ElevenLabs DELETE, binary, multipart (`:70,115,141`) | xi-api-key | `fetchSameOrigin`; FormData can be re-sent | covered |
| ElevenLabs dub download (`commands/dub.ts:138`) | xi-api-key | `fetchWithValidatedRedirects` drops headers on an origin change | covered |
| OpenAI JSON, form, binary (`openai/client.ts:35,53,78`) | Authorization | `httpJson` / `fetchSameOrigin` | covered |
| OpenRouter chat, image, video submit/poll/models (`openrouter/client.ts:108`, `image-to-image.ts:151`, `video-client.ts:56,69,82`) | Authorization | `httpJson` | covered |
| OpenRouter video download (`commands/video-status.ts:39`) | Authorization | drops headers on an origin change | covered |
| fal queue submit/status/result (`fal/client.ts:61`) | Authorization: Key | `httpJson` | redirects covered, **but see M2** |
| Leonardo, BytePlus, MiniMax JSON | Authorization | `httpJson` | covered |
| Cloudflare AI run, gateway, video predictions (`cloudflare/client.ts:64,87,142,152`) | Authorization, **cf-aig-authorization** (custom header, not stripped by fetch) | `fetchSameOrigin` | covered **on this branch only; see H1** |
| Replicate JSON + Files upload (`replicate/client.ts:223,341`) | Authorization | `fetchJson` / `fetchSameOrigin` with injected fetch | covered |
| HeyGen JSON + asset upload (`heygen/client.ts:187,422`) | X-Api-Key | `fetchJson` / `fetchSameOrigin` | covered |
| Atlas JSON + upload (`atlascloud/client.ts:168,187,245`) | Authorization | `fetchJson` / `fetchSameOrigin` | covered |
| Unkeyed downloads (fal, Leonardo, BytePlus, MiniMax, Atlas, Cloudflare video, gemini i2i `fetch(url)`, `fetchBytes`) | none | unchanged | n/a |

**Keys in query strings.** I grepped for `?key=`, `key=`, `api_key`, `token=` and `searchParams.set("key"`. Nothing in `src/` puts a credential in a URL. The only hit is a comment at `gemini/client.ts:5`. A redirect therefore never carries a key inside the URL.

**Streaming responses / SSE.** No `text/event-stream`, `stream: true` request or `getReader()` consumer exists on a keyed path. Binary responses (TTS, Cloudflare audio) are buffered and go through `fetchSameOrigin`.

**Request bodies on 307/308.** Every keyed caller passes a string, Buffer, FormData or Blob. All of these can be sent again on the next hop. No keyed caller passes a `ReadableStream` or Node stream (I grepped for `duplex` and `createReadStream`). If a future caller does, a same-origin 307 makes undici throw a TypeError; `fetch`'s own `follow` mode also fails in that case, so this is not a regression. #85 introduces a file-backed Blob, which can also be re-sent, and uses `redirect: "error"` anyway.

## Origin comparison and redirect semantics (`src/core/redirect-fetch.ts`)
- `next.origin !== new URL(current).origin` (line 107) behaves as follows:
  - **Default ports** are dropped (`:443`/`:80`), so they compare equal.
  - **Host case** is lowercased.
  - **IDN hosts** are punycoded, so they compare equal.
  - **A host with a trailing dot** counts as a different origin. This fails safe: the redirect is stopped or the headers are dropped.
  - **Scheme is part of the origin**, so `https`→`http` on the same host is cross-origin. The tests cover this.
  - **Opaque `null` origins** (`data:`, `blob:`) never equal an http(s) origin.
  - **Protocol-relative `Location: //evil`** resolves through `new URL(location, current)` and is detected.
- The comparison is per hop, against the previous hop. In `drop-headers` mode, headers are cleared permanently at line 124. A storage host that redirects back to the API origin therefore does not get the key back. This is correct.
- Method and body changes follow the Fetch spec:
  - 303 turns a non-GET/HEAD request into a GET.
  - 301/302 turn POST into GET.
  - On those switches the body and body headers are dropped, but `Authorization` and custom headers are kept on the same origin.
  - 307/308 keep both method and body.
- A malformed `Location` is rejected after the body is cancelled. The `maxRedirects` check happens after the `stop` short-circuit, which is correct.
- Runtime behaviour of `redirect: "manual"`:
  - **Node (undici), Workers, Deno, Bun:** return the real 3xx with `Location`, so the loop works.
  - **Browsers:** return an `opaqueredirect` with status 0 and no `Location`, so the helper returns a status-0 response. Not a target runtime; see L5.
- Reliance on `response.url`: it is used only when `validateUrl` is set (line 89). In undici it equals the request URL, so a mismatch can only come from normalising an unnormalised hop-0 URL, and that causes a harmless extra validation. I saw no other code that depends on `response.url` changing.

## Critical
None.

## High

### H1: Merge-order hazard with #91 brings back the #86 leak for the Cloudflare gateway token
- #91 (`feat/mcp-worker`, head `b1bf753`) moves the Cloudflare video calls out of `src/providers/cloudflare/client.ts` into a new runtime-neutral `src/providers/cloudflare/video-client.ts`.
- On that branch, `send()` (`video-client.ts:67-75`) calls `f(url, withTimeout)` or `globalThis.fetch(url, withTimeout)` with the default `redirect: "follow"`.
- The headers include `"cf-aig-authorization": Bearer <CLOUDFLARE_API_TOKEN>` (`video-client.ts:60`). This is a custom header, which fetch does **not** strip on a cross-origin hop.
- #91 also rewrites `runCloudflareJson`/`runCloudflareBytes` (`readJson` → `readCloudflareJson`). #101 edits the same lines, so `cloudflare/client.ts` will produce a textual conflict.
- **Failure scenario:** the conflict in `client.ts` gets resolved, but the newly added `video-client.ts` never conflicts, so it ships raw fetch. A 30x from `gateway.ai.cloudflare.com` would then forward the Cloudflare API token, both from the CLI and from the Worker.
- **Fix (whichever PR merges second):**
  - Route `send()` through `fetchSameOrigin(url, withTimeout, f)`, imported from `../../core/redirect-fetch.js`. Pass the injected fetch as the third argument; it is called without a receiver, which keeps the Workers "Illegal invocation" fix.
  - In `client.ts`, keep `fetchSameOrigin` for `runCloudflareJson`/`runCloudflareBytes`.
  - Add a `video-client` case to `tests/unit/providers/keyed-redirects.test.ts`.
  - Make sure `worker/scripts/check-bundle.mjs` accepts `core/redirect-fetch.ts`. It has no `node:*` imports and only a type import from `url-safety.ts`.

## Medium

### M1: `fetchJson` refuses cross-origin redirects even when the request carries no credential
- **Where:** `src/core/fetch-json.ts:82-87`. `crossOrigin: "error"` applies to every call, including those without headers.
- **Affected unkeyed callers:**
  - `AtlasCloudClient.getModelSpec` (`atlascloud/client.ts:314`) fetches a third-party `entry.schema` URL from the public catalog.
  - `listModels` (`:283`).
  - `fetchRegistryVersion` (`src/commands/update.ts:42`).
- **Failure scenario:** the Atlas schema host (a CDN or GitHub raw URL) answers 302 to a storage origin. Before this PR the call worked; now it throws `HttpError(302)`. `prediction-runner.ts:114-119` catches it and silently downgrades to "sending without validation", which loses schema validation. `multix update` would fail outright behind a registry that redirects.
- **Fix:** refuse only when there is something to protect, for example `crossOrigin: Object.keys(opts.headers ?? {}).length ? "error" : "drop-headers"`. Add a test that a header-less `fetchJson` follows a cross-origin 302.

### M2: fal sends `Authorization: Key …` to API-supplied absolute URLs with no origin or scheme check, and the new docs overstate the guarantee
- **Where:**
  - `src/providers/fal/client.ts:58-71`: `requestAbsolute` attaches the key to any URL.
  - `src/providers/fal/run-helpers.ts:82,100`: passes `submitRes.status_url` / `response_url` from the submit response verbatim.
  - `docs-site/.../reference/environment.md:35`: says "Keys are sent only to the provider's own API origin".
- This is the same leak class as #86: a credential reaches an origin the server chose, possibly over `http://`. It is not a redirect, so #101's mechanism does not cover it.
- **Severity:** fal's API is trusted, so exploitation needs a compromised or misconfigured upstream. The documentation claim is incorrect as written, though.
- **Fix:** per AGENTS.md, open a separate issue rather than widening #101. In `requestAbsolute`, attach the key only when `new URL(url).origin === new URL(this.baseUrl).origin` (and https or loopback); otherwise throw. Until then, soften the docs sentence to "API requests that are redirected…".

## Low

### L1: Test gaps
`tests/unit/core/redirect-fetch.test.ts` and `tests/unit/providers/keyed-redirects.test.ts` do test real behaviour: they use fake fetches that follow redirects the way undici does unless `redirect: "manual"` is set. Missing cases:
- `maxRedirects` exhaustion;
- malformed `Location`;
- 301/302 POST→GET;
- a relative `Location` after a cross-origin hop;
- the Gemini Files upload;
- ElevenLabs dub download;
- OpenRouter video download;
- `fetchJson` providers (fal, Leonardo, BytePlus, MiniMax, OpenRouter, Gemini generateContent), which are covered only through the generic `fetchJson` test.

The HeyGen case (`keyed-redirects.test.ts:65`) asserts origins rather than using `leaked()`. That is acceptable, but inconsistent with the other cases.

### L2: HeyGen downloads lost their unique temp name
- The old `downloadOutput` used `${dest}.${pid}-${Date.now()}.part`. `downloadToFile` uses a fixed `${dest}.part` (`http-client.ts:173`).
- **Failure scenario:** two concurrent `multix heygen …` processes with the same `--output` write to one `.part` file and corrupt it.
- The consolidation onto a single helper is the right move; issue #86 comment 2 asked for it.
- **Fix (optional):** add a pid/time suffix inside `downloadToFile`, which benefits every caller.

### L3: Redirect-loop errors are reclassified as network errors by callers
- `fetchSameOrigin` throws `HttpError(3xx, "too many redirects")` on a same-origin loop. The catch blocks at `openai/client.ts:59`, `elevenlabs/client.ts:116,147`, `replicate/client.ts:351`, `atlascloud/client.ts:255` and `heygen/client.ts:432` rewrap it as `HttpError(0, …)`.
- HeyGen `uploadAsset` then retries the upload up to `maxAttempts`. The idempotency key keeps this bounded and safe, but the message is misleading.
- **Fix:** rethrow `HttpError` unchanged in those catches.

### L4: Unfollowed 3xx bodies are sometimes not drained
In Cloudflare `readJson`/`runCloudflareBytes` (`cloudflare/client.ts:42,97`), the code throws on `!ok` without cancelling the body, so the socket stays held until GC. This is the existing pattern for any non-2xx response and is minor.

### L5: `redirect: "manual"` in a browser runtime
It returns status 0, which polling loops treat as a transient network error. Not a supported runtime; documenting it next to the "runtime-neutral" claim at `redirect-fetch.ts:3` is enough.

## Conflicts with open PRs: what the second PR to merge must do

| PR | Overlap | Action for whichever merges second |
|---|---|---|
| **#85** perf/gemini-stream-upload (`8c7efbd`) | Both edit `src/providers/gemini/client.ts` upload. #85 rewrites it into `uploadFetch` with `redirect: "error"` (lines 152-187). #101 swaps `globalThis.fetch` → `fetchSameOrigin` at line 111 and adds an import. Textual conflict. | Keep #85's `uploadFetch` with `redirect: "error"`. It is stricter: no redirect is followed at all. The session URL from `x-goog-upload-url` never gets the key. It also keeps the "refused redirect → ProviderError, never retried" classification, which `fetchSameOrigin` would lose (it returns a 3xx, which becomes `HttpError(3xx)`). **Delete the `import { fetchSameOrigin }` line from `gemini/client.ts`**, or Biome's unused-import rule fails lint. If #101 rebases after #85, drop #101's gemini/client.ts hunk entirely. |
| **#100** fix/atlascloud-hardening (`b8c49f5`) | Both rewrite the `WORKER_SAFE_CORE` set in `tests/unit/providers/atlascloud/prediction-output.test.ts` (around line 117/148). Textual conflict. No `src/` conflict: #100 uses `downloadToFile(url, { validateUrl, maxBytes })`, whose API #101 keeps unchanged, and moves `checkBaseUrl` into `url-safety.ts`, which #101 does not edit. | Resolve the set as the union `["errors.js","fetch-json.js","async-poll.js","redact.js","redirect-fetch.js","url-safety.js"]`. Keep `redirect-fetch.ts`'s import of `UrlValidator` as `import type`, so the runtime graph does not pull in `url-safety.ts`. Do not add `url-safety.ts` to `worker-safe-http.test.ts` unless it stays free of `node:*` imports. |
| **#97** fix/core-base-url-trust (`7fa6a21`) | Both edit `src/providers/heygen/node-helpers.ts`. #97 touches the env-loader import (line 11) and `createHeygenClientFromEnv` (lines 53-60). #101 touches imports at lines 7-13 and the download helpers around line 200. | Probably auto-merges, with one unchanged line between the import edits. Confirm with `git merge-tree --write-tree origin/main fix/core-keyed-redirects fix/core-base-url-trust`. No semantic interaction: base-URL trust and redirect handling are independent. |
| **#91** feat/mcp-worker (`b1bf753`) | See **H1**: `cloudflare/client.ts` conflicts, and `video-client.ts` silently bypasses the fix. | Wrap `send()` with `fetchSameOrigin`, add a test, and check the bundle allow-list. |
| #96 | No overlap. A 3xx `HttpError` is not transient, so it is not retried. | None. |

## Positive observations (for risk calibration)
- One shared implementation that is runtime-neutral (no `node:*` imports). It is added to both worker-safe guard tests.
- Veo now also refuses to send the key to `http://` on the API host (`veo.ts:172`).
- The fake fetches in the tests reproduce undici's "follow, keeping custom headers" behaviour, so the tests would fail on the pre-fix code.

## Recommended actions
1. Coordinate H1 with #91 before either merges, and add the `video-client.ts` wrap to whichever lands second.
2. M1: use `crossOrigin: "error"` only when credential headers are present.
3. M2: open a new issue for the fal absolute-URL key leak and soften the docs sentence in this PR.
4. Follow the merge table for #85 and #100.
5. Optional: L1 tests, L2 unique `.part` name, L3 rethrow `HttpError`.

## Metrics
- Type checking, lint and tests: CI is green on 4 OS/Node jobs plus docs. Not re-run locally because Bash was unavailable.
- New tests: 23, across 2 new files and 2 edited.
- Lint issues: 0 per CI.

## Unresolved questions
- Does any Atlas catalog `schema` URL actually redirect cross-origin today? This decides whether M1 is a live regression or only a latent one.
- Will #91 land before or after #101? That decides who owns the H1 fix.

Status: DONE_WITH_CONCERNS
Summary: Approve after H1 is coordinated. Every keyed path in `src/` is covered and no key-leak defect remains in the diff. Critical 0, High 1 (merge hazard with #91), Medium 2, Low 5.
