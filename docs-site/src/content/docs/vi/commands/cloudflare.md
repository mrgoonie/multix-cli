---
title: Lệnh Cloudflare
description: Tạo ảnh và giọng nói với Workers AI, hoặc submit và lấy video job qua AI Gateway.
---

Lệnh ảnh và speech của Cloudflare cần `CLOUDFLARE_ACCOUNT_ID` và
`CLOUDFLARE_API_TOKEN`. Video cần thêm `CLOUDFLARE_AI_GATEWAY_ID` và
`REPLICATE_API_TOKEN`.

## Ảnh và speech qua Workers AI

`generate` dùng model ảnh FLUX.1 Schnell được hỗ trợ. `--steps` nhận số nguyên
từ 1 đến 8. `generate-speech` trả về audio MPEG qua model MeloTTS được hỗ trợ.

```bash
multix cloudflare generate \
  --prompt "A technical pen drawing of an isometric terminal" \
  --steps 4 --output terminal.jpg

multix cloudflare generate-speech \
  --text "Welcome to multix." --lang en \
  --output welcome.mp3
```

AI Gateway ID là tuỳ chọn cho ảnh và speech. Khi được cấu hình, multix route
các lời gọi Workers AI này qua gateway; thu thập request payload vẫn tắt trừ
khi đặt `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true`.

## Video job qua AI Gateway

`generate-video` tạo prediction `prunaai/p-video` qua Cloudflare AI Gateway.
Không có `--wait`, lệnh in prediction ID. `--download` tự chờ và lưu MP4 đã
hoàn tất.

```bash
multix cloudflare generate-video \
  --prompt "Camera glides through a paper architectural model" \
  --duration 5 --aspect-ratio 16:9 --resolution 720p

multix cloudflare video-status <predictionId> \
  --download --output model-tour.mp4
```

Dùng `multix cloudflare generate-video --help` và `multix cloudflare
video-status --help` trước khi tự động hóa; CLI đang cài là nguồn chuẩn cho
option và default hiện tại.
