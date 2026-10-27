---
title: Fish Audio commands
description: Native Fish Audio text-to-speech (Drama 3 by default) with multi-speaker turns, pronunciation dictionaries, voice design, and voice model management.
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

`fish voice-design` describes a voice in words and returns 1 to 4 candidate
voices as WAV files (Fish's `voice-design-1` model, sent as the `model`
header).

```bash
multix fish voice-design --instruction "A calm, low-pitched narrator with a slight British accent"
multix fish voice-design --instruction "An energetic young host" --reference-text "Welcome back to the show." --count 4 --language en
```

| Flag | Meaning |
| --- | --- |
| `--instruction <text>` | The voice description, 1 to 2,000 characters (alias `--prompt`). |
| `--reference-text <text>` | A line every candidate reads, to compare them. multix accepts up to 300 characters, as Fish's guide says, but Fish's API schema says 150; Fish rejects what it does not take, and a rejected request is not billed. |
| `--language <bcp47>` | Language hint, such as `en`, `vi`, or `es-MX`. |
| `--count <n>` | Candidates, 1 to 4 (Fish's default is 2). |
| `--speed <n>` | Speaking speed, above 0 up to 3. |
| `--num-step <n>` | Diffusion steps, 1 to 128. |
| `--guidance-scale <n>`, `--instruct-guidance-scale <n>` | Guidance, 0 or more. |
| `--seed <n>` | Seed to reproduce a generation. |

Each candidate is saved as `fish_voice_design_<stamp>_<n>.wav` in the output
directory and checked like TTS audio. A request is billed $0.01 when it
succeeds, however many candidates it returns, so `--estimate` and `--max-cost`
work (rate `fish/voice-design-1@api`). It is never retried; a cut-off request
ends with `UNKNOWN_REMOTE_STATE`. If no candidate is a usable WAV, the command
fails, and the request is still billed.

Fish keeps nothing from a voice design. To keep a candidate, clone it with
`fish voices create --sample <wav>`. With `--json`, the result includes
`model_header_sent`, `instruction_chars`, `instruction_sha256`,
`candidates_requested`, `candidates` (each with `number`, the 1-based number in
its file name, Fish's `index`, `id`, `path`, `bytes`, `sha256`,
`signature_ok`, `sample_rate_hz`, `duration_s`, and `problems`),
`estimated_cost_usd`, `rate_id`, and `warnings`.
The instruction is recorded only as its length and hash.

## Voice models

Listing and reading voices are free requests.

```bash
multix fish voices list                          # your own voice models
multix fish voices list --public --language vi --title narrator
multix fish voices list --page-size 50 --page 2
multix fish voices get <voice-id>
```

### Clone a voice

```bash
multix fish voices create --title "My narrator" --sample take1.wav --sample take2.mp3 --consent
multix fish voices create --title "Designed host" --sample fish_voice_design_<stamp>_1.wav \
  --visibility unlist --consent
```

`--consent` is required: clone only a voice you own or have the speaker's
permission to clone. Give 1 to 20 `--sample` files (`.wav`, `.mp3`, `.m4a`, or
`.opus`, at most 50 MB each); the extension must match the file's audio
header (a file with no extension is typed by its header alone). Other flags:

| Flag | Meaning |
| --- | --- |
| `--title <name>` | Required, 1 to 200 characters. |
| `--transcript <text>` | What a sample says, one per `--sample` in order; omit them all to let Fish transcribe. |
| `--voice-design-signature <sig>` | One per `--sample` in order: a voice-design signature Fish issued for that audio. Fish rejects the request if one does not verify. The voice-design response does not document this field, so `fish voice-design` does not report one. |
| `--description <text>`, `--tag <tag>` | Metadata; `--tag` repeats. |
| `--visibility <v>` | `private` (default) or `unlist`. `public` is refused when creating. |
| `--no-enhance-audio-quality` | Do not clean up the samples before cloning. |
| `--generate-sample` | Have Fish generate a preview sample. |

Fish's pricing page lists no price for cloning, so `voices create` is
unpriced: `--estimate` reports `unknown` and `--max-cost` refuses it. multix
warns when the new voice's state is not `trained`; check it with
`fish voices get <id>` before using it. A create request cut off before its
answer leaves the outcome unknown: check `multix fish voices list` before
creating the voice again.

### Edit or delete a voice

```bash
multix fish voices update <voice-id> --title "New name" --tag narrator --tag calm
multix fish voices update <voice-id> --visibility public --yes
multix fish voices delete <voice-id> --yes
```

`update` takes `--title`, `--description`, `--tag` (replaces all tags), and
`--visibility` (`private`, `unlist`, or `public`); `public` lists the voice in
the public Fish Audio library and needs `--yes`. `delete` cannot be undone and
needs `--yes`.

## Native Fish Audio and OpenRouter

`multix fish tts` and OpenRouter's `fish-audio/*` models
([`openrouter tts`](/commands/openrouter/)) are separate routes with separate
prices. multix never falls back from one to the other. OpenRouter's Fish
models are also priced per UTF-8 byte, and their JSON result includes
`input_utf8_bytes`.

`multix speech generate --provider fish` runs the same native request through
the shared speech flags; see [Speech commands](/commands/speech/).
