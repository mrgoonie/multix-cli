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
đến khi hoàn thành và download mọi media URL tìm thấy trong kết quả vào
`MULTIX_OUTPUT_DIR` (hoặc `--output-dir <dir>`); `--no-download` in kết quả
JSON thay vì download.

## File cục bộ

`run --file key=path` gán file cho field `key` ở cấp cao nhất của input. Đường
dẫn cục bộ được kiểm tra (tồn tại, đọc được, không rỗng) rồi upload lên fal
storage, và field nhận URL đã host; URL `http(s)` hoặc `data:` URI được giữ
nguyên. Flag này lặp lại được và ghi đè key trùng tên trong `--input`. Không
có file nào được upload nếu bạn không chỉ định bằng `--file`.

```bash
# Thêm âm thanh cho clip câm bằng MMAudio
multix fal run fal-ai/mmaudio-v2 \
  --input '{"prompt":"rain on a tin roof","duration":2}' \
  --file video_url=./shot.mp4

# Tạo foley cho clip bằng Hunyuan Video Foley
multix fal run fal-ai/hunyuan-video-foley \
  --input '{"text_prompt":"footsteps on gravel"}' \
  --file video_url=./shot.mp4
```

## Upload

```bash
multix fal upload <file> [--content-type <mime>] [--expires-in <ttl>] [-v]
```

Upload một file cục bộ và in JSON ra stdout (log ra stderr): `url`,
`file_name`, `mime_type`, `size_bytes`, kèm `expires_in_s` khi có
`--expires-in`. Dùng `url` cho bất kỳ field input nào của fal như `video_url`
hoặc `image_url`.

- `--content-type` ghi đè MIME type đoán từ phần mở rộng của file.
- `--expires-in` yêu cầu fal xoá file sau `1h`, `1d`, `7d`, `30d`, `1y`, hoặc
  một số giây; `never` không gửi thời hạn. Nếu không truyền, áp dụng thời gian
  lưu trữ mặc định của fal. multix không bao giờ tự xoá file đã upload.

**Quyền riêng tư:** ai có URL fal storage đều đọc được file. Chỉ upload file
bạn chấp nhận chia sẻ theo cách đó, và giữ URL cẩn thận như chính file.

Mọi upload (từ `upload` và `--file`) luôn đi tới `https://rest.fal.ai`, nơi
nhận `FAL_KEY` để khởi tạo upload; dữ liệu được gửi tới signed upload URL mà
nó trả về, không kèm key, và redirect tại đó bị từ chối. File lớn hơn 90 MB
được gửi theo từng phần 10 MB. Lỗi network và phản hồi 5xx (trừ 501 và 505)
được retry, tối đa 3 lần mỗi request.

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

## Chạy detach và receipt

```bash
multix fal run <model> --input <json> [--file key=path] --detach [--receipt <path>]
```

`--detach` trả về ngay khi queue nhận job. stdout là một receipt JSON (schema
`multix.fal-receipt/v1`) gồm model, `request_id`, trạng thái, vị trí trong
queue, thời điểm submit, `input_hash` (sha256 của input, để phát hiện submit
trùng) và các lệnh status/result trong `next`. Receipt không bao giờ chứa key,
input hay signed URL.

Receipt được lưu vào `~/.multix/fal/requests/<request_id>.json` (thư mục
0700, file 0600, ghi nguyên tử), hoặc vào `--receipt <path>`. Lúc đó job đã
vào queue và đã bị tính phí, nên nếu lưu thất bại receipt vẫn được in ra kèm
cảnh báo: hãy giữ lại `request_id`.

## Status và result

Dùng để resume một job chạy detach, một job đã submit ở nơi khác, hoặc sau
khi lệnh `run`/`image`/`video` timeout — lỗi timeout luôn kèm request ID cho
chính mục đích này.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>]
```

`result` chỉ đọc: không bao giờ submit lại job. Nếu job vẫn đang trong queue
hoặc đang chạy, lệnh báo lỗi `JOB_PENDING` kèm trạng thái queue; hãy kiểm tra
lại bằng `status`.

`<model>` chỉ cần resolve đúng fal "app id" (hai segment đầu tiên trong path,
ví dụ `fal-ai/kling-video`); model id đầy đủ dùng cho `run`, `image`, `video`
cũng dùng được ở đây.

## Ghi chú

- Auth header là `Authorization: Key <FAL_KEY>`; base URL là
  `https://queue.fal.run` (ghi đè bằng `FAL_BASE_URL`).
- Submit dùng model id đầy đủ; endpoint status/result của queue lại dùng app id
  (owner/alias).
- Key chỉ được gửi tới `status_url` / `response_url` trong response của submit
  khi URL có cùng origin (scheme, host và port) với `FAL_BASE_URL`, hoặc là
  `https://queue.fal.run` với port mặc định. URL khác bị từ chối bằng lỗi
  provider nêu tên host, trước khi key được gửi. Response của submit thiếu các
  URL này cũng báo lỗi provider.
- Polling bị giới hạn bởi `--wait-timeout` (deadline theo thời gian thực, đơn
  vị mili-giây) và tự retry lỗi network và phản hồi 5xx tạm thời (trừ 501 và 505). Khi timeout hoặc gặp lỗi
  không khôi phục được, lệnh in request ID để bạn resume bằng
  `multix fal status` hoặc `multix fal result`.
- fal không có idempotency key, nên multix không thể đảm bảo job chỉ chạy
  đúng một lần. Nếu submit không nhận được phản hồi HTTP (trừ lỗi DNS hoặc bị
  từ chối kết nối), job có thể đã tồn tại và bị tính phí: lệnh báo lỗi
  `UNKNOWN_REMOTE_STATE`. Hãy kiểm tra
  [danh sách request trên fal](https://fal.ai/dashboard/requests) trước khi
  submit lại.
- Trích xuất media ưu tiên các field kết quả đã biết (`images[].url`,
  `video.url`, `image.url`, `audio.url`) trước khi rơi về quét chung toàn bộ
  payload kết quả.
