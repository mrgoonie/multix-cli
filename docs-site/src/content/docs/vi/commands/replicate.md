---
title: Lệnh Replicate
description: Chạy bất kỳ model Replicate nào qua API trực tiếp, tạo ảnh và video, tiếp tục hoặc hủy prediction theo ID.
---

Lệnh Replicate gọi trực tiếp Replicate API (`https://api.replicate.com/v1`)
và cần `REPLICATE_API_TOKEN` (chấp nhận `REPLICATE_API_KEY` làm phương án dự
phòng). Các lệnh này độc lập với `multix cloudflare generate-video`, vốn gọi
Replicate thông qua Cloudflare AI Gateway.

## Chạy bất kỳ model nào

```bash
# Model chính thức (owner/name) — dùng endpoint predictions của model
multix replicate run black-forest-labs/flux-schnell --input '{"prompt":"a cyberpunk cat"}'

# Model cộng đồng ghim theo version — dùng POST /predictions với version đó
multix replicate run owner/model:<version-id> --input @payload.json
multix replicate run owner/model --version <version-id> --input @payload.json

# Gắn file cục bộ vào input của model (có thể lặp lại)
multix replicate run owner/model --input '{"prompt":"..."}' --file image=./photo.png
```

`--input` nhận JSON inline hoặc `@path/to/file.json` và được gửi nguyên vẹn,
nên schema input riêng của từng model đều dùng được. Model chính thức chạy
không cần version; model cộng đồng cần `owner/name:version`, một version ID
đứng riêng, hoặc `--version`.

## Ảnh và video

```bash
multix replicate image "a futuristic city at dusk" \
  [-m <owner/name>] [--aspect-ratio 16:9] [-n 1] [--seed <n>] \
  [--output-format webp|jpg|png] [--input '{"go_fast":false}'] [--output <path>]

multix replicate video "a cinematic establishing shot" \
  [-m <owner/name>] [--image <path|url>] [--duration 5] [--aspect-ratio 16:9] \
  [--resolution 720p] [--seed <n>] [--input '{"draft":true}'] [--async]
```

| Lệnh | Model mặc định | Ghi đè |
| --- | --- | --- |
| `image` | `black-forest-labs/flux-schnell` | `-m` hoặc `REPLICATE_IMAGE_MODEL` |
| `video` | `prunaai/p-video` (text-to-video, hoặc image-to-video khi có `--image`) | `-m` hoặc `REPLICATE_VIDEO_MODEL` |

Các flag của lệnh tiện lợi ánh xạ sang tên input phổ biến (`prompt`,
`aspect_ratio`, `num_outputs`, `seed`, `output_format`, `duration`,
`resolution`, `image`). Dùng `--input` cho các trường khác, `--image-key` khi
model đặt tên input ảnh khác đi, hoặc `replicate run` cho schema tùy biến hoàn
toàn.

`replicate image` mặc định chuyển ảnh đã lưu sang WebP (`cwebp -q 85`). Định
dạng gốc của provider được giữ nguyên khi bạn truyền `--image-format original`
hoặc `--no-webp`, đặt `MULTIX_IMAGE_FORMAT=original`, truyền `--output-format`
một cách tường minh, hoặc dùng `--output` với phần mở rộng ảnh khác `.webp`
(ví dụ `cat.png`). Nếu không có `cwebp` trong `PATH`, hoặc ảnh chuyển đổi
không qua bước kiểm tra, file gốc được giữ lại kèm cảnh báo. `replicate run` và
`replicate video` không bao giờ chuyển đổi.

## Job bất đồng bộ: tiếp tục và hủy

Mặc định mọi lệnh đều chờ: gửi prediction, poll với back-off đến trạng thái
kết thúc, rồi tải file. `--async` in prediction ID và trả về ngay.

```bash
multix replicate video "a slow pan over mountains" --async
# Prediction submitted: <id> (status: starting)

multix replicate status <id>                       # xem trạng thái một lần (JSON)
multix replicate status <id> --wait --download     # tiếp tục mà không chạy lại
multix replicate cancel <id>
```

- Trạng thái kết thúc gồm `succeeded`, `failed`, `canceled` và `aborted`.
  Chỉ `succeeded` thoát với mã 0; các trạng thái còn lại thoát với mã khác 0
  kèm lỗi từ Replicate. Lệnh `status <id>` xem một lần với job đang chạy thoát
  với mã 0.
- Nếu có file output nào tải về thất bại, các file đã tải được vẫn được giữ,
  nhưng lệnh thoát với mã khác 0 và in `multix replicate status <id> --download`
  để thử lại khi URL còn hiệu lực.
- `--wait-timeout <ms>` giới hạn thời gian poll (mặc định: run 10 phút, image
  5 phút, video 15 phút). Khi hết giờ, CLI in lệnh để tiếp tục; job vẫn chạy.
- `--prefer-wait [seconds]` gửi `Prefer: wait=N` (1–60 giây) để job ngắn có
  thể hoàn tất ngay trong request tạo; nếu job vẫn đang chạy, CLI tiếp tục poll.

## Kết quả

- Output có thể là một URL, danh sách URL, object lồng nhau hoặc văn bản. Mọi
  media URL đều được tải về; giá trị văn bản được in ra.
- File được lưu dạng `replicate-<id8>-NN.<ext>` trong `MULTIX_OUTPUT_DIR`
  (mặc định `./multix-output`), trong đó `<id8>` là 8 ký tự đầu của prediction
  ID. Phần mở rộng lấy từ URL hoặc content type của
  response.
- `--output <file>` lưu một output vào đúng đường dẫn đó (nhiều output sẽ
  thành `<file>-NN.<ext>`); `--output <dir>/` lưu vào thư mục.
- `--no-download` in URL output thay vì tải. URL output của Replicate sẽ hết
  hạn (khoảng một giờ với prediction tạo qua API), nên hãy tải sớm.

## File cục bộ

`--image` và `--file key=path` nhận đường dẫn cục bộ hoặc URL `https://`. File
cục bộ tối đa 256 KB được gửi inline dưới dạng data URI; file lớn hơn được tải
lên qua Replicate Files API. File phải nhỏ hơn 100 MB.

## Lỗi và quyền riêng tư

- Lỗi 401 chỉ ra vấn đề token, 404 chỉ ra model (hoặc thiếu version với model
  cộng đồng), 422 chỉ ra schema input của model, và 429 tuân theo
  `Retry-After`; lỗi mạng, 429 và 5xx được thử lại trong lúc poll.
- Token không bao giờ được ghi log. JSON của `status` bỏ input và log của
  prediction, đồng thời loại bỏ query string đã ký khỏi URL output; log verbose
  cũng được che tương tự.
