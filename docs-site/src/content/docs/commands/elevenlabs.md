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
