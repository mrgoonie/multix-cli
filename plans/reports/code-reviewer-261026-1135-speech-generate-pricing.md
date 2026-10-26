# Code review: speech generate pre-flight pricing (commit 0bbd998, issue #344)

Scope: `git diff origin/dev...HEAD` — src/budget/command-cost.ts, src/agent/cost-preflight.ts,
tests/unit/budget/speech-generate-estimate.test.ts, tests/smoke/budget-guard.test.ts, README.md,
skill/SKILL.md, docs-site EN/VI for-ai-agents.md (~356 added lines).

Verification run: `npx vitest run tests/unit/budget` (56/56 pass), `npx biome check` on changed
files (clean), tsx probes of `estimateCommand("speech generate", ...)` and of `preflightCost()`
with `GEMINI_TTS_MODEL` set and a BOM-prefixed `--text-file`. Not run: full suite, build,
typecheck, `npm run check:mcp` (excluded by the task).

## Verdict

No Critical or High findings. I found no option combination where the estimator marks
a ceiling as proven, or admits a run under `--max-cost`, while pricing a route or text
that differs from what the command sends. One narrow exception is the text-file race
in M1. The checks below support this:

- Route resolution reuses `resolveTarget`/`parseRouteSpec`, so model-only inference,
  provider validation and voice-only fallbacks (`elevenlabs::id`) resolve the same as in
  `planSpeechRoutes`.
- Default models match. On the CLI, the Gemini default goes through
  `getDefaultModel("generate-speech")` (GEMINI_TTS_MODEL > TTS_MODEL > constant). Probe:
  with `GEMINI_TTS_MODEL=gemini-2.5-pro-preview-tts`, an elevenlabs+gemini plan is priced on
  gemini-2.5-pro at $0.001683. The ElevenLabs default is the same constant the adapter uses.
  The Worker uses the constant, and the job container runs with a clean env (only
  provider keys, `MULTIX_DISABLE_HOME_ENV=1`), so the defaults match there too.
- Text matches: both sides `.trim()` (the BOM is stripped too: probe counted 19 chars).
  When `--text` and `--text-file` are both given, the estimate prices `--text`, and
  `readText` rejects the run before anything is sent.
- When any route is unpriced (openai, minimax, atlas, `eleven_v3_conversational`, or an
  unverified or stale rate), the whole run is `unknown`. A plan is `proven` only when
  every route is proven. A mixed ElevenLabs+Gemini plan is `estimated`, so strict
  refuses it.
- `--style` goes into `extra_text` (the high end) on Gemini routes. It is sent only to
  the Interactions (3.8) models, and catalog `style` is false for the others, so the
  command rejects `--style` on routes that would ignore it. ElevenLabs
  `previous_text`/`next_text` count in the high end from either the commander record or
  MCP repeated strings. Key trimming and first-`=` splitting match `collectExtra`.
- MCP: `text-file` comes through `inputs` (not options), so the Worker estimate is
  `unknown`, which fails closed. Number or array `text` gives `unknown`. A blank
  `model`/`fallback` is priced on a default, but the CLI then rejects `--model=`
  (`""` is not nullish, so `buildRoute` fails) or `--fallback=` before sending.
- Billing happens at most once per run: the Gemini key pool rotates only on 429, and the
  ElevenLabs `apiPostBinary` does not retry.
- Worker bundle: the new imports (speech-request, speech-catalog, provider model
  tables, core/errors, core/env-default) contain no `node:*` imports. `envDefault` is
  only called inside functions the estimator never calls. `npm run check:mcp` still
  needs to confirm this.

## Critical

None.

## High

None.

## Medium

### M1. `--text-file` is read twice, so a "proven" ElevenLabs ceiling can be lower than what is billed

`runtimeDefaults` (src/agent/cost-preflight.ts, `textFileContent`) reads the file in the
`preAction` hook, and `readText` (src/commands/speech/index.ts) reads it again in the
action. If the file grows between the two reads (an agent or editor still writing it,
or a parallel job writing the same file), `checkBudget` passes with `upper_bound:
"proven"` on the old text, and ElevenLabs bills the new, longer text. This is the one
fail-open path I found. It needs a concurrent writer, but it breaks the "proven"
guarantee rather than an estimate.

Repro (manual):
1. `printf 'hi' > s.txt`
2. Run `multix speech generate --provider elevenlabs --text-file s.txt --max-cost 0.001`
   with a breakpoint or delay between `preflightCost()` and `readText`, and append
   50,000 characters to `s.txt` during that window. The budget check passes on 2
   characters; the request sends 50,002.

Fix: read the file once. Keep the text preflight read (for example
`run.speechText`, or a small cache keyed by path and returned by a shared reader)
and have `readText` use it when present. Alternatively, have `readText` compare a
hash or length against the priced text and throw `BudgetError` on a mismatch when
`run.maxCost` is set. The first option is simpler and also removes the duplicated
1 MiB limit constant.

### M2. No test covers the CLI default-model path, the one place a regression would underprice

The unit tests inject `speechModels` by hand, and the smoke tests cover only
ElevenLabs and an unpriced fallback. Nothing exercises `runtimeDefaults("speech
generate")` with `GEMINI_TTS_MODEL` or `TTS_MODEL` set. If `speechModels` is dropped
or misspelled there, the estimator falls back to `gemini-3.8-flash-lite-tts` (the
cheapest: $6/M output) while the run uses the env model (up to $20/M on
2.5-pro/3.1-preview). That passes `--max-cost` under `--cost-policy estimate` while
billing more than 3x.

Fix: add a smoke case,
`GEMINI_TTS_MODEL=gemini-2.5-pro-preview-tts multix speech generate --provider gemini --text … --estimate --json`,
asserting `estimate.model === "gemini-2.5-pro-preview-tts"`. Add a second case where the
env model appears only as a `--fallback gemini` route.

## Low

### L1. The default-model table is duplicated and can drift from the adapters

`SPEECH_DEFAULT_MODELS` in command-cost.ts repeats `SPEECH_ADAPTERS[p].defaultModel()`
(which can't be imported because it pulls in Node). Gemini also has two
`TTS_MODEL_DEFAULT` constants (src/providers/gemini/voices.ts:61 and
src/providers/gemini/models.ts:40). command-cost uses the voices.ts one and the
adapter uses the models.ts one. Both are `gemini-3.8-flash-lite-tts` today. If either
changes alone, the Worker estimate prices a different default than the container runs.
Fix: have models.ts re-export the voices.ts constant, and add a parity unit test with
env cleared:
`for p of ["gemini","elevenlabs"]: SPEECH_DEFAULT_MODELS[p] === SPEECH_ADAPTERS[p].defaultModel()`
(this needs `SPEECH_DEFAULT_MODELS` exported, or a test-only check through
`estimateCommand(...).model`).

### L2. `textFileContent` can throw a raw fs error from preflight

`existsSync` and `statSync` succeed, then `readFileSync` throws EACCES. Or the file
is deleted between `existsSync` and `statSync`, so ENOENT is thrown. In both cases
`preflightCost` throws, and a `--estimate` run exits 1 with an unclassified error
instead of returning `unknown`. Since `speech generate` is now in `pricedCommands()`,
every run goes through this path, even without cost flags. This does not fail open.
Fix: wrap the function body in `try { … } catch { return undefined; }`.

### L3. A fallback plan's `low_usd` and `expected_usd` come from the most expensive route, and the receipt variance mixes providers

For an ElevenLabs primary with a Gemini fallback where the Gemini high end is larger,
the estimate reports Gemini's low and expected values even though ElevenLabs normally
runs. `buildCostReceipt` then computes `variance_usd` as ElevenLabs' actual cost minus
Gemini's expected cost. The guard is unaffected because it uses only `high_usd`.
Fix: set `low_usd` to the minimum over all routes and `expected_usd` to the primary
route's value, or add an assumption telling receipt consumers that variance is not
comparable across routes.

### L4. Top-level unknowns show provider "speech" with an empty model

`unknownEstimate("speech generate", …, opt(o,"model") ?? "")` produces the
`checkBudget` message "cost of speech  is unknown" (with a double space). This is
cosmetic. Fix: use `opt(o,"provider") ?? "speech"`, and leave the model out of the
message when it is empty.

### L5. Docs wording

The EN and VI docs tables say "The chosen route's price". For a `--fallback` plan, the
price is the most expensive route, not the chosen one; the same cell clarifies this
later. Suggested wording: "The price of the route it runs (with `--fallback`: the most
expensive listed route)". The docs also say Gemini and ElevenLabs routes are priced,
but `eleven_v3_conversational` (which is in the speech catalog) has no direct
ElevenLabs price and stays `unknown`. That fails closed, but the exception is worth
one clause.

### L6. Estimate-only can report a price for a plan the command will reject

Duplicate routes, `--style` on an ElevenLabs fallback, text over `max_chars`, and
`--model=` over MCP are rejected by the command, but the estimator still prices them.
Nothing is billed. If cheap, run the route-validating part of `planSpeechRoutes`
inside the estimator (it is runtime-neutral) so `--estimate` returns `unknown` with
the same validation message.

## Recommended actions (priority order)

1. M1: read `--text-file` once and price the exact text the command sends.
2. M2: add a GEMINI_TTS_MODEL smoke test (primary route and fallback route).
3. L1: single Gemini TTS default constant, plus a parity test against the adapter defaults.
4. L2: try/catch in `textFileContent`.
5. Run `npm run check:mcp`: the Worker bundle now includes speech-request and speech-catalog.
6. L3 to L6 as follow-ups.

## Plan / issue status

Issue #344 requirements:
- `--provider`/`--model`/default mapped to catalog entries: done.
- `--fallback` priced at the most expensive route, or unknown when any route is unpriced: done.
- `--style` counted in the high end where it is billed: done.

M1 is the only gap against "--max-cost never admits a run it cannot bound".

## Unresolved questions

- Should `--estimate` validate the full route plan (L6), or stay price-only?
- Is the receipt variance expected to be meaningful for fallback plans (L3)?

## Resolution (author)

- **M1:** fixed. The cost preflight stores the `--text-file` text it priced in run state, and `speech generate` speaks that same text instead of reading the file a second time.
- **M2:** fixed. A smoke test sets `GEMINI_TTS_MODEL=gemini-2.5-pro-preview-tts` and checks that model is priced, both as the primary route and as a fallback.
- **L1:** fixed. `gemini/models.ts` re-exports the single `TTS_MODEL_DEFAULT` from `voices.ts`. A unit test checks that each priced provider's estimated default model equals its adapter's `defaultModel()`.
- **L2:** fixed. `textFileContent` catches file errors, so an unreadable file is left unpriced instead of throwing.
- **L3:** fixed. A fallback plan's low is the lowest of its routes, its expected is the primary route's, and its high is the most expensive route's.
- **L4:** fixed. An empty model is left out of the refusal text. The worker test regex now accepts the message without the double space.
- **L5:** fixed in the EN and VI docs ("each route's price", and `eleven_v3_conversational` is listed as unpriced).
- **L6:** not changed. The estimate covers a superset of runnable plans, and the command still rejects invalid plans before sending anything, so nothing is billed.
