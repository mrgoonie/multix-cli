---
title: Gemini commands
description: Use Gemini for multimodal analysis, document extraction, image/video generation, and speech.
---

Gemini commands require `GEMINI_API_KEY`. Extra keys in `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, … are used when a key hits its quota; see [Environment variables](/reference/environment/#gemini-key-rotation). Run `multix gemini <command> --help`
before automating a workflow.

## Analyze, transcribe, and extract

Pass one or more local files with `--files`. Choose `text`, `json`, `csv`, or
`markdown` output where supported. Files over 20 MB are streamed from disk to
the Gemini Files API, which accepts files up to 2 GB (2,000,000,000 bytes); a
larger file is rejected before anything is uploaded. The upload may take as
long as the file needs at 1 MB/s plus one minute (about 35 minutes for 2 GB)
before it times out; on a slower link, set `MULTIX_UPLOAD_MIN_KBPS` to the speed
to allow for, in kilobytes per second (for example `500` for 0.5 MB/s).

```bash
multix gemini analyze --files photo.jpg clip.mp4 --prompt "Describe the scene"
multix gemini transcribe --files interview.mp3 --format markdown
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" --format json
```

Use `-` as a file name to read piped stdin. The type is detected from the
content (common image, audio, video, PDF and UTF-8 text formats). When it
cannot be detected the command stops and asks for `--stdin-ext`. `-` may appear
once and can be mixed with other files, and results label it `<stdin>`. Piped
input is limited to 2 GB. It is copied to a private temporary file that is
removed when the command finishes or is interrupted with Ctrl+C; a hard kill
can leave it in the system temp folder. If nothing arrives on stdin, a hint is
printed after two seconds. In Windows PowerShell 5.1, piping binary data between
programs corrupts it; use PowerShell 7.4+, cmd or Git Bash instead.

```bash
cat screenshot.png | multix gemini analyze --files - --prompt "What is shown?"
curl -s https://example.com/talk.mp3 | multix gemini transcribe --files - --stdin-ext mp3
```

## Images

`generate` supports `--model`, `--aspect-ratio`, `--num-images`, `--size`, and
`--output`. `image-to-image` (alias `i2i`) accepts repeated `--ref` inputs.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
```

## Video

The default video model is `gemini-omni-1.1-flash` (Gemini Omni Flash), served
by the Gemini Interactions API. `VIDEO_GEN_MODEL` or `--model` overrides it. A
`veo-*` model id keeps the Veo pipeline; any other model family is rejected
instead of being guessed. Omni output costs about $0.10 per second of 720p
video; check [Google's pricing page](https://ai.google.dev/gemini-api/docs/pricing)
before large runs. Veo requires enabled Google billing.

```bash
multix gemini generate-video --prompt "Ocean waves at sunset"
multix gemini generate-video --prompt "The cat walks through the garden" \
  --reference-images ./cat.png ./garden.png --aspect-ratio 9:16
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

- `generate-video`: with Omni, `--reference-images` are subject or style
  references (reference-to-video). With Veo, the first image is the opening
  frame and the second the closing frame.
- `image-to-video` (alias `i2v`): the image is the start frame; `--last-frame`
  adds a closing frame to interpolate towards.
- `--output` copies the video to a path of your choice; the original stays in
  the output directory.

### Omni options

| Flag | Values | Notes |
|---|---|---|
| `--resolution` | `360p`, `720p` (default), `1080p`, `4k` | `1080p` and `4k` are upscaled. |
| `--aspect-ratio` | `16:9` (default), `9:16` | |
| `--delivery` | `uri` (default), `inline` | Videos over about 4 MB need `uri`. |
| `--task` | `text_to_video`, `image_to_video`, `reference_to_video`, `edit`, `extend` | The model normally infers the task; use only when prompting is not enough. |
| `--no-store` | | The interaction is not stored, so it cannot be edited, extended or resumed later. Cannot be combined with `--background`. |
| `--background` | on unless `--no-store` | The server runs the request asynchronously and the CLI polls it by interaction id, so the id is saved before the video is ready. |
| `--timeout` | 30–7200 seconds (default 900) | Overall wait for the run. |

`--delivery`, `--task`, `--no-store`, `--background` and `--timeout` are
rejected for `veo-*` models. Veo accepts `--resolution 720p|1080p` (default
`1080p`) and defaults to `16:9`; `--no-thumb` applies to Veo only.

### Session files

Every stored Omni run writes `<video>.interaction.json` next to the video, with
file mode 0600. It records the interaction id, the parent interaction id (for
edits and extensions), the model, the name of the key env var (never the key
value), the status, usage and the output path. Pass it to `edit-video`,
`extend-video` or `video-status` with `--session`.

### Edit and extend

`edit-video` changes a video with a text instruction; `extend-video` adds 3–10
seconds (several extensions reach about 40 seconds in total). Both take
`--prompt` and exactly one source:

- `--session <file>`: a session file from an earlier Omni command. It pins the
  key (and so the Google Cloud project) that created the interaction; override
  with `--key-env GEMINI_API_KEY_2`.
- `--interaction-id <id>`: a stored interaction.
- `--video <path>`: a local clip of 10 seconds or less, uploaded first. Editing
  or extending an uploaded video is unavailable in the EEA, Switzerland and the
  UK.

`--reference-images` adds images you can name in the prompt as
`<IMAGE_REF_0>`, `<IMAGE_REF_1>`, and so on. Interactions created with
`--no-store` cannot be continued.

```bash
multix gemini edit-video --session ./multix-output/omni_generated_1760000000000.interaction.json \
  --prompt "Make it night time"
multix gemini extend-video --session ./multix-output/omni_generated_1760000000000.interaction.json \
  --prompt "The camera rises above the clouds"
multix gemini edit-video --video ./clip.mp4 --reference-images ./hat.png \
  --prompt "Put the hat in <IMAGE_REF_0> on the person"
```

### Check or recover a run

`video-status` takes an interaction id or `--session <file>` and prints one JSON
object to stdout (status, model, usage; no URLs and no video bytes). `--wait`
polls until the interaction finishes, `--download` saves the completed video
into the output directory and updates the session file, and `--output` copies
it elsewhere. Use it to recover a run that timed out locally without paying for
a second generation:

```bash
multix gemini video-status --session ./multix-output/omni_generated_1760000000000.interaction.json --wait --download
```

### Paid-request safety

- Stored runs use `--background` by default, so the interaction id is saved
  in the session file right away and a dropped connection does not lose a
  billed video; resume with `video-status`.
- When a create request fails with a network error, a 5xx or an unreadable
  answer after it was sent, the CLI does not send it again, because it may
  still finish and be billed.
- Keys rotate only on a 429 or `RESOURCE_EXHAUSTED` before the request is
  accepted. Polling, download and follow-ups stay on the key that created the
  interaction; see [Gemini key rotation](/reference/environment/#gemini-key-rotation).
- The download waits until the Files API reports the video `ACTIVE`. The API
  key is sent only to `generativelanguage.googleapis.com`; any other video URL
  is fetched without credentials.

### Remote MCP server

Through the [remote MCP server](/guides/mcp-server/), `multix_run` also accepts
`gemini edit-video`, `gemini extend-video` and `gemini video-status`.
`--session`, `--video` and `--reference-images` are passed as input files.
`--resolution` must be in the operator's allowed list, which rejects `360p` and
`4k` by default.

### Deprecated video models

Using one of these models prints a warning; the request is still sent as asked,
never rerouted.

| Model | Shutdown |
|---|---|
| `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview`, `gemini-omni-flash-preview` | 2026-10-22 |
| `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`, `veo-2.0-generate-001` | 2026-06-30 |
| `veo-3.0-generate-preview`, `veo-3.0-fast-generate-preview` | 2025-11-12 |

To migrate, drop `--model` (and any `VIDEO_GEN_MODEL` that names a Veo model)
so the Omni default applies. Omni defaults to 720p, so pass `--resolution`
explicitly to keep a higher one:

```bash
# Before
multix gemini generate-video --model veo-3.1-generate-preview --prompt "Ocean waves" --resolution 1080p
# After
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p
```

## Speech

Use `generate-speech` with `--text` or `--prompt`; repeat `--speaker name:voice`
for up to two speakers.

```bash
multix gemini generate-speech --text "Welcome to multix." --voice Kore --output-format wav
multix gemini generate-speech --text "Joe: Hi. Jane: Hello." --speaker Joe:Kore --speaker Jane:Puck
```

The default TTS model is `gemini-3.8-flash-lite-tts`. Other supported models
are `gemini-3.8-flash-tts`, `gemini-3.1-flash-tts-preview`,
`gemini-2.5-flash-preview-tts`, and `gemini-2.5-pro-preview-tts` (override
with `--model` or `GEMINI_TTS_MODEL`). The Gemini 3.8 models (`gemini-3.8-flash-tts`,
`gemini-3.8-flash-lite-tts`) read text verbatim and accept a `--style`
delivery direction instead of inline prompt cues:

```bash
multix gemini generate-speech --text "Welcome to multix." \
  --model gemini-3.8-flash-tts --voice Kore --style "cheerful and friendly"
```

`--style` requires a Gemini 3.8 TTS model and is rejected for older models.
