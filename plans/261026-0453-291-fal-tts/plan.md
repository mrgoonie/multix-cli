# Issue #291 — fal TTS with typed inputs and verified outputs

Status: in progress · Branch `claude/gracious-heisenberg-fm8nzl` · PR target `main`
(the repo's `dev` branch is an unrelated beta history with no common ancestor).

## Live evidence (2026-10-26, api.fal.ai/v1/models + queue.fal.run)

| Endpoint | Text field | Voice | Style | Format | Output |
|---|---|---|---|---|---|
| `google/gemini-3.8-flash-tts` | `prompt` (required unless `turns`) | enum of 30, default Kore | `style_instructions` | none (WAV) | `audio` File |
| `google/gemini-3.8-flash-lite-tts` | same | same | same | none (WAV) | `audio` File |
| `elevenlabs/tts/eleven-v4` | `text` (required, 1-5000 chars) | free string, default Rachel | none (audio tags) | `output_format` enum | `audio` File |
| `elevenlabs/tts/eleven-v4-turbo` | same | same | none | same | `audio` File |

- Fish Drama 3: no fal endpoint (catalog search "fish", "drama"): not added.
- A Gemini submit without `prompt` is queued (billed path) and fails only at
  result time (HTTP 422), so local validation matters.
- `pcm_*` output comes back as `application/octet-stream`, file name `output.pcm`.

## Scope

1. `fal tts [text]` over `submitFalRequest`/`waitForFalResult` + receipts
   (`--detach`, `--receipt`); no new queue client.
2. Typed profiles for the four endpoints; any other id runs untyped
   (`--text-field`, `--input` for extras).
3. `--text-file`; validation of voice/format/style/language per profile.
4. Downloads pick the extension from magic bytes, then the result's
   `content_type`/`file_name`, the URL, the response header. `fal tts`
   refuses empty or non-audio bytes.
5. `fal models` (live catalog); `multix models` rows gain `inputs`,
   `output`, and `--detach` counts as async.
6. Worker policy + regenerated CLI catalog; docs EN/VI, README, skill.

## Acceptance

- Contract tests: two schemas, blank/bad audio, extensionless URLs,
  MIME/name mismatch, generic fallback, no retry on ambiguous submit.
- lint, typecheck, build, test, check:mcp green; one opt-in live smoke.
