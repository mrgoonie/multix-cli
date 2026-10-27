# Native Fish Audio provider (issue #357)

Status: P0 shipped on `dev` (c955217, 6a96c42); P1 implemented in PR #360, in review

## Outcome

- P0, already on `dev`:
  - `multix fish tts` with the allowlisted exact `model` header (drama-3 default).
  - UTF-8 byte pricing with `--estimate` / `--max-cost`.
  - `speech generate --provider fish`.
  - OpenRouter `fish-audio/*` priced per byte with `input_utf8_bytes`.
  - `fish voices list|get`.
- P1, this change:
  - `fish voice-design`:
    - `POST /v1/voice-design` with header `model: voice-design-1`.
    - Returns 1-4 WAV candidates, checked and saved.
    - Priced at a proven $0.01 per successful request (new `requests` price
      meter); the receipt counts `request.count`.
  - `fish clone`:
    - multipart `POST /model`, `type=tts`, `train_mode=fast`.
    - Private by default; `--consent` required.
    - Extension and size caps; samples streamed from disk.
  - `fish voices delete`: requires `--yes`.
  - `postFishOnce`: the shared send-once POST used by tts, voice design and
    clone. A gateway 5xx or 408 without a Fish error body is
    `UNKNOWN_REMOTE_STATE`.

## Constraints and non-goals

- A paid or creating POST is sent once and never retried.
- No cross-provider fallback and no default-provider change.
- No Vietnamese phoneme claim.
- Keys and prompts are never logged.
- Provider clients stay runtime-neutral (`npm run check:mcp`).
- Live probe not run: no `FISH_API_KEY`, and paid calls need cost approval.
  Tests are offline mocks.

## Files

| Area | Files |
|---|---|
| Clients | `src/providers/fish/{tts-client,voices-client,voice-design-client}.ts` |
| Commands | `src/providers/fish/commands/{index,voice-design,clone,voices}.ts` |
| Budget | `src/budget/{pricing-catalog,cost-estimate,cost-receipt,command-cost}.ts` |
| Capabilities / MCP | `src/capabilities/command-capabilities.ts`, `worker/src/jobs/cli-command-policy.ts`, `worker/src/cli-catalog.json` |
| Tests | `tests/unit/providers/fish/{voice-clients,voice-commands}.test.ts`, `tests/unit/budget/fish-voice-design-cost.test.ts` |
| Docs | `README.md`, `skill/SKILL.md`, `docs-site` EN + VI (`commands/fish.md`, `reference/for-ai-agents.md`) |

## Acceptance

- Each POST is sent once.
- Errors before sending send nothing.
- The voice-design `--max-cost 0.005` check refuses with `BUDGET_EXCEEDED`.
- `--estimate` shows $0.01 proven.
- `lint`, `typecheck`, `build`, `test`, `check:mcp` and `verify:docs` pass.
