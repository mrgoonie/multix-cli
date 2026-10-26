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

## Model TTS và voice settings

`--model` nhận `eleven_multilingual_v2` (mặc định), `eleven_v4`,
`eleven_v4_turbo`, `eleven_v3`, `eleven_v3_conversational` và các model
Flash/Turbo v2. Eleven v4 là model chất lượng cao nhất (hơn 90 ngôn ngữ, audio
tag như `[whispering]`); Eleven v4 Turbo là bản độ trễ thấp và chỉ tính một nửa
số ký tự.

```bash
multix elevenlabs tts --model eleven_v4 --text "[whispering] Can you keep a secret?"
multix elevenlabs tts --model eleven_v4_turbo --text "Xin chào!" --similarity-boost 0.8 --timestamps
multix elevenlabs models   # catalog live: ngôn ngữ, giới hạn ký tự, hệ số chi phí
```

API chấp nhận cả voice setting mà model không dùng rồi bỏ qua nó, nên `tts` từ
chối flag đó trước khi gửi request:

| Model | Voice settings | Số ký tự tối đa | Audio tag | SSML |
|---|---|---|---|---|
| `eleven_v4`, `eleven_v4_turbo` | `--stability`, `--similarity-boost`, `--clone-strength` | 10.000 | có | không |
| `eleven_v3` | `--stability`, `--similarity-boost` | 5.000 | có | không |
| `eleven_v3_conversational` | `--stability`, `--similarity-boost`, `--speaker-boost` | 5.000 | có | không |
| `eleven_multilingual_v2` | `--stability`, `--similarity-boost`, `--style`, `--speaker-boost`, `--speed` | 10.000 | không | có |
| Flash/Turbo v2.5 | `--stability`, `--similarity-boost`, `--speed` | 40.000 | không | có |
| Flash/Turbo v2 | `--stability`, `--similarity-boost`, `--speed` | 30.000 | không | có |

`--clone-strength` chỉ áp dụng cho Professional Voice Clone đã fine-tune cho v4.
Model v2 và v3 giữ giá trị mặc định cũ (stability 0.5, similarity 0.75); v4 chỉ
gửi những setting bạn truyền vào, nên setting đã lưu của voice được áp dụng.
Audio tag trên model không đọc được tag, hoặc SSML trên v3/v4, sẽ in cảnh báo.
Model ID không có trong danh sách được gửi nguyên trạng kèm cảnh báo.

`--language-code` nhận mã ISO 639-1; ElevenLabs từ chối mã mà model không hỗ
trợ (kể cả mọi mã trên `eleven_multilingual_v2`). `--timestamps` lưu thêm
timing theo từng ký tự cạnh file audio dưới dạng `<audio>.alignment.json`.
`--format` nhận các biến thể MP3, PCM, WAV, Opus, μ-law và A-law
(`wav_44100`, `opus_48000_64`, ...).

Sau mỗi request, `tts` in số ký tự ElevenLabs đã tính phí, đọc từ header
`character-cost` của response. Với `--json`, con số này nằm ở `usage.credits`,
và `usage.credits_source` là `header.character-cost`.

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
