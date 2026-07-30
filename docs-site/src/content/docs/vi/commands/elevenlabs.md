---
title: Lệnh ElevenLabs
description: Làm việc với voice, speech, transcription, audio generation và dubbing bất đồng bộ.
---

Lệnh ElevenLabs cần `ELEVENLABS_API_KEY`.

## Voice workflow và speech

List voice của account hoặc tìm public library trước khi dùng voice ID cho TTS
hay speech-to-speech. Voice design gồm hai bước: `design` tạo preview và trả
generated voice ID; `create-from-preview` lưu preview đã chọn vào account.

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

`tts` trả audio đồng bộ. Input clone là audio local và nên dài tổng cộng từ
một đến ba phút.

## Transcription và audio generation

```bash
multix elevenlabs transcribe --input interview.mp3 --diarize --format srt
multix elevenlabs sfx --text "Car engine starting" --duration-seconds 5
multix elevenlabs music --prompt "Dreamy synthwave loop" --output music.mp3
multix elevenlabs isolate --input noisy.wav --output clean.wav
multix elevenlabs align --input narration.mp3 --text-file transcript.txt
```

## Job dubbing

`dub` là bất đồng bộ. Dùng `--async` để nhận dubbing ID ngay, rồi tải track
ngôn ngữ đã xong qua `dub-status`.

```bash
multix elevenlabs dub --input video.mp4 --target-lang es --async
multix elevenlabs dub-status <dubbingId> --download es --output video-es.mp4
```

Hoặc `dub --download` sẽ đợi job xong trước khi tải.
