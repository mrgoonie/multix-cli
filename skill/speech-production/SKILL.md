---
name: speech-production
description: Produce and transcribe audio with multix — text-to-speech on any provider through multix speech or provider commands (OpenAI, Gemini Flash TTS incl. Gemini 3.8 delivery style, OpenRouter, MiniMax, ElevenLabs v4, native Fish Audio Drama 3 with multi-speaker turns, pronunciation dictionaries and voice design, fal.ai, Cloudflare MeloTTS), voice cloning, speech-to-text and transcription (OpenAI, ElevenLabs Scribe, OpenRouter Whisper and others), music and sound effects, and multi-character dialogue audio with per-character voice profiles, cached takes and stem export (multix scene).
version: 1.26.0 # x-release-please-version
license: MIT
metadata:
  tasks: speech, transcription, music, sfx, voice
---

# multix speech production

Check verified model capabilities before picking a model: `multix models --task speech --ready` (or `--task transcription`, `music`, `sfx`, `voice`) lists each command with its default model and whether its key is set, and `multix models --model <id>` shows a verified model's voices, formats, inputs and example. The capability registry is authoritative; the model ids below are examples and defaults, not a complete list. Agent protocol (including speech cost estimates), keys, output dir and the generic fal.ai / Atlas Cloud (`atlas audio`) runners: [../SKILL.md](../SKILL.md). HeyGen TTS is in [../video-production/SKILL.md](../video-production/SKILL.md#heygen).

## When to use

- **Text-to-speech via OpenRouter** with one key across Gemini, ElevenLabs, Fish Audio, MiniMax and other speech models (`multix openrouter tts`; list with `multix openrouter speech-models`)
- **Speech-to-text via OpenRouter** across Whisper, GPT-4o transcribe, Gemini Transcribe, ElevenLabs Scribe, Voxtral, Deepgram, AssemblyAI and other transcription models (`multix openrouter transcribe`; list with `multix openrouter transcription-models`)
- Generate speech on any TTS provider with one flag set, or pick a TTS model by language (`multix speech`)
- **Text-to-speech on the native Fish Audio API** (Drama 3 by default, multi-speaker `<|speaker:N|>` turns, pronunciation dictionaries; `multix fish tts`, voice design via `multix fish voice-design`, cloning via `multix fish clone`, voices via `multix fish voices list`)
- Generate or clone a voice, run STT, generate music or sound effects
- Voice a multi-character dialogue (anime, film, audio drama) line by line with a fixed voice per character, approve takes, and export stems (`multix scene`)

## Speech across providers (`multix speech`)

Discover, then generate on an explicit provider. The request is checked against the model's languages, voices, formats, style/emotion support before any call.

```bash
multix speech models --language vi --json      # models documenting Vietnamese: formats, style, emotions, max_speakers, async, voices, extras, billing, ready
multix speech generate --provider <gemini|openai|elevenlabs|minimax|atlas|fish|openrouter|fal> [--model <id>] --text-file scene.txt --output <file.ext> --dry-run --json
multix speech generate --provider <...> [--model <id>] --text-file scene.txt --output <file.ext> --json

# Vietnamese two-speaker dialogue (Gemini, max 2 speakers); scene.txt:
#   Lan: Chào anh Minh, hôm nay anh khỏe không?
#   Minh: Chào Lan, anh khỏe lắm, cảm ơn em!
multix speech generate --provider gemini --language vi --text-file scene.txt \
  --speaker "Lan:Kore" --speaker "Minh:Puck" --output scene.wav --json
# Vietnamese with a named emotion (MiniMax)
multix speech generate --provider minimax --language vi --emotion happy --text "Xin chào các bạn!" --output hello.mp3 --json
```

- Never switches provider silently: pass `--provider` (a bare `--model` works only if exactly one provider serves it).
- `--fallback provider[:model[:voice]]` (repeatable) is opt-in, used only when earlier routes lack an API key, before any paid request; a paid request is never resent. A fallback prints a warning with voice/billing/format differences (`data.fallback` in JSON).
- `--voice` must belong to the chosen provider; `--extra <provider.key=value>` for provider options (keys listed in `speech models`).
- `--provider fish` (default `drama-3`, voice Adrian) sends one voice; dialogue goes through `multix fish tts --turns-file`.
- `--provider openrouter`: any OpenRouter speech id (rows in `speech models` are verified); model and voice checked against OpenRouter's live list before the paid request; `--extra openrouter.speed|zdr|deny_data_collection`. `--provider fal`: the `fal tts` endpoints, voices from `multix fal voices`; `--async` returns `job.resume` (`multix fal result ...`). `google/gemini-3.8-flash-tts` is on both, so pass `--provider`.
- JSON `data` = `multix.speech.result/v1`: `request` (text recorded as `text_chars` + `text_sha256`), `route`, files or async `job`.
- Remote MCP: `--provider` required; `--text-file` is an `inputs` URL; `speech models --ready` unavailable.

## Provider TTS commands

```bash
# TTS
multix openai generate-speech --text "Hello world" [--voice alloy] [--output-format mp3]
multix gemini generate-speech --text "Have a wonderful day!" --voice Kore
# Gemini 3.8 models (default gemini-3.8-flash-lite-tts) read text verbatim and take delivery
# direction via --style instead of embedding it in the text:
multix gemini generate-speech --text "Have a wonderful day!" --model gemini-3.8-flash-tts --style "cheerful and friendly" --voice Kore
multix minimax generate-speech --text "..." --voice <id> --emotion neutral
multix elevenlabs tts --text "Hello world" [--voice <voiceId>] [--model eleven_multilingual_v2]
# OpenRouter speech (default google/gemini-3.8-flash-tts; Gemini and ElevenLabs need --voice; fish-audio/drama-3 does not)
# --format auto = WAV for pcm-only Gemini/HeyGen, MP3 otherwise (MiniMax: mp3 only). The request is never retried:
# on UNKNOWN_REMOTE_STATE check `openrouter generation <id>` or openrouter.ai/activity before resending.
multix openrouter tts --text "Xin chào" --model google/gemini-3.8-flash-lite-tts --voice Kore --output hello.wav
multix openrouter speech-models [--model <id>]       # live model list / one model's voices
multix openrouter generation <generation-id>         # cost, if it was not reported yet
# Eleven v4 (quality) / v4 Turbo (low latency, 0.5 credits/char): 90+ languages, [audio tags], 10k chars.
# No --style on v4/v3/Flash (rejected, not ignored); v3 rejects --previous-text/--next-text.
# --clone-strength 0..1 only on v4/v4 Turbo (PVC fine-tuned for v4); multilingual_v2 ignores --language-code (warned).
multix elevenlabs tts --model eleven_v4 --text "[warmly] Xin chào!" --language-code vi [--timestamps]
multix elevenlabs models   # live capabilities per model
```

### Fish Audio (native)

```bash
# Fish Audio native (default drama-3; FISH_TTS_MODEL). Model = exact `model` header, allowlist only:
# drama-3, s2.1-pro, s2.1-pro-free, s2-pro, s1. Fish serves a missing/misspelled header as s2.1-pro with a 200 and
# the audio does not name the model: result has model_header_sent + model_confirmed_by_response: false.
# Billed per UTF-8 byte (tags included). Never retried: UNKNOWN_REMOTE_STATE = check fish.audio usage before resending.
# Audio is checked (signature, sample rate, duration, sha256). Tags like [whispering] and phoneme tags are sent unchanged;
# Fish documents phonemes only for English (Arpabet), Chinese (pinyin), Japanese (romaji).
multix fish tts --text "Welcome to multix." --voice adrian --output welcome.mp3   # public voices: adrian, delia, sheila
multix fish tts --voice adrian --voice sheila --text "<|speaker:0|>Hi.<|speaker:1|>Hello."   # one --voice per speaker, index order; not s1
multix fish tts --turns-file scene.json   # [{"text": "...", "voice": "<voice-id>|adrian|delia|sheila"}], no --voice
# Pronunciation dictionaries: up to 3, all --dictionary <id>@<pinned-version> (not latest/V1) OR one --dictionary-file, never mixed;
# Fish silently skips an unresolved reference (warned).
multix fish voices list [--public] [--language vi] [--title <text>]   # free; your voices by default
multix fish voices get <voice-id>
multix fish voices delete <voice-id> --yes
# Voice design: header model: voice-design-1, $0.01 per successful request (any --count 1-4), never retried; saves WAV candidates
multix fish voice-design "A calm Vietnamese narrator" --count 3 --language vi --json   # candidates[].path
# Clone: POST /model multipart type=tts train_mode=fast, private by default; --consent required; sent once
# (UNKNOWN_REMOTE_STATE = check `fish voices list` before resending, or you may create a second voice)
multix fish clone --title "My narrator" --sample a.wav [--sample b.wav] [--transcript-file lines.txt] --consent
# Native Fish and OpenRouter fish-audio/* are separate routes and prices; multix never falls back between them.
```

### fal.ai TTS

```bash
# Text-to-speech (default google/gemini-3.8-flash-tts, or FAL_TTS_MODEL); flags map to each model's own fields
multix fal tts "Xin chào" [--voice Puck] [--style "warm"]                       # Gemini: prompt/voice/style_instructions, wav
multix fal tts --text-file script.txt -m elevenlabs/tts/eleven-v4-turbo [--format pcm_16000|opus_48000_64|mp3_44100_128] [--language vi]
multix fal tts "hi" -m <other-fal-tts> --text-field <field> [--voice-field <field> --voice <v>]   # unlisted model: name its fields
multix fal voices [<model>] [--live]   # verified models, voices, formats; <model> or --json prints typed inputs; --live lists fal's TTS catalog
```

`fal tts` refuses a flag the model has no field for (`--style` on ElevenLabs, `--format` on Gemini) and a voice, format or language code outside the model's rules, before sending; `--input` values meet the same checks. Gemini dialogue goes in `--input` as exactly two `speakers` `{speaker_id, voice}` plus `turns` `{speaker_id, text}` naming them, without a text or `--voice`; fal currently rejects even a well-formed dialogue with HTTP 422 after queueing (#310). It saves `fal-<id>-01.<ext>` with the extension taken from the bytes (raw `pcm_*`/`ulaw_8000`/`alaw_8000` from the format) and refuses empty, error-page, sample-less WAV or mislabelled audio; `--detach` and `fal result --download` work as for `run` (see [../SKILL.md](../SKILL.md#falai)).

### Cloudflare Workers AI speech

```bash
# Workers AI speech (MeloTTS; sync, saves MP3)
multix cloudflare generate-speech --text "Hello world" \
  [--lang <code>] [--model @cf/myshell-ai/melotts] [--output <path>] [-v]
```

## Voice cloning + STT

```bash
multix openai transcribe --input audio.mp3 [--format text|json|diarized_json] [--language vi]
multix elevenlabs clone --name "My Voice" --files sample1.wav sample2.wav
multix elevenlabs transcribe --input audio.mp3 [--diarize] [--format text|json|srt|vtt]
# OpenRouter STT (default openai/whisper-large-v3-turbo): --input is a local file (≤ 25 MB, uploaded) or a public http(s) URL
# (not every provider accepts URLs). Saves openrouter_transcript_<stamp>.txt; text mode prints only the path, --json has the text.
# The request is never retried: on UNKNOWN_REMOTE_STATE check `openrouter generation <id>` before resending.
multix openrouter transcribe --input meeting.mp3 --language en --json
multix openrouter transcription-models [--model <id>] # live model list with prices
multix elevenlabs transcribe --input ./audio.mp3 --diarize
```

Gemini transcription (`multix gemini transcribe`) is in [../document-conversion/SKILL.md](../document-conversion/SKILL.md).

## Music + SFX

```bash
multix minimax generate-music --lyrics "..." [--model music-2.5]
# Gemini Lyria: 30 s MP3 clip (default) or a full song with lyria-3.5 (mp3|wav); billed per song, never re-sent on timeout.
# Lyrics/structure the model returns are saved next to the audio as gemini_music_<stamp>.txt.
multix gemini generate-music --prompt "warm folk ballad" [--model lyria-3.5] [--lyrics-file lyrics.txt] [--image mood.png] [--output-format wav]
# Lyria RealTime (experimental, instrumental only, Node 22+, unpriced, local CLI only): weighted prompts to a 48 kHz WAV.
# --prompts-file JSON {prompts:[{text,weight}], config?, changes?:[{at,prompts?,config?}]}; Ctrl-C keeps a valid WAV.
multix gemini music-live --prompt "minimal techno" --prompt "rain" --weight 1 --weight 0.4 [--bpm 124] [--duration 60] [--output live.wav]
multix elevenlabs music --prompt "dreamy synthwave loop" [--music-length-ms 30000]
multix elevenlabs sfx --text "car engine starting" [--duration-seconds 5]
```

## Scenes (multi-character dialogue)

Use `multix scene` when a script has several speakers who must keep the same voice across lines and scenes. For one voice reading one text, use the provider's TTS command instead. A project is a local directory (`--project <dir>`, default `.`); scene commands are not available through the remote MCP server.

```bash
multix scene voice add <id> --provider gemini|openai|elevenlabs --model <tts-model> --voice <voice> [--language vi-VN] [--style "..."] [--setting key=value] [--alias NAME]
multix scene voice validate
multix scene plan scripts/s01.txt [scripts/s02.txt ...] --json   # local, free: to_render, to_render_chars, invalidated
multix scene render --dry-run --json                             # local checks + key preflight, shows the first request
multix scene render --json [--scene s01] [--line s01/002] [--limit <n>] [--keep-going]
multix scene status --lines --json
multix scene approve s01/001 [--take <takeId>]   |   multix scene reject s01/002 --take <takeId>
multix scene export --out stems [--approved-only] [--allow-missing]
```

- Script lines: `SPEAKER: text` or `SPEAKER (direction): text`; `# scene: <id>`, `# title: ...`; other lines continue the line above. The speaker matches a profile id, `--name` or `--alias`, ignoring case.
- Run `plan` and then `render --dry-run` before the first paid render. They reject unsupported markup (SSML, `[audio tags]`, `(direction)` on models without style) and missing keys before any request is billed.
- `render` sends one request per uncached line and never retries. On a failure it records the error and stops (or continues with `--keep-going`), then exits non-zero. Do not re-run it in a loop: read `failed[]`, fix the cause, then re-render; only failed and pending lines are sent again. `--new-take --line <id>` pays for a new variant.
- Editing one line re-renders only that line, plus its neighbours for profiles with `--context`. Per-take `usage.cost_usd`/`credits` are `null` when the provider reported nothing; `plan.estimated_cost_usd` is always `null`, `--estimate` reports unknown and `--max-cost` refuses (`BUDGET_UNPROVEN`): scene has no estimator.
- Profiles never hold keys. A cloned voice needs `--cloned --consent-by <name>`. Model limits table: <https://multix.zuey.me/commands/scene/>.

## Environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_TTS_MODEL` | Default `openrouter tts` model (default `google/gemini-3.8-flash-tts`) |
| `FISH_TTS_MODEL` | Default `fish tts` / `speech generate --provider fish` model (default `drama-3`; exact header value from the allowlist) |
| `OPENROUTER_STT_MODEL` | Default `openrouter transcribe` model (default `openai/whisper-large-v3-turbo`) |
| `FAL_TTS_MODEL` | Default `multix fal tts` model (default `google/gemini-3.8-flash-tts`) |
| `GEMINI_TTS_MODEL` / `TTS_MODEL` | Override Gemini TTS model (default `gemini-3.8-flash-lite-tts`) |
