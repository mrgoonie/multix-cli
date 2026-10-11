---
title: Atlas Cloud commands
description: Generate images, video, audio and 3D with any Atlas Cloud model, with async predictions you can resume later.
---

Atlas Cloud commands require `ATLASCLOUD_API_KEY` (create one in the
[Atlas Cloud console](https://www.atlascloud.ai/console/api-keys)). The group is
available as `multix atlas` and `multix atlascloud`.

Every job is an asynchronous prediction. By default a command submits, waits up
to `--wait-timeout`, then downloads the outputs to `./multix-output/`. Pass
`--async` to submit and exit right away.

```bash
multix atlas image "a red fox in the snow"
multix atlas image "a red fox in the snow" --async
multix atlas status <predictionId> --wait --download
```

## Images

```bash
multix atlas image "<prompt>" \
  [-m <model>] [--size <size>] [--aspect-ratio 1:1] [--resolution 2k] \
  [-n <count>] [--seed <n>] [--negative-prompt <text>] \
  [--output <path>] [--image-format webp|original] [--no-webp]

multix atlas image-to-image --prompt "make it dusk" --ref photo.png [--ref https://...] \
  [-m <model>] [--size <size>] [...same options]
```

- `image` defaults to `black-forest-labs/flux-schnell` (override with `-m` or
  `ATLASCLOUD_IMAGE_MODEL`).
- `image-to-image` defaults to `openai/gpt-image-1-mini/edit` (override with
  `ATLASCLOUD_IMAGE_EDIT_MODEL`).
- `--ref` accepts local files or `https://` URLs. Local files are uploaded to
  Atlas Cloud first, and the returned temporary URL is passed to the model.

## Video

```bash
multix atlas video "<prompt>" \
  [-m <model>] [--duration <s>] [--resolution 720p] [--aspect-ratio 16:9] \
  [--negative-prompt <text>] [--seed <n>] [--wait-timeout 900000] [--no-thumb]

multix atlas image-to-video --ref first-frame.png [--prompt "slow pan"] [-m <model>] [...]
```

- `video` defaults to `bytedance/seedance-v1-pro-fast/text-to-video`
  (override with `ATLASCLOUD_VIDEO_MODEL`).
- `image-to-video` defaults to `bytedance/seedance-v1-pro-fast/image-to-video`
  (override with `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL`).

## Audio

```bash
# Text-to-speech
multix atlas audio "Hello from multix" [-m <model>] [--voice <id>] [--format mp3] [--language en]

# Speech-to-text: pass --audio; the transcript is printed (and saved with --output)
multix atlas audio --audio meeting.mp3 [-m <model>] [--language en] [--output transcript.txt]
```

- Text-to-speech defaults to `xai/tts-v1` (override with `ATLASCLOUD_TTS_MODEL`).
- With `--audio`, the default is `bytedance/seed-asr-2.0`
  (override with `ATLASCLOUD_STT_MODEL`).
- Some audio models return text rather than media: transcription models and
  lyrics models, for example. multix prints text outputs to stdout instead of
  trying to download them. Music models that return both audio and text save the
  audio and print the text.

## 3D

```bash
multix atlas 3d "a low-poly treasure chest" [-m <model>] [--format GLB] [--seed <n>]
multix atlas 3d --ref object.png [-m <model>]
```

`generate-3d` is an alias. The text-to-3D default is
`tencent/hunyuan3d-rapid/text-to-3d` (`ATLASCLOUD_TEXT_TO_3D_MODEL`). When you
pass `--ref`, the default is `tencent/hunyuan3d-rapid/image-to-3d`
(`ATLASCLOUD_IMAGE_TO_3D_MODEL`). Atlas Cloud serves 3D models through its image
endpoint, and multix reads the right endpoint from each model's schema.

## Any model: `run`

```bash
multix atlas run <modelId> --input '{"prompt":"a cat"}' [--type image|video|audio]
multix atlas run <modelId> --input @input.json [--async] [--wait-timeout 600000] [--output <path>]
```

`--input` takes inline JSON or `@path/to/file.json`, using the field names
from the model's documentation. multix adds the `model` field itself. The
endpoint (`image`, `video` or `audio`) comes from the model's published schema.
Pass `--type` only for a model that has no published schema.

## Status and resume

```bash
multix atlas status <predictionId>                       # print the prediction JSON
multix atlas status <predictionId> --wait                # poll until it finishes
multix atlas status <predictionId> --download [--output <path>]
```

`--async` prints only the prediction id on stdout, so scripts can capture it.
It also prints a resume command on stderr. When a wait times out, the error
includes the same resume command. A prediction that ends in `failed` makes
the command exit with a non-zero status. Atlas Cloud has no cancel endpoint, so
multix does not offer one.

## Upload

```bash
multix atlas upload photo.png
```

This prints a temporary URL for the file, which you can use in `run` payloads.
Atlas Cloud may clean up uploaded files periodically, so use the URL promptly
and do not rely on it for storage.

## Output

- Files are saved to `./multix-output/` (or `MULTIX_OUTPUT_DIR`) as
  `atlas-<first 8 chars of the prediction id>-NN.<ext>`.
- `--output` with a trailing slash, no extension, or an existing directory is
  used as the output directory. A file path is used as-is for a single output,
  and as the stem for `<name>-NN.<ext>` when there are several.
- Images are converted to WebP when `cwebp` is installed. Pass
  `--image-format original` or `--no-webp` to keep the provider's format.
- `--no-download` prints the output URLs instead of saving files. These URLs are
  signed and temporary, so treat them as secrets.

## Validation

Each Atlas Cloud model has its own input fields. Before submitting, multix
fetches the model's public schema from the catalog. It then maps each flag onto
the field that model actually uses, for example `size` or `image_size`, or
`images[]` or `image`. It also checks enums, ranges and required fields. An
unsupported flag or an invalid value fails before anything is billed. The error
lists the values the model accepts.
Use `--no-validate` to skip this check, for example when the catalog is
unreachable. If the schema cannot be fetched, multix warns and submits anyway.

## Notes

- Auth uses `Authorization: Bearer <ATLASCLOUD_API_KEY>`. The media API base is
  `https://api.atlascloud.ai/api/v1` (override with `ATLASCLOUD_BASE_URL`).
- Polling retries rate limits (honouring `Retry-After`), 5xx responses and
  network errors until `--wait-timeout` expires.
- multix never logs the API key, signed output URLs or prompts. Debug output
  (`-v`) shows output URLs with their query string redacted.
- The model catalog with prices is at
  [atlascloud.ai/models](https://www.atlascloud.ai/models).
