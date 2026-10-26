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

### Model TTS và tùy chọn theo model

| Model | Số ký tự tối đa | Voice settings model dùng | Ghi chú |
|---|---|---|---|
| `eleven_v4` | 10.000 | `--stability`, `--similarity-boost`, `--clone-strength` | Chất lượng cao nhất, audio tags, hơn 90 ngôn ngữ |
| `eleven_v4_turbo` | 10.000 | `--stability`, `--similarity-boost`, `--clone-strength` | Độ trễ thấp, chi phí ký tự bằng một nửa v4 |
| `eleven_v3` | 5.000 | `--stability`, `--similarity-boost` | Audio tags; không có `--previous-text`/`--next-text` |
| `eleven_multilingual_v2` (mặc định) | 10.000 | tất cả trừ `--clone-strength` | Bỏ qua `--language-code` |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` | 40.000 | `--stability`, `--similarity-boost` | Độ trễ thấp |
| `eleven_flash_v2`, `eleven_turbo_v2` | 30.000 | `--stability`, `--similarity-boost` | Chỉ tiếng Anh |

```bash
multix elevenlabs tts --model eleven_v4 --language-code vi \
  --text "[whispers] Giữ bí mật nhé. [sighs] Họ sẽ không hỏi lịch sự vậy đâu." --output line.mp3
multix elevenlabs tts --model eleven_v4_turbo --text "Xin chào." --timestamps
multix elevenlabs models   # catalog model live
```

`tts` kiểm tra tùy chọn theo model trước khi gọi API, nên cấu hình sai không
tốn phí:

- Eleven v4 và v4 Turbo từ chối `--style` và `--no-speaker-boost`; API sẽ nhận
  rồi âm thầm bỏ qua chúng. `--clone-strength` (0 đến 1, nên bắt đầu từ 0) chỉ
  có tác dụng với Professional Voice Clone đã fine-tune cho v4.
- `--previous-text`/`--next-text` báo lỗi với `eleven_v3`, vì API từ chối.
- Với các model cũ, tùy chọn model không dùng chỉ in cảnh báo và vẫn được gửi,
  nên script hiện có chạy như trước.
- Audio tags như `[whispers]` hoạt động trên v4, v4 Turbo và v3; model khác sẽ
  nhận cảnh báo rằng tag có thể bị đọc thành lời. v4 và v3 không hỗ trợ SSML
  `<break>`; dùng dấu câu hoặc audio tags, và IPA giữa hai dấu gạch chéo trên v4.

`--timestamps` lưu thời điểm từng ký tự vào `<audio>.alignment.json` cạnh file
audio. Mỗi lần chạy `tts` in số ký tự ElevenLabs báo trong header
`character-cost`; với `--json`, con số đó là `usage.credits`, còn
`usage.metrics["header.character-cost"]` ghi rõ nguồn.

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
