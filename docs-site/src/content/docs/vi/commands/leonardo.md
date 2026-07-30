---
title: Lệnh Leonardo
description: Tạo ảnh/video Leonardo, xem job và dùng image ID có sẵn cho image workflow.
---

Lệnh Leonardo cần `LEONARDO_API_KEY`. Bắt đầu bằng account và model discovery
khi cần chọn ID:

```bash
multix leonardo me
multix leonardo models --limit 20
multix leonardo video-models
```

## Ảnh

```bash
multix leonardo generate "A cyberpunk cat" \
  --width 1024 --height 1024 --output cat.png
```

`image-to-image` (alias `i2i`) nhận Leonardo image ID đã tồn tại trong `--ref`,
không nhận local file. Chỉ dùng `--image-type UPLOADED` khi ID đó là ảnh upload
trên Leonardo.

```bash
multix leonardo i2i \
  --ref <imageId> --prompt "Make it watercolor" \
  --init-strength 0.5 --output watercolor.png
```

## Video và status

`video` bắt đầu text-to-video. `image-to-video` (alias `i2v`) cũng cần
Leonardo image ID có sẵn. Cả hai có thể trả job ngay, hoặc đợi và download với
`--download` (tự thêm `--wait`).

```bash
multix leonardo video "A dancer in a studio" --model MOTION2
multix leonardo i2v <imageId> --prompt "Camera pans left" --download --output dancer.mp4
multix leonardo status <generationId> --download --output ./assets
```

Dùng `upscale <generatedImageId>` để tạo upscale variation và
`variation <variationId>` để lấy kết quả.
