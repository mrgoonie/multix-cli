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
- `--ref` takes one value per flag; repeat it for several references
  (`--ref a.png --ref b.png`). Each value is a local file, an `http(s)://` URL or
  a `data:` URI. Local files are uploaded to Atlas Cloud first (see
  [Upload](#upload) for the limits), and the returned temporary URL is passed to
  the model.

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
Pass `--type` when the model has no published schema, and whenever you use
`--no-validate`, because the schema is then not loaded at all.

## Status and resume

```bash
multix atlas status <predictionId>                       # print the prediction JSON
multix atlas status <predictionId> --wait                # poll until it finishes
multix atlas status <predictionId> --download [--output <path>]
```

`--async` prints only the prediction id on stdout, so scripts can capture it
with `id=$(multix atlas video "waves" --async)`. Progress lines and a resume
command go to stderr. When a wait times out, in a generation command or in
`status --wait`, the error includes the same resume command, with your
`--output` if you gave one, so the files land in the same place. Ctrl-C,
SIGTERM or a closed terminal (SIGHUP) while the command waits, in a generation
command or in `status --wait`, stops polling and exits with 130, 143 or 129 after
printing that resume command; the prediction keeps running and is billed, so
resume it instead of running the command again. With `--json`, the envelope
lists the id in `provider_ids` and the resume command first in `next`. A signal
while the submit request is still in flight cannot tell whether Atlas Cloud
accepted it, and the id is unknown: the envelope says so (`retryable: false`),
so check your predictions in the Atlas Cloud console before submitting again. A
signal before the submit, while the model schema loads or local `--ref` or
`--audio` files upload, cancels cleanly; nothing was submitted. A
prediction that ends in `failed` makes the command exit with a non-zero status.
Atlas Cloud has no cancel endpoint, so multix does not offer one.

## Upload

```bash
multix atlas upload photo.png
```

This prints only a temporary URL for the file on stdout, which you can use in
`run` payloads. Atlas Cloud may clean up uploaded files periodically, so use the
URL promptly and do not rely on it for storage.

Uploads, including local `--ref` and `--audio` files, accept only image, video
and audio files (for example `png`, `jpg`, `webp`, `mp4`, `mov`, `mp3`, `wav`).
Any other file is refused before anything is sent. Files above 200 MB are also
refused; set `ATLASCLOUD_MAX_UPLOAD_MB` to change the limit. The file is
streamed, not loaded into memory.

## Output

- Files are saved to `./multix-output/` (or `MULTIX_OUTPUT_DIR`) as
  `atlas-<prediction id>-NN.<ext>`. An id with characters other than letters,
  digits, `_` and `-`, or longer than 64 characters, is shortened and gets a
  short hash of the full id, so two predictions never share a name. The name is
  fixed for each output of a prediction, so retrying with `multix atlas status <id> --wait --download`
  keeps the files an earlier run saved (listed as "already saved", whatever
  their extension, for example after a WebP conversion) and downloads only the
  missing ones. An empty file does not count as saved. Nothing is duplicated.
- `--output` with a trailing slash, no extension, or an existing directory is
  used as the output directory, with the same names. A file path is used as-is
  for a single output and is overwritten. With several outputs, a file path is
  the stem for `<name>-NN.<ext>`; those names never overwrite an existing file
  (whatever its extension): multix adds `-1`, `-2`, ... instead.
- Output URLs come from the API response, so multix checks them before
  downloading: only `https://` URLs are fetched, and `localhost` or a loopback,
  private, link-local or other special-purpose IP address is refused. Every
  redirect is checked the same way, so a download cannot be redirected to
  `http://` or to an internal address. Host names are not resolved. Inline
  `data:` outputs are still saved.
- Each downloaded file is limited to 2048 MB; set `MULTIX_MAX_DOWNLOAD_MB` to
  change the limit. A larger download is stopped and its partial file removed.
- A video thumbnail is saved only when the prediction's outputs name one. Other
  parts of the payload, which can echo your input such as a reference image,
  are ignored. The thumbnail download follows the same rules as the outputs.
  Pass `--no-thumb` to skip it.
- An output URL without a file extension is named from the download's
  `Content-Type`, so a resumed job gets the same name, `.mp4` or `.png`
  included, as a waited one.
- Each file is downloaded to a temporary `.part` file and renamed when complete,
  so a failed download never overwrites or deletes an existing file. The
  `.part` file also reserves the name: a second run that reaches the same
  output while it downloads stops with an error instead of writing it twice.
  The `.part` lock records the process that holds it. If that process is gone
  (Ctrl+C, a closed terminal, a crash), the next run takes the name over and
  deletes the partial files it left, so a retry just works. On Ctrl+C multix
  also removes its own `.part` files before exiting.
- An output URL ending in an extension that is not a known media type (for
  example `.php`) is named from the download's `Content-Type` instead.
- If some outputs fail to download, multix lists the files it saved, prints the
  resume command and exits with a non-zero status.
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
unreachable. If the schema cannot be fetched within 15 seconds, multix warns and
submits anyway, using each flag's usual field name and type (for example a single
`image` string, and numbers for `seed` and `duration`).

## Notes

- Auth uses `Authorization: Bearer <ATLASCLOUD_API_KEY>`. The media API base is
  `https://api.atlascloud.ai/api/v1` (override with `ATLASCLOUD_BASE_URL`). The
  override must use `https://`, because the API key is sent with every request.
  Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, for
  local mock servers.
- Polling retries rate limits (honouring `Retry-After`), 408 and 5xx responses
  (except 501 and 505) and network errors until `--wait-timeout` expires. Each poll request is limited
  to the time left. Atlas reports some failed jobs as an HTTP 5xx whose body
  holds `data.status: "failed"`; only that shape ends polling as a failure.
- multix never logs the API key, signed output URLs or prompts. Debug output
  (`-v`) shows output URLs with their query string redacted.
- The model catalog with prices is at
  [atlascloud.ai/models](https://www.atlascloud.ai/models).
