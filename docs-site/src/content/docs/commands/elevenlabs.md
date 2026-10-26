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

| Model | Use | Max characters | Style | Speaker boost | Clone strength | Previous/next text | SSML `<break>` | SSML `<phoneme>` |
|---|---|---|---|---|---|---|---|---|
| `eleven_v4` | Highest quality, 90+ languages, audio tags | 10,000 | no | no | yes | yes | no | yes |
| `eleven_v4_turbo` | v4 quality at low latency, 0.5 credits per character | 10,000 | no | no | yes | yes | no | yes |
| `eleven_v3` | Expressive, audio tags | 5,000 | no | no | no | no | no | yes |
| `eleven_v3_conversational` | v3 tuned for dialogue | 5,000 | no | yes | no | no | no | yes |
| `eleven_multilingual_v2` (default) | 29 languages | 10,000 | yes | yes | no | yes | yes | no |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` | Low latency, 32 languages | 40,000 | no | no | no | yes | yes | no |
| `eleven_flash_v2`, `eleven_turbo_v2` | English only | 30,000 | no | no | no | yes | yes | yes |

```bash
multix elevenlabs tts --model eleven_v4 --text "[warmly] Xin chào!" --language-code vi
multix elevenlabs tts --model eleven_v4_turbo --text "Hello" --timestamps --format wav_24000
multix elevenlabs tts --model eleven_v4 --voice <pvc-voice-id> --clone-strength 0.3 --text "Hello"
multix elevenlabs models   # live capabilities, languages, text limit, credit multiplier
```

The CLI checks options against the model before sending anything:

- Rejected, with the models that do support it: a non-zero `--style` on a model
  without style control (Flash v2.5 answered `style` 0.8 with 200 and billed
  for audio that ignores it), `--clone-strength` outside v4 and v4 Turbo, `--previous-text`/`--next-text`
  on `eleven_v3`, and text over the model's limit. The limit counts characters
  (code points) as ElevenLabs does, so an astral character such as `𠀀` counts
  once, while an emoji built from several code points counts each of them.
- Rejected before the request: a `--voice` that is not a voice ID (letters,
  digits, `_` or `-`).
- Warned and not sent: `--style 0` or `--no-speaker-boost` on a model without
  that control.
- Warned, text sent as is: audio tags such as `[whispering]` on models that read
  them aloud (all but v3 and v4), SSML `<break>` on v4, v4 Turbo, v3 and v3
  conversational (skipped without a pause), and SSML `<phoneme>` on multilingual
  v2 and Flash/Turbo v2.5 (the tagged word is dropped instead of spoken).
- Left to the API: `--language-code`. It rejects a code the model does not
  support, and nothing is billed. On `eleven_multilingual_v2` the code is sent
  with a warning: the API accepts the codes on its list, but its reference says
  that model does not enforce the parameter.
- An unknown `--model` id is passed through unchecked with a warning.

`--clone-strength` (0 to 1) sets how closely v4 follows a Professional Voice
Clone.

`--timestamps` saves character timings next to the audio as
`<audio>.timestamps.json`. If a billed response carries no audio, its raw body
is saved as `elevenlabs_tts_raw_<stamp>.bin`, the reported credits are still
printed, and the error names that file.

TTS also accepts `wav_*`, `opus_48000_*`, `alaw_8000`, `mp3_24000_48`,
`pcm_32000` and `pcm_48000` formats.

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
