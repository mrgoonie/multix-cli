---
title: For AI agents
description: A compact, reliable way for agents to discover multix capabilities and produce reproducible commands.
---

## Prefer Markdown routes

Every documentation route has the same path with `.md` appended. Fetch those
routes when compact, source-oriented context is more useful than rendered HTML.

```text
https://multix.zuey.me/commands/gemini.md
https://multix.zuey.me/commands/minimax.md
https://multix.zuey.me/reference/environment.md
https://multix.zuey.me/llms.txt
```

## Agent protocol

`multix guide` prints this protocol in one screen for the installed version.

1. **Discover.** `multix models --task <task> --ready` lists the commands that
   serve a task, their default model, whether the key is set, and whether they
   run async. Tasks: `image`, `image-edit`, `video`, `image-to-video`,
   `video-edit`, `speech`, `transcription`, `music`, `sfx`, `voice`, `3d`,
   `analysis`, `document`, `avatar-video`, `any`. Add `--provider <group>` to
   narrow, `--json` for an array.
2. **Validate for free.** Add `--dry-run` to any command: local checks run
   (flags, input files, keys), then the first provider request is shown
   (method, URL without query string, body with long values shortened and
   secret values and URL query strings redacted, header names only) instead of being sent. Local `media` commands stop before
   running.
3. **Run with `--json`** (or `MULTIX_OUTPUT=json`). stdout is exactly one line,
   a `multix.result/v1` envelope; human output is captured.
4. **Check the result.** Success means `ok: true`, a non-empty `outputs` list
   and no `warnings` (`EMPTY_OUTPUT`, `CONTENT_MISMATCH`, `UNREADABLE_MEDIA`).
5. **On failure** follow `error.hint` and `next[]`; do not resubmit a paid job
   blindly.
6. **Long jobs.** Pass `--async` where offered, keep the job id, and run the
   status command from `next[]`.
7. **History.** Every run is recorded locally; see [Run history](#run-history).

## The result envelope

```json
{
  "schema": "multix.result/v1",
  "ok": true,
  "command": "gemini generate",
  "provider": "gemini",
  "model": "gemini-2.5-flash-image",
  "duration_ms": 8120,
  "outputs": [
    { "path": "gemini-image-1.webp", "bytes": 184220, "mime": "image/webp",
      "sha256": "…", "width": 1024, "height": 1024 }
  ],
  "usage": { "tokens": { "input": 12, "output": 1290, "total": 1302 } },
  "http": { "requests": 1, "errors": 0, "ms": 7900 },
  "history_id": "h_mfz3k2ab1c9d",
  "exit_code": 0,
  "next": []
}
```

| Field | Meaning |
| --- | --- |
| `outputs[]` | Files the run wrote: relative path, size, MIME type sniffed from the content, SHA-256, image `width`/`height`, media `duration_s` (with ffprobe). |
| `warnings[]` | Problems found in the outputs, such as an empty file or content that does not match its extension. |
| `data` / `text` | The command's stdout: parsed JSON, or text capped at 32 KB. |
| `error` | `code`, `message`, `retryable`, `retry_after_s`, `hint`, `http_status`, `env` (the key name when one is missing). |
| `usage` | What the provider reported: `tokens` (`input`, `output`, `total`, `thinking`), `cost_usd`, `credits`, and other numeric `metrics` by key path. `sources.cost_usd` / `sources.credits` name where each number came from (for example `api.elevenlabs.io header.character-cost`). Nothing is estimated: a provider's own estimate or quote (such as Runway `estimatedCost`) stays in `metrics` and is never reported as `cost_usd` or `credits`. |
| `http` | Provider request count, failed requests and total time. |
| `provider_ids` | Request, job or prediction ids the provider returned. |
| `request` | With `--dry-run`: the request that would have been sent. |
| `next[]` | Commands to run next: a status command for an async job, `multix check` for a key problem, `multix rerun <id>` for a temporary failure. |

## Exit codes and error codes

| Exit | Class | Error codes | What to do |
| --- | --- | --- | --- |
| 0 | success | | |
| 2 | usage or invalid input | `USAGE`, `INVALID_INPUT` | Fix the flags; nothing was billed. |
| 3 | key or setup | `MISSING_KEY`, `INVALID_KEY`, `CONFIG_ERROR`, `BINARY_MISSING` | `multix check`, set the key named in `error.env`. |
| 4 | temporary | `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR` | Wait `retry_after_s`, then `multix rerun <id>`. |
| 5 | rejected | `QUOTA_EXCEEDED`, `CONTENT_BLOCKED`, `MODEL_NOT_FOUND`, `NOT_FOUND`, `PROVIDER_REJECTED`, `JOB_FAILED`, `RESPONSE_TOO_LARGE` | Change the input, model or provider. |
| 6 | timed out or unknown | `TIMEOUT`, `UNKNOWN_REMOTE_STATE` | The job may still run: use the status command in `next[]`. `UNKNOWN_REMOTE_STATE`: the submit failed without proof that the provider rejected it (cut off, 5xx gateway error), so it may have been queued; check the provider's request list before resubmitting. |
| 1 | unknown | `UNKNOWN` | Read `log[]` (last stderr lines). |

These exit classes apply in agent mode (`--json` or `MULTIX_OUTPUT=json`).
Without it a failed command still exits 1, as in earlier versions, and prints
`code:`, `hint:` and `next:` lines on stderr. The history ledger records the
error code either way.

## Run history

Each provider command appends one line to `~/.multix/history.jsonl` (file mode
0600, rotated at 20 MB): id, time, duration, command, provider, model, argv
(values of options named like key, token, secret or password are redacted),
outcome and error code, outputs with size and hash, provider usage (tokens,
cost, credits, metrics), HTTP counts and provider ids. Keys and signed URLs are
never written.

```bash
multix history                      # last 20 runs
multix history --failed --since 1d  # failures today
multix history show last            # one run in full (id, id prefix, last, last-N)
multix history stats --by model     # runs, success rate, p50/p90 time, cost, credits, tokens
multix rerun h_mfz3k2ab1c9d         # run it again (extra args are appended)
```

`MULTIX_HISTORY=0` turns the ledger off. `MULTIX_HISTORY_FILE` moves it (shell
or `~/.multix/.env` only, not a project `.env`).

## Safe command workflow

- Do not print or request secret values; `multix check` reports which keys are
  set.
- Use explicit `--input`, `--output`, and provider flags when reproducibility
  matters.

## Capability map

| Need | Start with |
| --- | --- |
| Analyze or transcribe files | [Gemini](/commands/gemini/) |
| Generate or edit images, speech, or transcription | [OpenAI](/commands/openai/) |
| MiniMax image, video, speech, or music | [MiniMax](/commands/minimax/) |
| Routed image, image-to-video, or speech | [OpenRouter](/commands/openrouter/) |
| Leonardo image IDs, video, or upscale jobs | [Leonardo](/commands/leonardo/) |
| Seedream, Seedance, reference video, or 3D | [BytePlus](/commands/byteplus/) |
| Workers AI image/speech or AI Gateway video | [Cloudflare](/commands/cloudflare/) |
| Voice workflows, dubbing, or generated audio | [ElevenLabs](/commands/elevenlabs/) |
| Any fal.ai queue model, image, or video | [fal.ai](/commands/fal/) |
| Any Atlas Cloud model, or a resumable async image/video/audio/3D job | [Atlas Cloud](/commands/atlascloud/) |
| Any Replicate model, image, or video; resume/cancel by prediction ID | [Replicate](/commands/replicate/) |
| Runway Gen-4.5 / Gen-4 Turbo video or Gen-4 images; resume/cancel by task ID | [Runway](/commands/runway/) |
| Avatar video from a prompt (Video Agent) or an exact script, video translation, lipsync | [HeyGen](/commands/heygen/) |
| Convert a document or optimize media locally | [Media and documents](/commands/media-and-documents/) |
| Self-update the CLI | [Command overview](/commands/#self-update) |

Treat `--help` and a successful local check as the source of truth when they
differ from any saved documentation.
