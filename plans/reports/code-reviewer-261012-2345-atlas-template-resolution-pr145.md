# Code review: PR #145, check Atlas template presets that name a resolution (closes #143)

- Head: `e8511d3` on `fix/mcp-atlas-template-resolution`. One commit.
- Changed files: 4 (+69 / -10).
  - `worker/src/providers/atlascloud-video-policy.ts`
  - `worker/test/mcp-tools.test.ts`
  - `docs-site/src/content/docs/guides/mcp-server.md`
  - `docs-site/src/content/docs/vi/guides/mcp-server.md`
- Scope: no unrelated files. No drift from the issue.
- CI at `e8511d3`: all 6 check runs passed. That covers the 4 Node/OS CI jobs, the documentation site job, and the MCP Worker job.
- Local runs: none. The Bash tool returned no output, so I could not run lint, typecheck or tests myself. The CI result above comes from the GitHub check-runs API.
- Live schema: I read `https://static.atlascloud.ai/model/schema/tencent-video-upscaler.json` on 2026-10-12. `template` is a flat `type: string`. Its enum has 24 values: `{live-action-enhance, anime-enhance, restore, live-action-smallface, anime-smallface, seedance2-enhance}-{720p,1080p,2k,4k}`. Its default is `anime-enhance-4k`. The schema has no `$ref`, `allOf`, `anyOf` or `oneOf` on the property. `video_url` is required, so the MCP tool still cannot reach this model, as #143 states.

## Scout findings

- `body.template` is never set by the caller. `generateVideo` (`worker/src/providers/atlascloud.ts:138-147`) maps only prompt, negative_prompt, aspect_ratio, resolution, seed and image_url. `lengthRequests` and `priceRequests` never emit `template`. So `effective()` always returns the schema default for this field. No caller-controlled string reaches the regex.
- `ID_RESOLUTION_RE` is used only at `atlascloud-video-policy.ts:514`, through `matchAll`. Nothing calls `.exec` or `.test` on it.
- Every one of the 24 live enum values tokenizes correctly. Each has exactly one trailing token (`720p`, `1080p`, `2k` or `4k`). `seedance2` is not a token, because the regex needs a separator before the digits.
- The upscaler also has an integer `short` input (0..2160). It is bounded per template tier through `x-depends-on`, so the template check covers it. `short` does not match `LENGTH_LIKE_RE`, and it is not a resolution field.

## Answers to the requested checks

**Correctness.** The change is correct for the only live schema. The check runs after the resolution fields and before the size checks. The error text names the source: `named in input "template"`. The refactor from the inline ID loop to `assertNamedResolutions(model, "its ID")` keeps the ID message byte-identical (`named in its ID`), and the existing kling tests at `mcp-tools.test.ts:1184-1186` still pin it.

**`effective()` failing closed.** This is acceptable. `effective()` (`atlascloud-video-policy.ts:447-468`) throws only when:
- `template` is declared,
- it is not sent,
- `unwrap()` cannot read it (`$ref`, `allOf`, or a multi-member union), and
- it has no usable outer default.

No live schema has that shape. The only declaring model has a flat string schema. The resulting message, `input "template" has a schema this server cannot check; use another model`, is accurate, and it matches the module's stated rule: "Shapes this code cannot interpret fail closed". In practice the cost is one model that is already unreachable. The path is untested, though (see M1).

**Global regex with `matchAll` on two strings.** This is safe. `String.prototype.matchAll` requires the `g` flag, and it has it, so it does not throw. Each call clones the regex through `SpeciesConstructor` and copies `lastIndex` into the clone. The shared `ID_RESOLUTION_RE.lastIndex` is never advanced, so the two calls do not interact. A throw in the middle of iteration only abandons the clone. One latent hazard remains: the clone *starts* at the original's `lastIndex`. If anyone later calls `ID_RESOLUTION_RE.test(...)` or `.exec(...)` on this module-level regex, the next `matchAll` would silently skip the start of the string (see L3).

**False positives.** They only cause rejections, never spend, so they are safe for a spend guard.
- `\d{1,2}k` reads `gold-24k` or `style-10k` as resolutions `24k` and `10k`.
- `\d{3,4}p` reads `film-100p` as `100p`.
- A hypothetical `downscale-4k-to-1080p` is rejected on `4k`, even though it outputs 1080p.

No live template triggers any of these.

**Every rejection test asserts no POST.** Yes. The single new rejection test asserts `calls.some((c) => c.method === "POST")` is false (`mcp-tools.test.ts:1212`). It also asserts the key is not leaked (`mcp-tools.test.ts:1211`). The accept cases assert the exact submitted body (`mcp-tools.test.ts:1233`).

**Docs, EN and VI.** The two languages match. Both are accurate for the live case. Two small imprecisions are listed in L1 and L2.

## Critical

None.

## High

None.

## Medium

**M1. The fail-closed and non-default paths for `template` are untested, and the real 24-value schema is not pinned as a fixture.**
- Where: `worker/test/mcp-tools.test.ts:1192-1235`. The behavior lives at `atlascloud-video-policy.ts:524-527` and `:447-468`.
- What is tested: one synthetic enum, with only the default varied.
- Missing tests:
  1. A `template` with `$ref` or `allOf` and no outer default. It should reject with "cannot check", and no POST should be sent.
  2. A `template` with `anyOf: [{type:string}, {type:null}]` and default `x-4k`. This proves the unwrap path.
  3. The real `tencent/video/upscaler` schema from `worker/test/fixtures/atlas-video-schemas.ts`, which the kling and PixVerse tests already use.
- Failure scenario: a later refactor changes `effective(...)` to `spec.properties.template?.default`, or wraps the call in a try/catch so that an unreadable schema means "skip". All current tests still pass, and a `$ref`-shaped 4k template would reach the POST.
- Fix: add the three cases above. Each should assert no POST.

## Low

**L1. A non-string effective `template` passes silently, which contradicts the docs' "a value that cannot be read is rejected".**
- Where: `atlascloud-video-policy.ts:525`, the check `if (typeof template === "string")`. The doc text is at EN `guides/mcp-server.md:213-215` and VI `vi/guides/mcp-server.md:216-218`.
- Failure scenario: a schema declares `template: { type: "object", default: { name: "enhance-4k" } }`, or an array default `["enhance-4k"]`. `effective()` returns it, the type guard skips it, and the request is sent at 4k.
- Impact: no live schema has this shape, so the impact is low.
- Fix: reject when `template !== undefined && template !== "" && typeof template !== "string"`. That is consistent with how unparseable `size` values are treated at `:540-541`.

**L2. A `template` with an enum but no default is not checked.**
- Where: `atlascloud-video-policy.ts:524-527`.
- Failure scenario: Atlas drops the `default` from the upscaler schema. `effective()` returns `undefined`, so the check is skipped. Tencent's own server-side default is then applied. That default is unknown and could be a 4k preset.
- Comparison: `qualityIsResolution` (`:425-439`) already looks at enum values for exactly this reason.
- Fix, either of:
  - Reject when the effective value is undefined and any enum value names a disallowed resolution.
  - Pin the template to an allowed enum value in the body. This matches the "send it explicitly" approach used for length (header comment, `:4-7`).

**L3. The shared module-level global regex is a latent `lastIndex` trap.**
- Where: `atlascloud-video-policy.ts:69`, used at `:514`.
- Failure scenario: someone adds `if (ID_RESOLUTION_RE.test(model))` as a pre-check. `.test` on a `g` regex sets `lastIndex` past the match. The next `matchAll` clone starts there, so a template such as `restore-4k` scanned after a match in the ID could skip the token.
- Fix, either of:
  - Drop `g` and use a local `new RegExp(ID_RESOLUTION_RE.source, "gi")` inside the helper.
  - Add a one-line comment that the regex must be used only through `matchAll`.

**L4. The module header was not updated.**
- Where: `atlascloud-video-policy.ts:7-8`.
- Problem: the header still says resolution "is checked on every field that names it and against a resolution named in the model ID". It does not mention template presets. The inline comment at `:509-512` does mention them.
- Fix: add "or in a `template` preset".

**L5. The template default is checked but not sent.**
- Where: `atlascloud-video-policy.ts:524`. Compare the accept test at `mcp-tools.test.ts:1233`, where the body has no `template`.
- Failure scenario: the Worker validates a cached schema whose default is `...-1080p`. Atlas then changes the default to `...-4k`, and the API fills in 4k.
- Impact: this is the same pre-existing gap as for the `resolution` field defaults, so it is not a regression in this PR. It is noted because L2's "pin it" fix would close both.

## Edge cases checked

- Uppercase tokens such as `ENHANCE-4K` are lower-cased before the allowlist lookup.
- `2k` and `1440p` are separate allowlist entries, as the docs state.
- A dotted token such as `enhance-4k.v2` is not matched. The lookahead needs `$` or one of `/_-`, so this is a false negative. No live value has a dot.
- Space-separated tokens such as `enhance 4k` are not matched (false negative). No live value has spaces.
- `seedance2-enhance-720p` yields only `720p`.

## Recommended actions

1. M1: add tests for an unreadable `template` schema, a nullable union, and the real fixture. Each should assert no POST.
2. L1 and L2: fail closed on a non-string `template`, or on an enum-only `template` with no default. Alternatively, pin the template to an allowed value.
3. L3 and L4: make the regex local or add a usage comment, and update the module header.

## Unresolved questions

- Should the Worker *send* the validated `template` value, as it does for length fields, rather than trust the API to apply the same default? This is a design choice that also affects `resolution` defaults.

## Verdict

**Approve with follow-ups.** The fix is correct for the only live schema, and the change fails closed on unreadable schema shapes. The regex use is safe as written. The rejection test asserts no POST. EN and VI docs agree. None of the findings blocks the merge. M1 should be done in this PR or right after it. L1 and L2 are hardening that can be tracked in a new issue.
