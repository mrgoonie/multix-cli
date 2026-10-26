---
title: ElevenLabs commands
description: Work with voices, speech, transcription, audio generation, and asynchronous dubbing.
---

ElevenLabs commands require `ELEVENLABS_API_KEY`.

## Voice workflow and speech

List an account's voices or search the public library before passing a voice ID
to TTS or speech-to-speech. A designed voice is a two-step workflow: `design`
creates previews and returns generated voice IDs; `create-from-preview` stores
the selected preview in the account.

```bash
multix elevenlabs voices list
multix elevenlabs voices search --search "warm narrator"
multix elevenlabs voices design --description "Friendly narrator" --auto-text
multix elevenlabs voices create-from-preview \
  --generated-voice-id <id> --name "Narrator" --description "Friendly voice"

multix elevenlabs tts --text "Welcome to multix." --voice <voiceId> --output welcome.mp3
multix elevenlabs clone --name "My Voice" --files sample1.wav sample2.wav
multix elevenlabs voice-changer --input source.wav --voice <voiceId> --output changed.mp3
```

`tts` returns audio synchronously. Clone input is local audio and should total
one to three minutes.

### TTS models and model-specific options

| Model | Max characters | Voice settings it uses | Notes |
|---|---|---|---|
| `eleven_v4` | 10,000 | `--stability`, `--similarity-boost`, `--clone-strength` | Highest quality, audio tags, 90+ languages |
| `eleven_v4_turbo` | 10,000 | `--stability`, `--similarity-boost`, `--clone-strength` | Low latency, half the character cost of v4 |
| `eleven_v3` | 5,000 | `--stability`, `--similarity-boost` | Audio tags; no `--previous-text`/`--next-text` |
| `eleven_multilingual_v2` (default) | 10,000 | all but `--clone-strength` | Ignores `--language-code` |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` | 40,000 | `--stability`, `--similarity-boost` | Low latency |

```bash
multix elevenlabs tts --model eleven_v4 --language-code en \
  --text "[whispers] Keep it covered. [sighs] They may not ask as politely." --output line.mp3
multix elevenlabs tts --model eleven_v4_turbo --text "Hi there." --timestamps
multix elevenlabs models   # live model catalog
```

`tts` checks options against the model before calling the API, so a mismatch
costs nothing:

- Eleven v4 and v4 Turbo reject `--style` and `--no-speaker-boost`; the API
  would accept and ignore them. `--clone-strength` (0 to 1, start at 0) only
  affects Professional Voice Clones fine-tuned for v4.
- `--previous-text`/`--next-text` fail for `eleven_v3`, which the API refuses.
- For the older models an option the model ignores only prints a warning and
  is still sent, so existing scripts behave as before.
- Audio tags such as `[whispers]` work on v4, v4 Turbo and v3; other models
  get a warning that the tags may be read aloud. v4 and v3 do not support SSML
  `<break>`; use punctuation or audio tags, and IPA between slashes on v4.

`--timestamps` saves character timing as `<audio>.alignment.json` next to the
audio. Every `tts` run prints the characters ElevenLabs reports in its
`character-cost` header; with `--json` the same number is `usage.credits`, and
`usage.metrics["header.character-cost"]` names its source.

## Transcription and generated audio

```bash
multix elevenlabs transcribe --input interview.mp3 --diarize --format srt
multix elevenlabs sfx --text "Car engine starting" --duration-seconds 5
multix elevenlabs music --prompt "Dreamy synthwave loop" --output music.mp3
multix elevenlabs isolate --input noisy.wav --output clean.wav
multix elevenlabs align --input narration.mp3 --text-file transcript.txt
```

## Dubbing jobs

`dub` is asynchronous. Use `--async` to receive a dubbing ID immediately, then
download a completed language track through `dub-status`.

```bash
multix elevenlabs dub --input video.mp4 --target-lang es --async
multix elevenlabs dub-status <dubbingId> --download es --output video-es.mp4
```

Alternatively, `dub --download` waits for the job before downloading.
