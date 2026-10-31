---
title: Gemini commands
description: Use Gemini for multimodal analysis, document extraction, image/video generation, speech, and Lyria music.
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
`--output`. The default model is `gemini-3.1-flash-image` (Nano Banana 2, GA);
`gemini-3.1-flash-lite-image`, `gemini-3-pro-image` and `gemini-nano-banana-2.1`
are other choices. Imagen 4 is no longer served on the Gemini API, and the
`-preview` image ids are past their earliest announced shutdown date and may
stop at any time. With `--num-images` above 1 the images are requested one by
one; if a later request fails, the images already saved are kept (and copied to
`--output`), and the error suggests a run with `--num-images` set to what is
left. `image-to-image` (alias `i2i`) accepts repeated `--ref` inputs.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
```

## Video

`generate-video` and `image-to-video` (alias `i2v`) use Gemini Omni Flash
(`gemini-omni-1.1-flash`) by default through the Interactions API. Video
generation needs a billing-enabled key.

```bash
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --duration 8
multix gemini generate-video --prompt "A cat walks in" --reference-images ./first.png ./last.png
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

- `--resolution` accepts `360p`, `720p` (default), `1080p` or `4k`;
  `--aspect-ratio` accepts `16:9` (default) or `9:16`; `--duration` takes 3–10
  seconds and the model picks a length when it is omitted.
- `--reference-images` with one or two images sets the first and last frame;
  more images are used as subject references. `i2v --last-frame` sends the
  start image first and the closing image second, so the video opens on the
  first and ends on the second.
- Each request is stored and runs in the background. The interaction id is
  written to `gemini_omni_<timestamp>-<random>.json` in the output directory before
  polling starts. On success stdout prints `Generated video: <path>` and
  `Interaction ID: <id>`.
- `--no-wait` submits, prints `{interaction_id, status, session}` as JSON and
  exits. `--wait-timeout <ms>` (default 15 minutes) is one deadline for the
  whole run up to the finished video: uploads, the submit and polling all
  count against it, and once it has run out nothing is submitted. A submit
  that has started may still take up to 2 minutes, so an accepted (billed)
  job never loses its id. Saving the finished video has its own budget (up to
  5 minutes for the file to become ready, then up to 10 minutes to download).
- A video that comes back inline is read only up to the base64 size of
  `MULTIX_MAX_DOWNLOAD_MB` plus 64 MB of JSON, and never more than 384 MB; a
  larger one fails at once with a `video-status` resume command instead of
  being downloaded on every poll.
- `--no-store` sends one synchronous request that Google does not keep: the
  result cannot be edited, extended or resumed, and `--no-wait` cannot be
  combined with it.
- `--upload-timeout` is deprecated and ignored; `--no-thumb` applies to Veo
  only.

### Edit and extend

`edit-video` changes an existing video with a prompt; `extend-video` appends
a 3–10 second continuation to its end (up to 40 seconds in total). The source is
a stored interaction (`--interaction-id`) or a local clip of at most 10 seconds
(`--video`), which is uploaded to the Files API. The extended video contains
the source clip followed by the continuation (a 3 s clip extended by 3 s comes
back 6 s long).

```bash
multix gemini edit-video --prompt "make it night time" --interaction-id <id>
multix gemini edit-video --prompt "add falling snow" --video ./clip.mp4 --reference-images ./snow.png
multix gemini extend-video --prompt "the camera follows the ball out the door" \
  --interaction-id <id> --duration 6
```

Without `--resolution` or `--aspect-ratio` the result keeps the source format.
`extend-video --video` cannot take `--aspect-ratio` (the API refuses it for an
extension); the continuation keeps the source frame.

With `--video` the request names the task (`edit` or `extend`). With
`--interaction-id` the API does not accept a task, so multix starts the prompt
with `Edit this video:` or `Extend this video:` unless it already says so.
Without it the model guesses from the wording: "the ball turns blue" sent as an
extension came back as an edit.

Only a completed interaction can be continued. Editing or extending an uploaded
video is unavailable in the EEA, Switzerland and the UK; editing a generated
video with `--interaction-id` works there. Stored interactions and uploaded
files expire (Files API uploads after about 48 hours).

### Status, resume and cancel

```bash
multix gemini video-status <id>                      # JSON summary
multix gemini video-status <id> --download --output ./clip.mp4
multix gemini video-cancel <id>
```

`video-status` prints only JSON (or the saved path with `--download`) on
stdout, never file URIs or media bytes; progress goes to stderr, so the output
can be piped to `jq`. It exits non-zero when the interaction failed, was
cancelled or is incomplete. `--wait` polls until it finishes; `--download`
saves a completed video. `video-cancel` reads the interaction first and leaves
a finished one as is.

### Keys and cost

With several keys in the [rotation pool](/reference/environment/#gemini-key-rotation),
only the submit rotates, and only on a rate limit. The key that accepted the
request is used for polling and download, and follow-ups use the key whose
project holds the interaction. A network failure on submit is not retried,
because the video may already be generating and billed.

Omni is paid-tier only. The session record holds a cost estimate from the
reported token usage (video output $17.50, input $1.50, text and thought output
$9 per 1M tokens; roughly $0.10 per second at 720p). The bill is what Google
reports.

### Migrating from Veo

Google shuts the Veo 3.1 preview models down on the Gemini API on 2026-10-22;
the Veo 3.0 models already shut down on 2026-06-30. `gemini-omni-flash-preview`
also shuts down on 2026-10-22, so use `gemini-omni-1.1-flash`.

```bash
# Before: Veo, 1080p by default
multix gemini generate-video --prompt "Ocean waves" --model veo-3.1-generate-preview
# After: Omni Flash, 720p by default
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p
```

An explicit `--model veo-*` (or `VIDEO_GEN_MODEL=veo-*`) still runs the Veo
path, with a shutdown warning for preview models. Veo supports `720p` and
`1080p` (default `1080p`); `--duration`, `--no-store` and `--no-wait` fail with
Veo. Any model that is neither Omni nor Veo is rejected.

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

## Music

`generate-music` makes music with Google Lyria through the Interactions API.
The default `lyria-3-clip-preview` returns a 30-second MP3 clip; `lyria-3.5`
returns a full song of about a couple of minutes, as MP3 or, with
`--output-format wav`, WAV. Override the default with `--model` or
`GEMINI_MUSIC_MODEL`.

```bash
multix gemini generate-music --prompt "upbeat synthwave with a driving bassline"
multix gemini generate-music --model lyria-3.5 --output-format wav \
  --prompt "warm acoustic folk ballad, female vocals" --lyrics-file lyrics.txt
multix gemini generate-music --prompt "a soundtrack for this scene" --image scene.png
```

- `--lyrics` or `--lyrics-file` (UTF-8, up to 64 KB) adds lyrics to the
  prompt; section tags such as `[Verse]` and `[Chorus]`, and timings such as
  `[0:00 - 0:15] Intro`, steer the structure.
- `--image` (repeatable, up to 10 PNG, JPEG, WebP or HEIC images) steers the
  mood.
- The song is saved as `gemini_music_<stamp>.mp3` (or `.wav`). Lyrics or a song
  structure the model returns are saved next to it as `gemini_music_<stamp>.txt`.
- Lyria is billed per song (US$0.04 for a clip, US$0.08 for a `lyria-3.5`
  song, no free tier), so `--estimate` and `--max-cost` work. The request is
  sent once: after a timeout or a dropped connection it is not re-sent,
  because Google may already have generated and billed the song. Only a
  rate-limit answer moves on to the next `GEMINI_API_KEY_<n>` key.

### Lyria RealTime

`music-live` records an instrumental session from Lyria RealTime
(`lyria-realtime-exp`, experimental) to a 48 kHz, 16-bit stereo WAV file. The
session runs over a WebSocket, so it needs Node.js 22 or newer.

```bash
multix gemini music-live --prompt "minimal techno" --prompt "rain" --weight 1 --weight 0.4 \
  --bpm 124 --density 0.6 --duration 60
multix gemini music-live --prompts-file session.json --duration 120 --output live.wav
```

- Repeat `--prompt` with a matching `--weight` (default 1.0) to blend styles.
- Controls: `--bpm` (60–200), `--density` and `--brightness` (0–1),
  `--guidance` (0–6), `--temperature` (0–3), `--top-k` (1–1000), `--seed`,
  `--scale` (for example `C_MAJOR_A_MINOR`), `--mode`
  (`QUALITY|DIVERSITY|VOCALIZATION`), `--mute-bass`, `--mute-drums` and
  `--only-bass-and-drums`. A BPM or scale change resets the model's context,
  which makes an audible transition.
- `--prompts-file` takes JSON with `prompts`, an optional `config` (flags
  override it) and optional `changes` that apply new prompts or config at a
  point in the recording:

  ```json
  {
    "prompts": [{ "text": "lo-fi hip hop", "weight": 1 }],
    "config": { "bpm": 80, "density": 0.4 },
    "changes": [{ "at": 30, "prompts": [{ "text": "jazz piano", "weight": 1 }] }]
  }
  ```

- `--duration` (1–600 seconds, default 30) is the length of audio to record.
  Ctrl-C ends the recording early and still writes a valid WAV file. If the
  server ends the session early, the partial recording is kept, the command
  exits 1, and the session is not restarted.
- The output is instrumental only. Google publishes no price for Lyria
  RealTime yet, so `--estimate` reports it as unknown and `--max-cost` refuses
  it. `--dry-run` prints the session messages without connecting.
- The remote MCP server does not run `music-live`.
