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

| Model | Dùng cho | Số ký tự tối đa | Style | Speaker boost | Clone strength | Previous/next text | SSML `<break>` | SSML `<phoneme>` |
|---|---|---|---|---|---|---|---|---|
| `eleven_v4` | Chất lượng cao nhất, hơn 90 ngôn ngữ, audio tag | 10.000 | không | không | có | có | không | có |
| `eleven_v4_turbo` | Chất lượng v4 với độ trễ thấp, 0,5 credit mỗi ký tự | 10.000 | không | không | có | có | không | có |
| `eleven_v3` | Biểu cảm, audio tag | 5.000 | không | không | không | không | không | có |
| `eleven_v3_conversational` | v3 tối ưu cho hội thoại | 5.000 | không | có | không | không | không | có |
| `eleven_multilingual_v2` (mặc định) | 29 ngôn ngữ | 10.000 | có | có | không | có | có | không |
| `eleven_flash_v2_5`, `eleven_turbo_v2_5` | Độ trễ thấp, 32 ngôn ngữ | 40.000 | không | không | không | có | có | không |
| `eleven_flash_v2`, `eleven_turbo_v2` | Chỉ tiếng Anh | 30.000 | không | không | không | có | có | có |

```bash
multix elevenlabs tts --model eleven_v4 --text "[warmly] Xin chào!" --language-code vi
multix elevenlabs tts --model eleven_v4_turbo --text "Hello" --timestamps --format wav_24000
multix elevenlabs tts --model eleven_v4 --voice <pvc-voice-id> --clone-strength 0.3 --text "Hello"
multix elevenlabs models   # live: khả năng, ngôn ngữ, giới hạn ký tự, hệ số credit
```

CLI kiểm tra tùy chọn theo model trước khi gửi request:

- Từ chối, kèm danh sách model hỗ trợ: `--style` khác 0 trên model không có
  style (Flash v2.5 trả 200 cho `style` 0.8 và tính phí cho audio bỏ qua nó),
  `--clone-strength` ngoài v4 và v4 Turbo, `--previous-text`/`--next-text` với
  `eleven_v3`, và text dài hơn giới hạn của model. Giới hạn đếm theo ký tự (code
  point) như ElevenLabs, nên ký tự astral như `𠀀` chỉ tính một, còn emoji ghép
  từ nhiều code point thì tính từng code point.
- Từ chối trước khi gửi request: `--voice` không phải voice ID (chữ, số, `_`
  hoặc `-`).
- Cảnh báo và không gửi: `--style 0` hoặc `--no-speaker-boost` trên model không
  có điều khiển đó.
- Cảnh báo, text vẫn gửi nguyên: audio tag như `[whispering]` trên model đọc
  chúng thành tiếng (mọi model trừ v3 và v4), SSML `<break>` trên v4, v4 Turbo,
  v3 và v3 conversational (bị bỏ qua, không ngắt nghỉ), và SSML `<phoneme>` trên
  multilingual v2 và Flash/Turbo v2.5 (từ nằm trong tag bị bỏ thay vì được đọc).
- Để API quyết định: `--language-code`. API từ chối mã mà model không hỗ trợ, và
  không tính phí. Với `eleven_multilingual_v2`, mã vẫn được gửi kèm cảnh báo: API
  nhận các mã trong danh sách của model, nhưng tài liệu API ghi model này không
  áp dụng tham số đó.
- `--model` lạ được gửi nguyên trạng, không kiểm tra, kèm cảnh báo.

`--clone-strength` (0 đến 1) đặt mức v4 bám theo Professional Voice Clone.

`--timestamps` lưu thời gian từng ký tự cạnh file audio thành
`<audio>.timestamps.json`. Nếu response đã tính phí mà không có audio, body gốc
được lưu thành `elevenlabs_tts_raw_<stamp>.bin`, số credit đã báo vẫn được in ra,
và thông báo lỗi nêu tên file đó.

TTS còn nhận các format `wav_*`, `opus_48000_*`, `alaw_8000`, `mp3_24000_48`,
`pcm_32000` và `pcm_48000`.

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
