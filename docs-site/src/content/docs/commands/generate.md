---
title: Generate (all providers)
description: Image, video, lip-sync and upscale on any provider with one set of flags, explicit routing, and inputs checked before any request.
---

`multix generate <task>` puts image, video, lip-sync and upscale on 14
providers behind one set of flags. It does not replace the provider commands;
it maps your request onto the one that serves it and runs that command, so
validation, `--estimate` / `--max-cost`, polling, downloads, history and the
`multix.result/v1` envelope are the provider command's own. Each provider needs
its own key (see [Environment variables](/reference/environment/)).

Tasks: `image` (text-to-image, or image edit with `--image`), `video`
(text-to-video, or image-to-video with `--image` and optionally `--end-image`),
`lipsync`, `upscale`.

Providers: `gemini`, `minimax`, `openai`, `openrouter`, `leonardo`,
`byteplus`, `cloudflare`, `fal`, `atlas`, `replicate`, `runway`, `sume`,
`topview`, `heygen`.

## Find a model

```bash
multix models --task video --live                 # every provider serving the task, with its models
multix models --task video --live --ready --json  # only providers whose key is set, as JSON
```

With `--live` and a generate task, the JSON gains `providers`: one entry per
provider serving the task, with or without a key.

```json
{
  "provider": "atlas",
  "task": "video",
  "ready": false,
  "keys": ["ATLASCLOUD_API_KEY"],
  "command": "multix generate video --provider atlas --model <id>",
  "default_model": "bytedance/seedance-v1-pro-fast/text-to-video",
  "any_model": true,
  "source": { "kind": "live", "state": "fresh", "url": "https://api.atlascloud.ai/api/v1/models", "fetched_at": "2026-11-07T07:00:00.000Z" },
  "models": [{ "id": "bytedance/seedance-v1-pro-fast/image-to-video", "label": "Seedance V1 Pro Fast", "tasks": ["image-to-video"] }]
}
```

`source.kind` is `live` when the provider's catalog was read (fal, OpenRouter,
Atlas Cloud, Replicate, Leonardo, Sume, TopView; cached like the other
`--live` catalogs) and `static` otherwise. A list that needs a key, or a read
that failed, falls back to the models multix knows, with the reason in
`source.error`. `tasks` are the capability tasks a model serves (`image`,
`image-edit`, `video`, `image-to-video`, `lipsync`, `upscale`). `any_model`
means the command passes any provider model id through.

## Run

```bash
multix generate image "a red fox" --provider fal --aspect-ratio 16:9 --output fox.png
multix generate image "make it night" --provider openai --image day.png
multix generate video "waves at dusk" --model atlas:bytedance/seedance-v1-pro-fast/image-to-video --image frame.png
multix generate video "slow pan" --provider byteplus --image a.png --end-image b.png --duration 5 --no-generate-audio
multix generate lipsync --provider heygen --video in.mp4 --audio line.wav --output out.mp4
multix generate upscale --provider leonardo --image <leonardo-image-id>
```

| Flag | Meaning |
| --- | --- |
| `--provider <id>` | Provider. Required unless `--model <provider>:<model>` names it. There is no automatic fallback. |
| `--model <id>` | Model id, or `<provider>:<model>`. Defaults to the provider command's default. |
| `--image <path\|url>` | Input image, repeatable: image edit, first frame, lip-sync subject, upscale source. |
| `--end-image <path\|url>` | Last frame of an image-to-video run (needs `--image`). |
| `--video`, `--audio` | Source video and audio track (lip-sync). |
| `--aspect-ratio`, `--resolution`, `--duration`, `--num-images` | Mapped onto the provider's own flags and values. |
| `--generate-audio` / `--no-generate-audio` | Soundtrack on video models that make one. |
| `--output <path>` | Save the result here (copied from the provider command's file when it has no `--output`). |
| `--async` | Submit and return the job id and resume command instead of waiting. |
| `--wait-timeout <ms>` | How long to wait. Default: `MULTIX_WAIT_TIMEOUT`, else the provider command's. |
| `--json`, `--dry-run`, `--estimate`, `--max-cost`, `--cost-policy` | Passed to the provider command. `--max-cost` is refused when that command cannot enforce it. |

A request the provider command cannot take (an unsupported task, a flag it has
no equivalent for, a local file where it needs a URL) fails with
`CONFIG_ERROR` (exit 3) before any request, naming each field and the providers
that can do the task.

## Output

The envelope is the provider command's `multix.result/v1`, plus `route`:

```json
{
  "schema": "multix.result/v1",
  "ok": true,
  "command": "fal image",
  "provider": "fal",
  "route": {
    "via": "generate",
    "task": "image",
    "provider": "fal",
    "command": "fal image",
    "args": ["a red fox", "--image-size", "landscape_16_9", "--json"]
  },
  "model": "fal-ai/flux/schnell",
  "outputs": [{ "path": "fox.png", "mime": "image/png" }]
}
```

## Coverage

| Task | Providers |
| --- | --- |
| image | gemini, minimax, openai, openrouter, leonardo, byteplus, cloudflare, fal, atlas, replicate, runway, sume, topview |
| image edit (`image --image`) | gemini, minimax, openai, openrouter, leonardo, byteplus, atlas, runway, sume |
| video | gemini, minimax, leonardo, byteplus, cloudflare, fal, atlas, replicate, runway, sume, topview, heygen |
| image-to-video (`video --image`) | gemini, minimax, openrouter, leonardo, byteplus, fal, atlas, replicate, runway, sume, topview, heygen |
| lipsync | heygen, sume |
| upscale | leonardo (Leonardo image ids only) |

Run the provider command directly for anything outside this table (for
example `fal run` with arbitrary inputs).
