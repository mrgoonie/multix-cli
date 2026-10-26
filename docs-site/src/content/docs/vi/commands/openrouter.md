---
title: Lệnh OpenRouter
description: Tạo ảnh qua routing, submit, poll hoặc download job image-to-video, chuyển văn bản thành giọng nói và chuyển giọng nói thành văn bản.
---

Lệnh OpenRouter cần `OPENROUTER_API_KEY`. Chạy `multix openrouter video-models`
để xem video model ID có sẵn, `multix openrouter speech-models` để xem
speech model ID và `multix openrouter transcription-models` để xem
transcription model ID.

## Ảnh

```bash
multix openrouter generate \
  --prompt "Retro robot in a rainy city" \
  --model google/gemini-3.1-flash-image-preview \
  --aspect-ratio 16:9 --output robot.png

multix openrouter i2i \
  --prompt "Make it cyberpunk" --ref ./photo.jpg \
  --model google/gemini-2.5-flash-image --output cyberpunk.png
```

Ảnh tham chiếu nhận local path hoặc URL. `--strength` chỉ áp dụng cho model
Recraft i2i. Nếu cấu hình, `OPENROUTER_FALLBACK_MODELS` áp dụng cho generate
và image-to-image.

## Job image-to-video

`image-to-video` (alias `i2v`) là bất đồng bộ. Khung hình đầu và cuối (nếu
có) phải là HTTPS URL, không phải local path. Lưu job ID, sau đó gọi
`video-status`; `--download` tự động đợi job xong.

```bash
multix openrouter i2v \
  --prompt "Camera pans left" \
  --image-url https://example.com/first-frame.jpg \
  --last-frame-url https://example.com/last-frame.jpg \
  --model google/veo-3.1

multix openrouter video-status <jobId> --download --output clip.mp4
```

Để submit và đợi trong một lệnh, thêm `--wait`; `--download` sẽ đợi rồi tải
video hoàn tất.

## Chuyển văn bản thành giọng nói

`tts` gửi một request tới `/api/v1/audio/speech` của OpenRouter. Model mặc
định là `google/gemini-3.8-flash-tts` (đổi bằng `--model` hoặc
`OPENROUTER_TTS_MODEL`). Truyền văn bản bằng `--text` (alias `--prompt`),
`--text-file`, hoặc `--turns-file`: một mảng JSON
`{"text", "voice"?, "instructions"?}` cho model nhiều người nói.

```bash
multix openrouter tts --text "Xin chào" \
  --model google/gemini-3.8-flash-lite-tts --voice Kore --output hello.wav

multix openrouter speech-models                     # catalog trực tiếp
multix openrouter speech-models --model elevenlabs/eleven-v4   # voice của model
multix openrouter generation <generation-id>        # chi phí ghi nhận sau
```

- Model và voice được kiểm tra với speech catalog trực tiếp trước request trả
  phí; sai model hoặc voice sẽ báo lỗi kèm các lựa chọn hợp lệ.
  `--no-model-check` bỏ qua bước này cho model OpenRouter chưa liệt kê.
- Model Google Gemini và ElevenLabs bắt buộc `--voice` (Gemini: `Kore`,
  `Puck`, ...; ElevenLabs: `sarah`, `george`, ...). Fish Audio
  `fish-audio/drama-3` chạy được không cần voice.
- `--format auto` ghi WAV cho model chỉ trả pcm (Gemini, HeyGen) và MP3 cho
  model khác. `wav` là pcm được bọc header WAV ở máy local (24 kHz mono trừ
  khi OpenRouter báo rate khác, hoặc `--sample-rate`). Gemini từ chối `mp3`;
  MiniMax chỉ trả `mp3`.
- `--instructions` chỉnh giọng điệu, tốc độ, cảm xúc khi model hỗ trợ;
  `--provider-options`, `--zdr` và `--deny-data-collection` điều khiển routing.
- Request không bao giờ được thử lại, vì request thứ hai là một lần tạo trả
  phí nữa. Kết nối bị ngắt sau khi OpenRouter có thể đã nhận request sẽ báo
  `UNKNOWN_REMOTE_STATE`; kiểm tra `multix openrouter generation <id>` hoặc
  openrouter.ai/activity trước khi gửi lại.
- Sau khi lưu audio, CLI đợi tối đa `--cost-wait` giây (mặc định 20, tối đa
  120) để OpenRouter báo chi phí; `--no-cost` bỏ qua bước này. Với `--json`,
  kết quả gồm generation ID, chi phí, voice, định dạng, kích thước, SHA-256 và
  thời lượng (chỉ pcm/WAV); giá trị chưa biết là `null`.

## Chuyển giọng nói thành văn bản

`transcribe` gửi một request tới `/api/v1/audio/transcriptions` của
OpenRouter. Model mặc định là `openai/whisper-large-v3-turbo` (đổi bằng
`--model` hoặc `OPENROUTER_STT_MODEL`). `--input` là file audio local, được
upload dạng multipart (tối đa 25 MB), hoặc một URL http(s) công khai để
provider tự tải; không phải provider nào cũng nhận URL. Định dạng lấy từ phần
mở rộng của file hoặc `--audio-format`.

```bash
multix openrouter transcribe --input meeting.mp3 --language en --json

multix openrouter transcription-models              # catalog trực tiếp kèm giá
multix openrouter transcription-models --model google/gemini-3.5-transcribe
```

- Model được kiểm tra với transcription catalog trực tiếp (Whisper, GPT-4o
  transcribe, Gemini Transcribe, ElevenLabs Scribe, Voxtral, Deepgram,
  AssemblyAI, ...) trước request trả phí; `--no-model-check` bỏ qua bước này.
  `multix models --task transcription` cũng liệt kê các model này.
- `--language` nhận mã ISO-639-1; nếu bỏ trống, ngôn ngữ được tự nhận diện.
- Transcript được lưu thành `openrouter_transcript_<stamp>.txt` trong thư mục
  output và sao chép tới `--output` nếu có. Chế độ text chỉ in đường dẫn,
  không bao giờ in nội dung transcript.
- Request không bao giờ được thử lại. Kết nối bị ngắt sau khi đã gửi sẽ báo
  `UNKNOWN_REMOTE_STATE`; kiểm tra `multix openrouter generation <id>` trước
  khi gửi lại.
- `--cost-wait` và `--no-cost` hoạt động như với `tts`. Với `--json`, kết quả
  gồm văn bản, ngôn ngữ nhận diện được, thời lượng audio, generation ID, chi
  phí và nguồn của chi phí, cùng kích thước và SHA-256 của input (URL được
  hiển thị không kèm query string); giá trị chưa biết là `null`.
