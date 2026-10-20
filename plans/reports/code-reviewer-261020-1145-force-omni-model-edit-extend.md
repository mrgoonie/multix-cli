# Code review: force Gemini Omni Flash for remote edit-video / extend-video (#267)

Commit: a12c43d `fix(worker): force Gemini Omni Flash for remote edit-video and extend-video`
Files: worker/src/jobs/cli-command-policy.ts (+2), worker/test/run-argv-builder.test.ts (+11)

## Verdict
Correct and minimal. No blocking issues. Worker suite: 21 files / 372 tests pass; worker test typecheck clean.

## 1. Correctness
- `forced: OMNI_MODEL` on both entries. In `prepareRun` (run-argv-builder.ts ~135-139) a caller value that is not exactly `gemini-omni-1.1-flash` throws `--model must be gemini-omni-1.1-flash on this server`; an identical value is skipped. After the option loop, every forced entry is written (`values.set(name, [forced])`), so `--model=gemini-omni-1.1-flash` is always in argv, including when the caller leaves it out.
- The new tests check both: the parsed argv has `opts.model === "gemini-omni-1.1-flash"` for edit and extend when no model is given, and `gemini-omni-2-pro` is rejected for both commands. The rejection cases also send `interaction-id`, so they fail at the model check, not at a missing source.
- The forced value goes into the catalog view (`catalog-view.ts:55`, `view.forced`), so `multix_catalog` now shows callers the forced model for these commands too.

## 2. Regressions / parent-interaction model
- The CLI never compares the follow-up model with the parent's. `edit-video.ts` uses `opts.model ?? GEMINI_OMNI_MODEL_DEFAULT` (no env override). `runOmniVideo` (omni-flow.ts) uses the parent interaction only to find the owning key and to check `status === "completed"`. `buildOmniRequest` (omni.ts) sends `model` and `previous_interaction_id` independently. Nothing in the repo requires the models to match.
- Google's Omni docs (ai.google.dev/gemini-api/docs/omni) name only `gemini-omni-1.1-flash` and use it on every turn. They don't say whether a chain may switch models, and they don't mention `gemini-omni-flash-preview`. I did not verify cross-model continuation.
- Affected population is tiny and short-lived:
  - The remote runner already forced Flash for generate-video and image-to-video, so no remote job could create a preview-model interaction.
  - Only a chain created locally with `--model gemini-omni-flash-preview` (under the same user key) could be affected.
  - `gemini-omni-flash-preview` shuts down 2026-10-22 (docs-site commands/gemini.md:132, skill/SKILL.md:341), two days after this change. Any such interaction is unusable on the preview model after that anyway.
- Net: forcing Flash is consistent with the documented contract. Worst case, Google rejects a cross-model follow-up and the user sees that error. The command stays available locally with `--model`. Not a blocker.
- Minor, pre-existing, not introduced here: the forced check compares the raw value exactly, so `models/gemini-omni-1.1-flash` is rejected even though the CLI strips the `models/` prefix. This was already true for generate-video and image-to-video. It's cosmetic.

## 3. Docs
No change needed. docs-site/src/content/docs/guides/mcp-server.md:115 ("the Gemini video commands always use Gemini Omni Flash") and vi/guides/mcp-server.md:113 already describe this behaviour; the commit makes the code match them. The "Gemini edit and extend" paragraph covers duration caps only and does not mention the model, which is fine.

## 4. Catalog
No regeneration needed. `worker/src/cli-catalog.json` is generated from the CLI's commander definitions (`npm run catalog`), and the CLI was not changed. `forced` is a runtime overlay that `catalog-view.ts` reads from the policy. `test/cli-catalog.test.ts:31` checks that every policy option (forced keys included) exists on the catalog command. `--model` exists for both commands, and the test passes.

## Low / optional
- `test/job-tools.test.ts:174` checks `forced` in the catalog view only for the OpenAI driver. A one-line check that `gemini edit-video` shows `forced: "gemini-omni-1.1-flash"` would cover the catalog view for this change too. It's optional, since the view code is generic.
- Commit type `fix(worker)` will cut an npm patch release even though only the unpublished worker changed. This matches repo precedent (0725be1, #246), so no action.

## Checklist
Concurrency n/a; error path is a ValidationError, same as the existing forced options; no API contract change other than a narrower set of accepted remote values (intended); no auth/data exposure; no queries.

Status: DONE
Summary: Forced model reaches argv and other models are rejected for both commands; tests pass (372/372). Docs already match; catalog needs no regeneration.
Concerns/Blockers: Cross-model continuation (a gemini-omni-flash-preview parent continued with 1.1-flash) is unverified against the live API, but the impact is negligible: the remote runner could never create preview interactions and the preview model shuts down 2026-10-22.
