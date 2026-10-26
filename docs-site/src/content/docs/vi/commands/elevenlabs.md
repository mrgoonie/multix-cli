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

## Model TTS và tùy chọn

| Model | Dùng cho | Số ký tự tối đa | Style | Speaker boost | Previous/next text |
|---|---|---|---|---|---|
| `eleven_v4` | Chất lượng cao nhất, hơn 90 ngôn ngữ, audio tag | 10.000 | không | không | có |
| `eleven_v4_turbo` | Chất lượng v4 với độ trễ thấp, 0,5 credit mỗi ký tự | 10.000 | không | không | có |
| `eleven_v3` | Biểu cảm, audio tag | 5.000 | không | không | không |
| `eleven_v3_conversational` | v3 tối ưu cho hội thoại | 5.000 | không | có | không |
| `eleven_multilingual_v2` (mặc định) | 29 ngôn ngữ | 10.000 | có | có | có |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` | Độ trễ thấp, 32 ngôn ngữ | 40.000 | không | không | có |
| `eleven_flash_v2`, `eleven_turbo_v2` | Chỉ tiếng Anh | 30.000 | không | không | có |

```bash
multix elevenlabs tts --model eleven_v4 --text "[warmly] Xin chào!" --language-code vi
multix elevenlabs tts --model eleven_v4_turbo --text "Hello" --timestamps --format wav_24000
multix elevenlabs models   # live: khả năng, ngôn ngữ, giới hạn ký tự, hệ số credit
```

CLI kiểm tra tùy chọn theo model trước khi gửi request. `--style` khác 0 trên
model không có style, `--previous-text`/`--next-text` với `eleven_v3`, hoặc text
dài hơn giới hạn của model sẽ bị từ chối kèm danh sách model hỗ trợ.
`--style 0` hoặc `--no-speaker-boost` trên model không có điều khiển đó được báo
bằng cảnh báo và không gửi đi. Audio tag như `[whispering]` được v3 và v4 thể
hiện; model khác sẽ đọc thành tiếng nên CLI cảnh báo. Chính API từ chối
`--language-code` mà model không hỗ trợ, và không tính phí. `--model` lạ được
gửi nguyên trạng, không kiểm tra, kèm cảnh báo.

`--timestamps` lưu thời gian từng ký tự cạnh file audio thành
`<audio>.timestamps.json`. TTS còn nhận các format `wav_*`, `opus_48000_*`,
`alaw_8000`, `mp3_24000_48`, `pcm_32000` và `pcm_48000`.

Sau mỗi lần chạy, CLI in số credit ElevenLabs báo qua header `character-cost`.
Với `--json`, số này nằm ở `usage.credits` và `usage.sources.credits` ghi tên
header. CLI không bao giờ trình bày số ước tính như credit đã trừ.

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
