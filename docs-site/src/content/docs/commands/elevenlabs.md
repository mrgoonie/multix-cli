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

## TTS models and voice settings

`--model` takes `eleven_multilingual_v2` (default), `eleven_v4`,
`eleven_v4_turbo`, `eleven_v3`, `eleven_v3_conversational` and the Flash/Turbo
v2 models. Eleven v4 is the highest-quality model (90+ languages, audio tags
such as `[whispering]`); Eleven v4 Turbo is the low-latency variant and bills
half the characters.

```bash
multix elevenlabs tts --model eleven_v4 --text "[whispering] Can you keep a secret?"
multix elevenlabs tts --model eleven_v4_turbo --text "Hi!" --similarity-boost 0.8 --timestamps
multix elevenlabs models   # live catalog: languages, character limit, cost multiplier
```

The API accepts voice settings a model does not use and drops them, so `tts`
rejects such a flag before sending anything:

| Model | Voice settings | Max characters | Audio tags | SSML |
|---|---|---|---|---|
| `eleven_v4`, `eleven_v4_turbo` | `--stability`, `--similarity-boost`, `--clone-strength` | 10,000 | yes | no |
| `eleven_v3` | `--stability`, `--similarity-boost` | 5,000 | yes | no |
| `eleven_v3_conversational` | `--stability`, `--similarity-boost`, `--speaker-boost` | 5,000 | yes | no |
| `eleven_multilingual_v2` | `--stability`, `--similarity-boost`, `--style`, `--speaker-boost`, `--speed` | 10,000 | no | yes |
| Flash/Turbo v2.5 | `--stability`, `--similarity-boost`, `--speed` | 40,000 | no | yes |
| Flash/Turbo v2 | `--stability`, `--similarity-boost`, `--speed` | 30,000 | no | yes |

`--clone-strength` applies only to Professional Voice Clones fine-tuned for v4.
v2 and v3 models keep the historical defaults (stability 0.5, similarity 0.75);
v4 sends only the settings you pass, so the voice's stored settings apply.
Audio tags on a model that does not read them, or SSML on v3/v4, print a
warning. An unknown model ID is sent as-is with a warning.

`--language-code` takes an ISO 639-1 code; ElevenLabs rejects codes a model
does not support (including any code on `eleven_multilingual_v2`). `--timestamps`
also saves character-level timing next to the audio as `<audio>.alignment.json`.
`--format` accepts MP3, PCM, WAV, Opus, μ-law and A-law variants
(`wav_44100`, `opus_48000_64`, ...).

After each request `tts` prints the characters ElevenLabs billed, read from the
`character-cost` response header. With `--json` the same number is
`usage.credits`, and `usage.credits_source` is `header.character-cost`.

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
