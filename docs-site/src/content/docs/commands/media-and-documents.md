---
title: Media and documents
description: Optimize, inspect and verify media with local tooling and convert documents to Markdown with Gemini.
---

## Prerequisites

Media commands run local executables: `ffmpeg` handles audio and video, while
the ImageMagick 7 `magick` command handles images. Install both before running
`multix media`.

### macOS (Homebrew)

```bash
brew install ffmpeg imagemagick
```

### Ubuntu or Debian

```bash
sudo apt update
sudo apt install -y ffmpeg imagemagick
```

Some Linux distributions package ImageMagick 6, which exposes `convert` rather
than the required `magick` executable. If the verification below cannot find
`magick`, install ImageMagick 7 using the [official download instructions](https://imagemagick.org/download/).

### Windows (winget)

```powershell
winget install -e --id Gyan.FFmpeg.Shared
winget install -e --id ImageMagick.ImageMagick
```

Open a new terminal after installation, then verify both tools and multix:

```bash
ffmpeg -version
magick -version
multix check
```

For another operating system or package manager, use the [FFmpeg download
page](https://ffmpeg.org/download.html) and [ImageMagick download page](https://imagemagick.org/download/), then ensure `ffmpeg` and `magick` are on `PATH`.

## Media utilities

`multix media` chooses an appropriate ffmpeg or ImageMagick flow from the input
type. Use explicit outputs so original files remain untouched.

Audio is re-encoded to mono 16 kHz with the codec that matches the output
extension: `.mp3` (MP3), `.m4a`/`.aac`/`.mp4`/`.mka`/`.mkv`/`.mov` (AAC),
`.opus`/`.ogg` (Opus), `.wav`/`.aiff` (PCM) or `.flac` (FLAC). `--bitrate`
applies to the lossy formats only. Any other output extension is rejected before
ffmpeg runs. Embedded cover art is dropped, so the output holds audio only.

```bash
multix media optimize --input video.mp4 --output optimized.mp4 --target-size 100
multix media optimize --input photo.png --output photo.webp --quality 85 --max-width 1920
multix media optimize --input voice.wav --output voice.mp3 --bitrate 64k
multix media split --input long-video.mp4 --chunk-duration 3600
multix media batch --input-dir ./source --output-dir ./optimized
```

## Inspect and verify media

`media inspect`, `verify`, `frames`, `check-receipt` and `profiles` run
offline: nothing is uploaded, no provider is called and no API key is needed.
They need `ffmpeg` and `ffprobe` on `PATH` (ImageMagick is not used); without
them the command stops with `BINARY_MISSING` and an install hint. Inputs must
be local paths: URLs and ffmpeg protocols such as `concat:` or `pipe:` are
refused, and symlinks are followed and reported.

```bash
multix media inspect clip.mp4 --decode
multix media profiles
multix media verify clip.mp4 --profile motion-graphics --expect-aspect 16:9 \
  --allow-black 0-1 --receipt-out clip.receipt.json
multix media frames clip.mp4 --output-dir ./frames --count 9 --sheet
multix media check-receipt clip.receipt.json clip.mp4
```

### Inspect

`media inspect` is read-only. It reports the file's sha256 and size, the
container sniffed from its magic bytes and whether the extension matches, the
streams, and for the first video stream the codec, size, display size after
rotation and sample aspect ratio, rotation, rational frame rates, time base
and whether the frame rate is variable. Unknown values are `null`. A text file
(an error page or playlist saved with a media extension) is reported as such
and never passed to `ffprobe`. `--decode` decodes the whole file and counts
decode errors.

### Verify

`media verify` checks a file against a versioned profile and prints a
receipt (`multix.media-verify/v1`) bound to the file's sha256, with status
`pass`, `fail` or `incomplete`. The command exits non-zero unless the status
is `pass`; with `--json` the receipt is the `data` of the result envelope.
`--receipt-out` also writes it to a file.

Built-in profiles (list them with `multix media profiles`):

| Profile | Media | Judges |
|---|---|---|
| `motion-graphics` | video | Black gaps fail; only long static holds warn |
| `camera-footage` | video | Black gaps and frozen frames over 1 s fail; missing audio and long silences warn |
| `thumbnail` | image | Must decode and must not be blank |
| `audio` | audio | Audio stream required; true peak at 0 dBTP or above fails; long silences warn |

Checks cover media kind, decode integrity and truncation, black and frozen
ranges, blank images, silence, clipping and (for video profiles) a picture
that ends before its sound, plus the expectations you pass:
`--expect-duration` (`--duration-tolerance`), `--expect-aspect` such as `16:9`,
`9:16` or `1:1` (`--aspect-tolerance`), and `--loudness` (`--loudness-tolerance`).
Loudness is checked only when you pass a target; no platform targets are built
in. Each check records its threshold, the measured values and findings with
`start_s`/`end_s`.

Declare intended fades, holds and silences with the repeatable
`--allow-black`, `--allow-freeze` and `--allow-silence <start-end>` ranges (in
seconds). Findings inside them are reported as intentional instead of failing.
A black hold is also a still picture, so `--allow-black` covers the freeze it
causes as well.

A receipt never claims more than was measured. A `--timeout`, Ctrl-C, an
unmeasured check or a file that changed during the run makes it `incomplete`,
never `pass`. `coverage.model_reviewed` is always `false`, and `not_measured`
lists what was not checked, such as audio/video sync and content correctness.

A custom profile is a JSON file passed with `--profile-file`:

```json
{
  "id": "short-promo",
  "version": 1,
  "extends": "camera-footage",
  "checks": { "freeze": null, "audio_required": "error" }
}
```

`extends` names a built-in profile whose checks are overridden one by one;
`null` disables a check. Without `extends`, set `media` (`video`, `audio` or
`image`).

`--rule <script>` (repeatable) adds a deterministic check of your own. The
script reads `multix.media-rule-input/v1` JSON on stdin and prints
`{id, version, status, message?, findings?}` on stdout, where `status` is
`pass`, `fail`, `warn` or `unknown`. `.js`/`.mjs`/`.cjs` run with Node, `.py`
with `python3 -I`, `.sh` with `sh`, anything else directly. Rules run without
a shell, with only `PATH` in the environment (no API keys), in an empty
temporary directory that is removed afterwards, with `--rule-timeout`
(default 30 s) and a 1 MB output cap. A crash, timeout or invalid output
becomes an `unknown` check and the receipt is `incomplete`.

`--cache-dir <dir>` reuses receipts keyed by the verify engine and ffmpeg
versions, the source sha256, the profile, the expectations and the rule
scripts. Incomplete receipts are never cached; delete the directory to clear
it. Only a rule's own file is hashed: after changing a module it imports, clear
the cache. Treat the cache directory as trusted local state, not something to
share.

### Frames

`media frames` extracts `--count` frames (default 9) at the midpoints of equal
slices to `frame-NNN.png`, optionally a `sheet.png` contact sheet, and a
`frames.json` manifest with the source sha256, the stream time base and frame
rate, and each frame's timestamp and sha256. It refuses an output directory
that already holds these files. Extracting frames is not a review: to have a
model look at them, pass them to `multix gemini analyze` yourself.

### Check a receipt

`media check-receipt <receipt> <file>` re-hashes the file and succeeds only if
it is the exact bytes the receipt judged and the receipt passed. It accepts a
bare receipt or a `--json` envelope. A transcoded, remuxed or finalized file
has new bytes, so verify the final file itself before checking its receipt.
Receipts are not signed: they record a local run, so trust one only as far as
you trust where it came from.

On the [remote MCP server](/guides/mcp-server/), `--rule`, `--cache-dir` and
`--receipt-out` are not supported.

## Document conversion

`multix doc convert` uploads a supported document to Gemini and writes a
Markdown result. Use `--output` for a deterministic path or `--auto-name` for
a generated output name.

```bash
multix doc convert --input report.pdf --output report.md
multix doc convert --input presentation.pptx --auto-name
```

Pass `-` as the input to read a piped document from stdin. PDFs, images and
text are detected automatically; when the type cannot be detected, pass
`--stdin-ext` (for example `--stdin-ext pdf`). `-` can be given only once per
command; to convert a real file named `-`, write it as `./-`. Piped input is
labelled `<stdin>` in the output and in errors,
`--auto-name` writes `stdin-extraction.md`, and the temporary copy is removed
when the command ends. Without `--output` or `--auto-name` the result goes to
`document-extraction.md` in the output directory, as for regular files.

```bash
cat report.pdf | multix doc convert --input - --output report.md
```

The command requires a configured Gemini key and can be affected by file size,
model availability, and account policy.
