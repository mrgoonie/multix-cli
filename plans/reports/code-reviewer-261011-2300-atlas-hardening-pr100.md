# Code review: PR #100 `fix/atlascloud-hardening` (closes #78)

Reviewed head `b8c49f5` (local worktree `agent-a88c29858411637c7` is at the same SHA). Bash was dead in this session, so nothing was run locally. CI on `b8c49f5` passed: Node 20 and 22 on ubuntu and windows, plus the docs site.

## Scope

- Files: `src/core/url-safety.ts`, `src/providers/atlascloud/{prediction-output.ts, commands/prediction-runner.ts, commands/env.ts}`, `src/providers/heygen/request-builders.ts`, 2 test files, README, `.env.example`, SKILL, and the docs (EN/VI command and environment pages).
- LOC: about +385/-65.
- Issue #78 asks for three things: an https-only download policy with a size cap, thumbnails taken from outputs only, and no filename collisions. All three are implemented and each has a stubbed-fetch test.

## Verdict

Approve with follow-ups. No Critical or High findings. Every Atlas fetch of a provider-supplied URL now goes through the validator.

## Download-path coverage (the main question)

| Path | Validated? | Evidence |
|---|---|---|
| Media outputs (`run`/`image`/`video`/`audio`/`3d`) | Yes, on every hop | `prediction-runner.ts:302-313` calls `downloadToFile` with `validateUrl: checkOutputUrl`. Redirects use `redirect:"manual"` and each hop is re-validated (`http-client.ts:108-137`). |
| `status --download` / the "Retry with" hint | Yes | `status.ts:57` goes through the same `deliverPrediction`. |
| Thumbnails | Yes | `prediction-runner.ts:345-350`: the source is only `thumbnailSource()` (outputs), and the downloader is injected with `checkOutputUrl` and `maxBytes`. |
| `data:` outputs | Not network-fetched, but capped | The validator is skipped only when `/^data:/i` matches after trim. The URL parser strips the same whitespace, so the bypass cannot reach another scheme. A redirect to `data:`/`file:` from an https hop is refused. The streamed byte cap applies. |
| Text outputs | No fetch | Printed, or written with `writeFileSync`. |
| `--no-download` | No fetch | Prints raw URLs. The docs warn they are secrets. |
| HTTP retries | None | `downloadToFile` does not retry, so there is nothing to bypass. |

Within one process the downloads run one after another (`await` inside the `for` loop), so outputs of the same run cannot race each other.

## Critical
None.

## High
None.

## Medium

**M1. A retry or resume is no longer idempotent: it duplicates outputs that were already saved, and one docs sentence is now partly wrong.**
- Code: `prediction-runner.ts:291,308` (generated names always go through `availableOutputPath`), and the retry hints at `:325` and `:358`.
- Scenario: a prediction has 4 outputs and #3 fails. The CLI prints `Retry with: multix atlas status <id> --wait --download`. On retry, all 4 are downloaded again. Outputs 01, 02 and 04 land as `atlas-xxxx-01-1.*` and so on, and #3 lands as `atlas-xxxx-03.*`. Each further retry adds another `-2` set: up to 2 GB per file of wasted bandwidth and disk, and a folder that is hard to read. Before this PR, a retry overwrote the same names.
- Docs: `docs/commands/atlascloud.md:155-157` (and VI `:155-156`) says "a resumed job gets the same `.mp4` or `.png` name as a waited one". That stays true for the extension but no longer for the name.
- Fix, either:
  - (a) Name files with the full sanitized prediction id. Issue #78 option 2 suggests a longer prefix. Then a name collision can only be the same prediction, and overwriting it is safe and idempotent. Keep `availableOutputPath` only as a safeguard, or drop it.
  - (b) Keep the suffix scheme, but in `status --download` skip any output whose planned name already exists, and say so.
  - Either way, fix the docs sentence. This was the author's design choice among the options in the issue, so it should be confirmed with the maintainer rather than changed silently.

## Low

**L1. The cross-process TOCTOU breaks the "never overwrites" claim.**
- Code: `prediction-runner.ts:375-391`, and `http-client.ts:168-181,235-244`.
- Scenario: the name is picked when the response headers arrive. The body then streams into `<dest>.part`, and `replaceFile` renames it over `dest`, deleting any existing file there. In-flight `.part` files do not reserve a stem: `atlas-x-01.mp4.part` has stem `atlas-x-01.mp4`. Two concurrent runs over the same id prefix (for example an agent running `status <id> --download` twice) both pick `-01`, and the second rename clobbers the first. Today the impact is negligible, because a same-prediction collision has identical bytes and 8 hex characters rarely collide. But the docs state "never" as an absolute.
- Fix: strip a trailing `.part` before computing stems. Better, reserve the name in the `dest` callback with `fs.openSync(name, "wx")`, retrying with the next suffix on `EEXIST`, and remove the placeholder on failure.

**L2. Stem matching is case-sensitive on case-insensitive filesystems (Windows, default macOS).**
- Code: `prediction-runner.ts:385-389`, where `Set` lookups are exact.
- Scenario: an existing `atlas-abcd1234-01.png` and a new id `ABCD1234…`. The stem is judged free, then `renameSync` replaces the existing file. This needs mixed-case ids. Atlas ids look like lowercase hex, so the risk is low.
- Fix: lowercase both sides when building and querying `stems`.

**L3. Thumbnail names are not covered by the no-overwrite rule.**
- Code: `video-thumb.ts:84-90`, called from `prediction-runner.ts:345`.
- Scenario: `<video-stem>_thumb.<ext>` is written directly. If an orphan `atlas-x-01_thumb.jpg` exists whose video was deleted, the new video takes `atlas-x-01` (its stem is free), and its thumbnail overwrites the old one.
- Fix: run the thumbnail dest through `availableOutputPath` when `generatedNames` is true, or document the exception.

**L4. Gaps in the data:/MIME extension mapping.**
- Code: `prediction-output.ts:127-145`.
- Scenario: `data:image/svg+xml`, `image/avif`, `image/bmp`, `audio/webm` and `video/x-matroska` all map to nothing. With the image hint, an SVG is saved as `.png` and then handed to the WebP finalizer. The categories `EXT_CATEGORY` knows about (`avif`, `bmp`, `mkv`) have no MIME entry.
- Also, older behaviour still in place: a URL extension is trusted as-is (`[a-z0-9]{2,5}`), so a hostile payload can drop `atlas-x-01.bat` or `.hta` into the output directory. Nothing executes it.
- Fix: add the missing MIME entries. Optionally, fall back to `bin` for extensions outside `EXT_CATEGORY`.

**L5. Test gaps.**
- `prediction-runner.test.ts:560`: the unsafe-thumbnail case uses `http://169.254…`, so it only proves the scheme check, not the private-IP check, for thumbnails.
- No test covers these:
  - an explicit existing `--output file.mp4` being overwritten on success (the stated contract);
  - an extensionless URL whose Content-Type-derived name collides (the `dest` callback path at `:304-308`);
  - `.part` or case collisions.
- The tests are otherwise solid. They are real assertions on `fetched`, the files on disk, and the warning text, with no phantom tests, and env and globals are restored in `afterEach`.

**L6. The agent-facing SKILL.md is missing the Atlas download policy.**
- Code: `skill/SKILL.md:160`.
- The Replicate section (`:183`) states the https-only and cap rules. The Atlas section does not mention the https-only and private-IP refusal, or the `-N` suffix on generated names. An agent that sees "Refusing to download from …" or `atlas-…-01-1.png` has no context. Add one sentence that mirrors README `:529`.

**L7. Commit hygiene.**
- The branch has a `wip(atlascloud): …` commit and two merge commits. Squash-merge it so release-please sees only the `fix(atlascloud): …` message.
- The commits carry a `Co-Authored-By: Claude` trailer. The user's global rule says commits must be "without AI references". The maintainer should decide whether to strip it on squash.

## Focus questions answered

- **Does HeyGen behave the same?** Yes. The moved `checkBaseUrl` body is character-identical to the base copy: same trim, `ConfigError` text, loopback set and `redactUrl` (compared with `agent-a032bd636cd513230/src/providers/heygen/request-builders.ts:78-100`). `request-builders.ts:77` re-exports it, so `heygen/node-helpers.ts:36` and `tests/unit/providers/heygen/request-builders.test.ts` resolve unchanged. `url-safety.ts` still imports only `errors.js` and `redact.js`, both worker-safe, and the neutrality test lists `url-safety.js` as allowed.
- **Is the validator duplicated (DRY)?** No. Atlas (`prediction-output.ts:82-84`) and Replicate (`replicate/output.ts:43-45`) are both one-line wrappers that call `checkUrlSafety` with their own options (Replicate adds `trustedHosts`). Nothing to merge.
  - Nit: Atlas passes the literal `"atlascloud"` instead of `ATLAS_PROVIDER` (`client.ts:45`).
  - `url-safety.ts` keeps two loopback notions: `LOOPBACK_BASE_HOSTS`, which is exact `localhost`/`127.0.0.1`/`[::1]` for base URLs, and the broader `isLoopbackHost`. This preserves HeyGen's stricter rule on purpose, so leave it.
- **Is the ATLASCLOUD_MAX_DOWNLOAD_MB removal a compatibility break?** No. It only existed in this branch's WIP commit `e77deba`, never on `main` or in a release (main's `.env.example` has no such key). No compatibility shim is needed.
- **Is the base URL validated?** Yes. `env.ts:41-42` trims, then calls `checkBaseUrl`. Tests cover https, `localhost`, `[::1]`, and the rejection of `http://mock.local`, `http://10.0.0.5` and a non-URL.
- **Can the API key follow a redirect on Atlas API calls?** Not fixed here; it is out of scope and tracked in #86. `AtlasCloudClient` (`client.ts:148`, `:157`) sends `Authorization: Bearer` with fetch's default redirect following. Per the Fetch spec, undici drops `Authorization` on a cross-origin redirect, so Atlas is less exposed than the `X-Api-Key` providers. #86 should still cover it, with a test (I did not verify this against the pinned Node version).

## Merge-order instructions

**With #97 (`fix/core-base-url-trust`).** #97 does not touch `url-safety.ts` or `request-builders.ts`. Expect textual conflicts in these files:
- `src/providers/atlascloud/commands/env.ts`: the import block and lines 41-43.
- `README.md`: the `ATLASCLOUD_BASE_URL` row at `:77`, and the `MULTIX_*` rows.
- `.env.example`.
- `docs-site/.../reference/environment.md` and `docs-site/.../vi/reference/environment.md`, around `:94-100`.
- `skill/SKILL.md`, the env table at `:389-404`.

Whichever PR merges second must leave `env.ts` as:
```ts
import { resolveBaseUrl, resolveKey } from "../../../core/env-loader.js";
import { checkBaseUrl } from "../../../core/url-safety.js";
import { DEFAULT_ATLAS_BASE_URL } from "../models.js";   // client.ts imports it from models.js, it is not re-exported there
...
const baseUrl = checkBaseUrl(
  resolveBaseUrl("ATLASCLOUD_BASE_URL", DEFAULT_ATLAS_BASE_URL),
  "ATLASCLOUD_BASE_URL",
);
return new AtlasCloudClient({ apiKey, baseUrl });
```
- Validate the resolved value, not the raw `resolveKey` value. Otherwise an ignored project-`.env` value would still throw `ConfigError`.
- HeyGen needs no change. #97's `heygen/node-helpers.ts` keeps importing `checkBaseUrl` from `./request-builders.js`, which still works through the re-export.
- In the docs, keep both statements: "project `.env` overrides are ignored unless opted in" from #97, and "https required, http only for localhost/127.0.0.1/[::1]" from this PR.
- Re-run `prediction-runner.test.ts:402-430`. Those tests set `process.env.ATLASCLOUD_BASE_URL`, which counts as shell-level, so #97 honours it, but it may now print a non-default-base warning.

**With #86 (an issue, `in progress`; there is no PR yet).** It will likely touch `src/core/http-client.ts` and the provider clients. This PR does not modify `http-client.ts` or `atlascloud/client.ts`, so a textual conflict is unlikely. Whoever lands second must:
1. keep the `downloadToFile(url, { dest: fn, maxBytes, validateUrl })` contract that `prediction-runner.ts:302` and `:349` depend on;
2. if the `UrlValidator` type moves or `fetchWithValidatedRedirects` changes signature, update both Atlas call sites;
3. include `AtlasCloudClient.request`/`uploadMedia` (Authorization header) in #86's keyed-redirect fix.

## Edge cases checked and not issues
- IPv4 shorthand and hex forms (`https://2130706433/`, `0x7f.1`) are normalized by the WHATWG parser and then caught.
- IPv6 that maps, NAT64-embeds or 6to4-embeds a private address is caught.
- A redirect to `data:`/`file:` is refused.
- When `MULTIX_MAX_DOWNLOAD_MB` is invalid, the run fails before any download (`:293`).
- A partial download never truncates an existing file (`.part` plus rename).
- DNS names that resolve to private IPs are not caught. This is documented, and https certificate checks limit the risk.

## Metrics
- Type coverage: no `any` added. Lint/typecheck: CI green (not run locally).
- Tests: about 160 added lines in the two test files, all using stubbed fetch with no paid calls.

## Unresolved questions
1. M1: does the maintainer want idempotent retries (full-id names) or the current suffix-on-collision behaviour? The issue offered both.
2. Do Atlas outputs ever come over `http://`? No real-world evidence either way. If they do, every such output now fails, with only `--no-download` as a workaround.

Status: DONE_WITH_CONCERNS
Summary: Approve with follow-ups. Every Atlas download path is validated per hop and capped, HeyGen is unchanged, and there is no DRY problem. Critical 0, High 0, Medium 1 (non-idempotent retry naming plus a stale docs line), Low 7.
