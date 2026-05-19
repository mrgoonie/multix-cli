# Researcher 02: Codex CLI Image Driver

## Scope

Assess feasibility of using authenticated Codex CLI subscription access as a programmatic image generation fallback for `multix openai`.

## Local Evidence

- `which codex` resolved to `/Users/duynguyen/.nvm/versions/node/v22.20.0/bin/codex`.
- `codex login status` returned `Logged in using ChatGPT`.
- `codex exec --help` supports:
  - non-interactive prompt
  - `--image <FILE>` repeated
  - `--cd <DIR>`
  - `--ephemeral`
  - `--output-last-message <FILE>`
  - `--json`

## Feasibility

Feasible as an experimental driver. It should not be treated as an official API because Codex is an agent runtime and its generated artifact contract is prompt-shaped, not endpoint-shaped.

## Recommended Contract

- Driver values: `api`, `codex`, `auto`.
- Default: `auto`.
- Selection:
  - API first if `OPENAI_API_KEY` exists.
  - Codex fallback only for image commands if Codex is authenticated.
  - Audio commands never use Codex.
- Auth detection:
  - run `codex login status`
  - parse success text only
  - never read auth files
- Runtime:
  - temp workspace
  - `codex exec --ephemeral --cd <tmp> --output-schema <schema> --output-last-message <json>`
  - `--image` for refs
  - explicit output path
  - validate file exists and byte size > 0
  - sanitized env, not full `process.env`
- Capability gate:
  - run one manual image-generation spike before implementing full driver
  - if Codex cannot create an image file non-interactively, keep driver disabled with a clear unsupported error

## Risks

- Codex CLI behavior can change. Mitigation: driver is experimental, tests use injectable runner, docs warn.
- Codex may not actually create file despite final message. Mitigation: trust filesystem validation only.
- Potential repo edits. Mitigation: run in temp dir and prompt "do not modify repository".
- Subscription usage semantics can change. Mitigation: do not promise free/unlimited output.

## Unresolved Questions

None. User explicitly requested Codex programmatic image path when authenticated.
