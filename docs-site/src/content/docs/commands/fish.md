---
title: Fish Audio commands
description: Native Fish Audio text-to-speech (Drama 3 by default) with multi-speaker turns, pronunciation dictionaries, and voice model lookup.
---

Fish Audio commands use the native Fish Audio API and require `FISH_API_KEY`
(create one at [fish.audio/app/api-keys](https://fish.audio/app/api-keys/)).
Check the installed CLI before automating: `multix fish <command> --help`.

## Text-to-speech

```bash
multix fish tts --text "Welcome to multix." --voice adrian --output welcome.mp3
multix fish tts --text-file intro.txt --voice <voice-id> --format wav --output intro.wav
multix fish tts --model s2.1-pro --text "[whispering] Can you hear me?" --voice delia
```

Give the text with `--text` (alias `--prompt`), `--text-file` (UTF-8, at most
1 MiB), or `--turns-file` for dialogue; only one of them. A request carries at
most 200,000 UTF-8 bytes; split longer text. The audio is saved as
`fish_tts_<stamp>.<ext>` in the output directory and copied to `--output` when
given.

`--voice` takes a Fish voice model id (`reference_id`) or one of the public
voices `adrian`, `delia` and `sheila`. Without `--voice`, `fish tts` sends no
voice and Fish chooses one.

## Models

| Model | Notes |
| --- | --- |
| `drama-3` (default) | Multi-speaker capable. |
| `s2.1-pro` | What Fish serves when the `model` header is missing or not an exact match. |
| `s2.1-pro-free` | Listed at $0 by Fish. |
| `s2-pro` | Multi-speaker capable. |
| `s1` | One voice per request; no multi-speaker text. |

Set the default with `--model` or `FISH_TTS_MODEL`. Prices are per UTF-8 byte
of the text as sent, tags included; see
[the pricing catalog](/reference/for-ai-agents/#pricing-catalog).

### Why the model header is restricted

Fish chooses the model from the exact HTTP `model` header, not the request
body. A missing or misspelled header is served, and billed, as `s2.1-pro` with
a normal 200 response, and the audio response does not name the model that
ran. So multix only sends values from the list above and rejects anything else
before sending. The JSON result reports `model_header_sent` together with
`model_confirmed_by_response: false`: the header is what multix sent, not a
model Fish confirmed. `--dry-run` shows the `model` header value; every other
header value stays hidden.

## Options

| Flag | Meaning |
| --- | --- |
| `--format <fmt>` | `mp3` (default), `wav`, `pcm`, or `opus`. |
| `--sample-rate <hz>` | wav/pcm: 8000, 16000, 24000, 32000 or 44100; mp3: 32000 or 44100; default 44100. Opus is always 48000. |
| `--mp3-bitrate <kbps>` | `64`, `128`, or `192` (with `--format mp3`). |
| `--opus-bitrate <bps>` | `-1000` (automatic), `24000`, `32000`, `48000`, or `64000` (with `--format opus`). |
| `--temperature <n>`, `--top-p <n>` | Sampling, 0 to 1. |
| `--speed <n>` | Speaking rate, 0.5 to 2. |
| `--volume <db>` | Volume change in dB (0 = unchanged). |
| `--no-normalize-loudness` | Turn off loudness normalization (S2 family). |
| `--chunk-length <n>` | Characters per synthesis chunk, 100 to 300. |
| `--no-normalize` | Turn off text normalization (numbers, dates). |
| `--language <bcp47>` | Language hint for text normalization, such as `en`, `vi`, or `es-MX`. |
| `--latency <mode>` | `low`, `normal`, or `balanced`. |

## Tags and phonemes

Text is sent exactly as written. Direction tags such as `[whispering]` and
phoneme tags (`<|phoneme_start|>…<|phoneme_end|>`) are Fish syntax and are
never stripped or rewritten. Fish documents phonemes only for English
(Arpabet), Chinese (pinyin), and Japanese (romaji). Unbalanced phoneme tags
produce a warning, because Fish may read them aloud.

## Multi-speaker dialogue

`drama-3`, `s2.1-pro`, `s2.1-pro-free`, and `s2-pro` voice up to 10 speakers in
one request. Tag each turn with `<|speaker:N|>` and pass one `--voice` per
speaker, in index order (`--voice` for speaker 0 first):

```bash
multix fish tts --voice adrian --voice sheila \
  --text "<|speaker:0|>Did you hear that?<|speaker:1|>[whispering] Stay quiet."
```

Or write the turns as JSON (1 to 200 turns, a voice per turn) and let multix
build the tagged text; `--voice` is not allowed with it:

```json
[
  { "text": "Did you hear that?", "voice": "adrian" },
  { "text": "[whispering] Stay quiet.", "voice": "sheila" }
]
```

```bash
multix fish tts --turns-file scene.json --output scene.mp3
```

## Pronunciation dictionaries

A request takes up to three dictionaries, in one of two forms that cannot be
mixed, because Fish rejects a request that combines them:

- Published dictionaries: repeat `--dictionary <id>@<version>`. The version
  must be the pinned version id copied from the Fish Audio web app; `latest`
  and display numbers such as `V1` are rejected.
- Inline dictionaries: one `--dictionary-file` with JSON
  `[{"items": [{"key", "value", "case_sensitive"?}]}]` (a bare items array is
  read as one dictionary).

Keys and values must not contain `<|phoneme_start|>` or `<|phoneme_end|>`;
Fish wraps values itself. Fish skips a published reference it cannot resolve
and still returns audio, so multix warns that a 200 does not prove the
dictionary was applied.

## Results and failures

- The paid POST is sent once and never retried. A request cut off after Fish
  may have accepted it ends with `UNKNOWN_REMOTE_STATE`; check your usage at
  fish.audio before sending it again.
- The audio is checked: container signature, sample rate, duration, and
  SHA-256. A 200 response whose body is not the requested audio fails; the
  bytes are saved for inspection first, unless Fish labelled them JSON or HTML,
  in which case the error carries Fish's message. Smaller check problems are
  reported as warnings.
- With `--json`, the result includes `model_requested`, `model_header_sent`,
  `model_confirmed_by_response`, `voices`, `speakers`, `input_chars`,
  `input_utf8_bytes`, `text_sha256`, `bytes`, `sha256`, `sample_rate_hz`,
  `duration_s`, `estimated_cost_usd`, `rate_id`, and `warnings`. The text is
  recorded only as its length and hash.

`--estimate` and `--max-cost` work for `fish tts`, including text read from
`--text-file` or `--turns-file`; see
[Cost](/reference/for-ai-agents/#cost-estimate-spend-guard-and-receipt).

## Voice design

`multix fish voice-design` sends a prompt to `POST /v1/voice-design` with the
header `model: voice-design-1` and saves 1 to 4 candidate voices as WAV files
(`fish_voice_design_<stamp>_<index>.wav`). Fish bills $0.01 per successful
request, however many candidates it returns. The request is sent once and is
never retried.

```bash
multix fish voice-design "A calm Vietnamese narrator, mid-30s, warm and slow" --count 3 --language vi
multix fish voice-design --instruction "Energetic radio host" --reference-text "Good morning, everyone!" --seed 7
multix fish voice-design "Gravelly old sailor" --estimate          # $0.01, a proven ceiling
```

| Option | Meaning |
|---|---|
| `[prompt]` / `--instruction` | Voice description, 1 to 2000 characters (give it once) |
| `--reference-text` | Line every candidate reads, up to 300 characters |
| `--language` | Language hint such as `en`, `zh`, `ja`, `vi` |
| `--count` | Candidates, 1 to 4 (default 2) |
| `--speed`, `--steps`, `--guidance`, `--instruct-guidance`, `--seed` | Generation controls, checked before sending |

Each candidate in the `--json` result has `path`, `bytes`, `sha256`,
`audio_kind`, `sample_rate_hz`, `duration_s` and `design_signature`. To keep a
candidate as a reusable voice, clone it.

## Voice cloning

`multix fish clone` creates a persistent voice from audio samples
(`POST /model`, multipart, `type=tts`, `train_mode=fast`). The voice is
private unless you pass `--visibility unlist`; publishing it publicly happens
in Fish's web app. Cloning needs the speaker's permission, so the command
refuses to run without `--consent`.

```bash
multix fish clone --title "My narrator" --sample take1.wav --sample take2.wav --consent
multix fish clone --title "Designed voice" --sample fish_voice_design_..._0.wav \
  --design-signature <design_signature> --consent
multix fish clone --title "Narrator" --sample a.wav --sample b.wav --transcript-file lines.txt --consent
```

- Samples: `.wav`, `.mp3`, `.m4a`, `.opus`, `.ogg` or `.flac`; up to 20 files,
  50 MB each and 200 MB in total. They are streamed from disk.
- Transcripts: one `--transcript` per sample in order, or a `--transcript-file`
  with one line per sample. Without them Fish transcribes the samples itself.
- `--tag` (repeatable), `--description`, and `--no-enhance` to skip Fish's
  noise removal.
- The upload is sent once. If the connection breaks after Fish may have
  accepted it, the run ends with `UNKNOWN_REMOTE_STATE`: check
  `multix fish voices list` before sending it again, or you may get a second
  voice.

## Voice models

Listing and reading voices are free requests. Deleting needs `--yes` because
it cannot be undone.

```bash
multix fish voices list                          # your own voice models
multix fish voices list --public --language vi --title narrator
multix fish voices list --page-size 50 --page 2
multix fish voices get <voice-id>
multix fish voices delete <voice-id> --yes
```

## Native Fish Audio and OpenRouter

`multix fish tts` and OpenRouter's `fish-audio/*` models
([`openrouter tts`](/commands/openrouter/)) are separate routes with separate
prices. multix never falls back from one to the other. OpenRouter's Fish
models are also priced per UTF-8 byte, and their JSON result includes
`input_utf8_bytes`.

`multix speech generate --provider fish` runs the same native request through
the shared speech flags; see [Speech commands](/commands/speech/).
