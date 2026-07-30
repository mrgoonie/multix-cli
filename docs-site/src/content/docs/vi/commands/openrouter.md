---
title: Lệnh OpenRouter
description: Tạo ảnh qua routing và submit, poll hoặc download job image-to-video.
---

Lệnh OpenRouter cần `OPENROUTER_API_KEY`. Chạy `multix openrouter video-models`
để xem video model ID có sẵn của CLI đang cài.

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
