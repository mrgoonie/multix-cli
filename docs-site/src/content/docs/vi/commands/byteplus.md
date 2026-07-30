---
title: Lệnh BytePlus
description: Dùng BytePlus ModelArk cho ảnh Seedream, video Seedance, reference video và asset 3D.
---

Lệnh BytePlus cần `BYTEPLUS_API_KEY` (hoặc fallback `ARK_API_KEY`).

## Ảnh Seedream

```bash
multix byteplus generate \
  --prompt "Studio product photo" --size 2K --aspect-ratio 16:9 \
  --output product.png

multix byteplus i2i \
  --prompt "Make it cyberpunk" --ref ./photo.jpg --output cyberpunk.png
```

Hai lệnh ảnh nhận nhiều ảnh tham chiếu local hoặc URL qua `--input-image` hoặc
`--ref` khi option tương ứng được dùng.

## Video Seedance

Text-to-video, image-to-video và reference-to-video có thể chạy đến khi hoàn
tất hoặc submit task với `--async`. Giữ task ID rồi dùng `status` để poll hoặc
tải MP4.

```bash
multix byteplus video --prompt "Ocean waves" --resolution 1080p --duration 8 --async
multix byteplus i2v ./photo.jpg --prompt "Camera pans left" --async

multix byteplus r2v \
  --prompt "A product reveal" \
  --ref-image ./hero.jpg:subject \
  --ref-video ./motion.mp4:reference --async

multix byteplus status <taskId> --wait --download --output reveal.mp4
```

Reference video nhận tối đa chín ảnh, ba video, ba audio và tối đa mười hai
tham chiếu tổng cộng. Dùng cú pháp `path:role`; escape dấu hai chấm literal
bằng `\:`.

## 3D

```bash
multix byteplus 3d \
  --input-image ./front.png ./side.png \
  --prompt "Generate a 3D asset" --async
```

`generate-3d` (alias `3d`) nhận từ một đến năm ảnh tham chiếu local hoặc URL;
lệnh in task ID khi submit bất đồng bộ.
