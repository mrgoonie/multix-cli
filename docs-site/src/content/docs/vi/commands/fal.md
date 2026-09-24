---
title: Lệnh fal.ai
description: Chạy bất kỳ model queue nào của fal.ai, hoặc dùng lệnh tiện lợi image/video với default hợp lý.
---

Lệnh fal.ai cần `FAL_KEY`. `run` hoạt động với bất kỳ fal model id nào;
`image` và `video` đặt sẵn default hợp lý và tự động download media.

```bash
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}'
multix fal run fal-ai/flux/schnell --input @input.json
```

`--input` nhận JSON inline hoặc `@path/to/file.json`. Mặc định lệnh sẽ poll
đến khi hoàn thành và download mọi media URL tìm thấy trong kết quả;
`--no-download` in kết quả JSON thay vì download.

## Ảnh

```bash
multix fal image "a cyberpunk cat" \
  [-m <model>] [--image-size square_hd] [-n 1] [--seed <n>] \
  [--negative-prompt <text>] [--output <path>] [--no-download] [-v]
```

Model mặc định là `fal-ai/flux/schnell` (ghi đè bằng `-m` hoặc `FAL_IMAGE_MODEL`).

## Video

```bash
multix fal video "a dancer under neon lights" \
  [-m <model>] [--image-url <https-url>] [--duration <n>] \
  [--aspect-ratio 16:9] [--seed <n>] [--no-download] [--wait-timeout 900000] [-v]
```

Nếu không truyền `-m`, model mặc định phụ thuộc vào `--image-url`:

- Text-to-video: `fal-ai/kling-video/v1.6/standard/text-to-video` (ghi đè bằng `FAL_VIDEO_MODEL`).
- Image-to-video (khi có `--image-url`): `fal-ai/kling-video/v1.6/standard/image-to-video` (ghi đè bằng `FAL_VIDEO_IMAGE_MODEL`).

## Status và result

Dùng để resume một job đã submit ở nơi khác, hoặc sau khi lệnh
`run`/`image`/`video` timeout — lỗi timeout luôn kèm request ID cho chính
mục đích này.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download]
```

`<model>` chỉ cần resolve đúng fal "app id" (hai segment đầu tiên trong path,
ví dụ `fal-ai/kling-video`); model id đầy đủ dùng cho `run`, `image`, `video`
cũng dùng được ở đây.

## Ghi chú

- Auth header là `Authorization: Key <FAL_KEY>`; base URL là
  `https://queue.fal.run` (ghi đè bằng `FAL_BASE_URL`).
- Submit dùng model id đầy đủ; endpoint status/result của queue lại dùng app id
  (owner/alias).
- Polling bị giới hạn bởi `--wait-timeout` (deadline theo thời gian thực, đơn
  vị mili-giây) và tự retry lỗi network/5xx tạm thời. Khi timeout hoặc gặp lỗi
  không khôi phục được, lệnh in request ID để bạn resume bằng
  `multix fal status` hoặc `multix fal result`.
- Trích xuất media ưu tiên các field kết quả đã biết (`images[].url`,
  `video.url`, `image.url`, `audio.url`) trước khi rơi về quét chung toàn bộ
  payload kết quả.
