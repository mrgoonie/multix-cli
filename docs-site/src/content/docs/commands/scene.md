---
title: Scene commands (dialogue audio)
description: Render multi-character dialogue line by line with per-character voice profiles, cached takes, approval, and stem export.
---

`multix scene` turns plain-text scene scripts into dialogue audio, one file per
line. Each character has a voice profile, so a speaker keeps the same provider,
model and voice across every scene. Each rendered line is stored as a take.
Editing one line re-renders only that line. You approve the takes you want and
export them as stems for an audio or video editor.

Speech goes through the existing Gemini, OpenAI and ElevenLabs clients and needs
the key of each provider your profiles use: `GEMINI_API_KEY`, `OPENAI_API_KEY`
or `ELEVENLABS_API_KEY`.

## Project layout

A scene project is a local directory. It is the current directory by default;
pass `--project <dir>` to use another one. multix writes these files:

| Path | Contents |
| --- | --- |
| `voices/<id>.json` | One voice profile per character (`multix.voice/v1`). |
| `multix-scene.json` | The scene manifest (`multix.scene/v1`): every line, its request, cache key, takes and status. |
| `takes/<scene>/` | Rendered audio, one file per take. |
| `<out>/scene-export.json` | Export manifest (`multix.scene-export/v1`), written by `export` next to the stems. |

Script paths in the manifest are relative to the project, so you can move the
folder.

## Voice profiles

```bash
multix scene voice add hiro --provider elevenlabs --model eleven_multilingual_v2 \
  --voice kdmDKE6EkgrWrrykO9Qt --setting stability=0.4 --context
multix scene voice add mai --provider gemini --model gemini-3.8-flash-tts \
  --voice Kore --style "soft, warm" --alias "Mai"
multix scene voice list
multix scene voice validate
```

- `--provider` is `gemini`, `openai` or `elevenlabs`. The model, voice and
  `--format` are checked against that provider. If you omit `--format`, it
  defaults to `wav` for Gemini, `mp3` for OpenAI and `mp3_44100_128` for
  ElevenLabs.
- A script speaker matches a profile by its id, `--name` or any `--alias`,
  ignoring case. Profile ids are lowercase letters, digits, `_` and `-`.
- `--setting key=value` is repeatable and accepts only the settings the provider
  supports (see [model limits](#model-limits)).
- `version` starts at 1. `--force` replaces an existing profile and bumps its
  version. The version is a label only. The cache key is built from the actual
  request fields (model, voice, format, style, settings and so on). Changing any
  of them re-renders that voice's lines, while a version bump alone does not.
- Profiles never hold credentials. A field named like a key, token, secret or
  password, or a value that looks like an API key, makes the profile invalid.
  Keys come from the environment at render time.
- A voice cloned from a real person's voice must record consent. `--cloned`
  requires `--consent-by <name>`. `--consent-at <iso>` defaults to the current
  time, and `--consent-note <text>` records the scope.

## Script format

A script is a plain-text file. Each file is one scene.

```text
# scene: s01
# title: Rooftop at dawn
# Other lines starting with "#" are comments.
HIRO: You came after all.
MAI (quiet, a little tired): I almost didn't.
  The last train was already gone.
HIRO: Then we walk.
```

- `# scene: <id>` sets the scene id. Without it, the scene id is the file name
  without its extension. `# title:` is optional.
- `SPEAKER: text` starts a line. `SPEAKER (direction): text` adds a delivery
  direction, which only models that accept a style direction can use.
- A line that does not start with `SPEAKER:` continues the line above it.
- Text is normalized to Unicode NFC. Vietnamese typed with composed or
  decomposed diacritics produces the same cache key.
- Line ids look like `s01/001`. When a line is longer than the model accepts or
  than the profile's `--max-chars`, it is split at sentence boundaries, then at
  word boundaries, into parts `s01/001.1`, `s01/001.2`, and so on. Each part is
  rendered by its own request.

## Workflow

```bash
multix scene plan scripts/s01.txt scripts/s02.txt   # parse into multix-scene.json (local, free)
multix scene render --dry-run                       # check keys and show the first request
multix scene render                                 # render every line that has no current take
multix scene status --lines                         # progress, duration and reported spend
multix scene render --line s01/002 --new-take       # another variant of one line
multix scene approve s01/001 s01/003
multix scene approve s01/002 --take <takeId>        # pick a specific variant
multix scene reject s01/002 --take <takeId>
multix scene export --out stems --approved-only
```

- **plan** parses the scripts and profiles and writes the manifest. It reports
  `to_render`, `to_render_chars`, `cached`, `invalidated`, `added` and
  `removed`. Scripts you name are added to the ones already planned (a script
  at the same path is re-read); `--replace` plans only the scripts you name and
  drops the other scenes. Run `plan` with no script arguments to re-read the
  scripts it already knows. It sends no request.
- **render** re-plans first, so edited scripts and profiles are picked up. Then
  it sends one request for each line with no take for its current request.
  `--scene <id>` and `--line <id>` (repeatable) narrow the selection.
  `--limit <n>` caps how many requests one run sends. `--keep-going` continues
  past a failed line; without it, the run stops at the first failure. The
  command exits non-zero if any line failed. A take whose file fails
  verification (empty, or unreadable by ffprobe when it is installed) is kept
  with its receipt but not selected, and the line fails with
  `VERIFICATION_FAILED`. Identical lines in one run share a single request.
- **`--new-take`** requires `--line`. It renders a new variant of those lines
  even when a take is cached. Earlier takes stay in the manifest.
- **approve** marks the selected take, or the take given with `--take` (one line
  only), as approved. It refuses a take that was rendered for an older script
  or voice.
- **reject** requires `--take`. If the rejected take was selected, the line
  falls back to its newest other take for the same request.
- **status** shows, per scene, rendered/approved/failed counts, duration and
  reported spend. `--lines` adds per-line ids, speakers, status and selected
  take, without script text.
- **export** copies the selected take of every line to
  `<out>/<scene>/<NNN>_<speaker>.<ext>` and writes `scene-export.json` with
  each stem's line id, speaker, text, direction, take, approval, hash, duration
  and model. It fails when a line has no usable take, unless you pass
  `--allow-missing`. `--approved-only` treats unapproved lines as missing.
  Before copying, export checks each take file against its recorded hash.
  `--scene <id>` limits the export to one scene.

## Caching and paid requests

Each line has a cache key: a hash of the exact request (provider, model, voice,
format, style, settings, language, neighbouring text when context is on) plus
the text. `render` only sends lines whose current key has no take. If you edit
one line in a scene, the next render sends one request, and every other line
keeps its take.

multix never retries a paid request and never switches to another provider. A
failed line is recorded with its error code. Running `render` again sends that
line again; that is your decision, not an automatic retry. The manifest is
written after every take, so an interrupted run keeps what it paid for.
`plan`, `render`, `approve` and `reject` hold `multix-scene.lock` while they
run, so two commands cannot overwrite each other's takes; a lock left by a
process that has exited is taken over. Takes follow their cache key, so
inserting a line keeps the audio of the lines below it, but their ids (and
export file names) are renumbered.

Before anything is billed, `plan` and `render` reject:

- a speaker with no profile, an invalid profile, or a secret in a profile;
- markup the model does not accept: SSML other than `<break/>`, `<break/>` on a
  model without SSML breaks, `[audio tags]` on a model other than `eleven_v3`;
- a `(direction)` or `--style` on a model that does not take a style
  direction. Those models would read it aloud.

`render` then checks that the key of every provider it is about to call is set,
before the first request.

## Model limits

These limits are checked before any request is sent. Their source is
[`speech-adapters.ts`](https://github.com/mrgoonie/multix-cli/blob/main/src/commands/scene/speech-adapters.ts);
the model, voice and format lists come from each provider's model files.

| Provider / model | Max chars per request | Style or `(direction)` | SSML `<break/>` | `[audio tags]` | `--context` | Language sent | Settings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gemini 3.8 TTS (`gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`) | 4,000 | yes | no | no | no | no | none |
| Other Gemini TTS models | 4,000 | no | no | no | no | no | none |
| OpenAI `gpt-4o-mini-tts` | 4,096 | yes | no | no | no | no | `speed` (0.25–4) |
| OpenAI `tts-1`, `tts-1-hd` | 4,096 | no | no | no | no | no | `speed` (0.25–4) |
| ElevenLabs `eleven_v4`, `eleven_v4_turbo` | 10,000 | no | no | yes | yes | yes | see below |
| ElevenLabs `eleven_v3`, `eleven_v3_conversational` | 5,000 | no | no | yes | no | yes | see below |
| ElevenLabs `eleven_multilingual_v2` | 10,000 | no | yes | no | yes | no (rejected) | see below |
| ElevenLabs `eleven_flash_v2_5`, `eleven_turbo_v2_5` | 40,000 | no | yes | no | yes | yes | see below |
| ElevenLabs `eleven_flash_v2`, `eleven_turbo_v2` | 30,000 | no | yes | no | yes | yes | see below |

- ElevenLabs settings: `stability`, `similarity_boost`, `style` (0–1),
  `use_speaker_boost` (true/false), `speed` (0.7–1.2) and `seed`. ElevenLabs
  takes no free-text style; use `settings.style` or v3 audio tags. Formats are
  the `mp3_*` and `pcm_*` output formats; μ-law is excluded.
- ElevenLabs `settings.style` is accepted only by `eleven_multilingual_v2`, and
  `use_speaker_boost` only by `eleven_multilingual_v2` and
  `eleven_v3_conversational`; on other models they would be ignored, so the
  profile is rejected. Limits come from the capability table in
  `src/providers/elevenlabs/models.ts`.
- Gemini scene output is `wav` only.
- Characters are counted as Unicode code points. `--max-chars` (minimum 20)
  splits lines below the model limit. A line is split at sentence ends (`.`,
  `!` or `?` followed by a space, so `3.5` stays whole), then at spaces, and
  never inside a `<…>` or `[…]` tag. A tag stays with the word after it, or
  with the word before it at the end of a sentence, so it is never sent as a
  request of its own. `plan` rejects a part that would carry an unclosed tag, a
  tag longer than the limit, or no spoken text (only tags or punctuation).
- `--language` is stored in every profile, but it is only sent to models in the
  "Language sent" column, as the primary subtag (`vi-VN` is sent as
  `language_code: vi`). `eleven_multilingual_v2` does not enforce a language
  code, so a profile with `--language` on that model is rejected; drop
  `--language` or pick a model that enforces it. Gemini and OpenAI profiles
  keep the language for reference only.
- Raw PCM output is wrapped in a WAV header so editors can open every stem.

## Cost receipts

Every take records `usage`: the characters sent plus the `cost_usd` and
`credits` the provider reported for that request alone. When the provider
reports nothing, the value is `null` (unknown), never `0`. For example,
ElevenLabs reports credits and OpenAI TTS reports none. `status` sums spend over
every take, including rejected variants, and counts takes with unknown cost in
`unknown_cost_takes`.

`scene` has no pre-flight estimator yet, so `plan` returns
`estimated_cost_usd: null`. `scene render --estimate` reports the cost as
unknown and sends nothing, and `--max-cost` refuses to run with
`BUDGET_UNPROVEN` (exit 2), even with `--cost-policy estimate`. Use
`to_render_chars` to estimate spend yourself, or price one line with
`elevenlabs tts --estimate` or `gemini generate-speech --estimate`.

## JSON and dry runs

Every `scene` command accepts `--json` (one `multix.result/v1` envelope on
stdout; command data under `data`) and `--dry-run`.

- `render --dry-run` runs every local check and the key check. Then it prints
  the first provider request instead of sending it, and writes no manifest.
- `voice add`, `plan`, `approve`, `reject` and `export` validate with
  `--dry-run` and report `written: false` without changing files.

## Limits

- One request per line. Multi-speaker synthesis in a single request is not
  supported.
- With `--context` (ElevenLabs v2 models), each line's request includes the
  neighbouring lines' text. Editing one line therefore also invalidates the
  lines before and after it.
- No silent provider fallback. A line renders with its profile's provider or
  fails.
- Scene commands do not run through the [remote MCP server](/guides/mcp-server/).
  They are excluded from its catalog because a project lives in a local
  directory across runs, and a job container is discarded after each run.
- multix is not a DAW. It produces per-line stems and `scene-export.json`;
  timing, mixing and effects happen in your editor.

## End-to-end example

```bash
mkdir my-short && cd my-short
mkdir scripts
cat > scripts/s01.txt <<'EOF'
# scene: s01
# title: Rooftop at dawn
HIRO: You came after all.
MAI (quiet, a little tired): I almost didn't.
HIRO: Then we walk.
EOF

multix scene voice add hiro --provider elevenlabs --model eleven_multilingual_v2 \
  --voice kdmDKE6EkgrWrrykO9Qt --setting stability=0.4
multix scene voice add mai --provider gemini --model gemini-3.8-flash-tts --voice Kore

multix scene plan scripts/s01.txt
multix scene render --dry-run          # free: shows the first request
multix scene render                    # 3 requests
# Edit MAI's line in scripts/s01.txt, then:
multix scene render                    # 1 request: only s01/002
multix scene approve s01/001 s01/002 s01/003
multix scene export --out stems --approved-only
```
