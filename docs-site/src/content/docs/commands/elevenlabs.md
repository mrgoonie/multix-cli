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

## TTS models and options

| Model | Use | Max characters | Style | Speaker boost | Previous/next text |
|---|---|---|---|---|---|
| `eleven_v4` | Highest quality, 90+ languages, audio tags | 10,000 | no | no | yes |
| `eleven_v4_turbo` | v4 quality at low latency, 0.5 credits per character | 10,000 | no | no | yes |
| `eleven_v3` | Expressive, audio tags | 5,000 | no | no | no |
| `eleven_v3_conversational` | v3 tuned for dialogue | 5,000 | no | yes | no |
| `eleven_multilingual_v2` (default) | 29 languages | 10,000 | yes | yes | yes |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` | Low latency, 32 languages | 40,000 | no | no | yes |
| `eleven_flash_v2`, `eleven_turbo_v2` | English only | 30,000 | no | no | yes |

```bash
multix elevenlabs tts --model eleven_v4 --text "[warmly] Xin chào!" --language-code vi
multix elevenlabs tts --model eleven_v4_turbo --text "Hello" --timestamps --format wav_24000
multix elevenlabs models   # live capabilities, languages, text limit, credit multiplier
```

The CLI checks options against the model before sending anything. A non-zero
`--style` on a model without style control, `--previous-text`/`--next-text` on
`eleven_v3`, or text over the model's limit is rejected with the models that do
support it. `--style 0` or `--no-speaker-boost` on a model without that control
is reported as a warning and not sent. Audio tags such as `[whispering]` are
performed by v3 and v4; other models read them aloud, so the CLI warns. The API
itself rejects a `--language-code` the model does not support; nothing is
billed. An unknown `--model` id is passed through unchecked with a warning.

`--timestamps` saves character timings next to the audio as
`<audio>.timestamps.json`. TTS also accepts `wav_*`, `opus_48000_*`,
`alaw_8000`, `mp3_24000_48`, `pcm_32000` and `pcm_48000` formats.

After each run the CLI prints the credits ElevenLabs reports in its
`character-cost` header. With `--json` the same number is `usage.credits`, and
`usage.sources.credits` names the header. The CLI never presents an estimate
as credits charged.

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
