---
title: Lệnh fal.ai
description: Chạy bất kỳ model queue nào của fal.ai, upload media local, gửi job không cần chờ, hoặc dùng lệnh tiện lợi image/video.
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

## File local

Model nhận media qua URL (`video_url`, `image_url`, `audio_url`, ...).
`--file field=path` upload một file local lên fal storage (cùng luồng upload
với `@fal-ai/client` chính thức) rồi đặt URL trả về vào `field` trong input.
Cờ này dùng được với `run` và `submit`, lặp lại được, và nhận đường dẫn có dấu
chấm cho field lồng nhau (`refs.0.image_url`). Giá trị đã là URL `http(s)://`
hoặc data URI `data:` được dùng nguyên trạng. Chỉ file bạn chỉ định mới được
upload; JSON input không bao giờ bị quét để tìm đường dẫn.

```bash
multix fal run fal-ai/mmaudio-v2 \
  --input '{"prompt":"rain on a tin roof","duration":8}' \
  --file video_url=./shot.mp4
```

Chỉ lấy URL (JSON ra stdout, tiến trình ra stderr):

```bash
multix fal upload ./shot.mp4 [--expires-in 1d]
# {"url":"https://v3.fal.media/files/...","file_name":"shot.mp4","mime_type":"video/mp4","size_bytes":1234}
```

- Ai có URL trả về cũng đọc được file. fal giữ file theo thời hạn mặc định
  của họ, trừ khi `--expires-in` yêu cầu xóa sau `1h`, `1d`, `7d`, `30d`, `1y`
  hoặc một số giây; multix không tự xóa file đã upload. Đừng upload media bạn
  không được phép chia sẻ với fal.
- File phải đọc được, không rỗng và tối đa 2 GiB. File được stream từ đĩa,
  không nạp toàn bộ vào RAM; file trên 90 MB được upload theo từng phần 10 MB.
  Content type lấy theo phần mở rộng (`application/octet-stream` nếu không rõ).
- Key chỉ được gửi tới `https://rest.fal.ai` để khởi tạo upload; dữ liệu được
  gửi tới signed upload URL do fal trả về, không kèm key. Signed URL không bao
  giờ được in ra. Lỗi mạng và phản hồi 5xx/429 được thử lại tối đa 3 lần.
- Mọi đường dẫn được kiểm tra trước lần upload đầu tiên, nên gõ sai sẽ báo lỗi
  trước khi có file nào rời khỏi máy.

## Gửi job không chờ

`submit` nhận cùng các cờ `--input` / `--file`, trả về ngay khi fal chấp nhận
job và in receipt JSON:

```bash
multix fal submit fal-ai/hunyuan-video-foley \
  --input @foley.json --file video_url=./shot.mp4 [--receipt ./shot.job.json]
```

```json
{
  "schema": "multix.fal.job/v1",
  "provider": "fal",
  "model": "fal-ai/hunyuan-video-foley",
  "request_id": "...",
  "status": "IN_QUEUE",
  "submitted_at": "2026-10-25T16:00:00.000Z",
  "input_hash": "sha256:...",
  "status_url": "https://queue.fal.run/...",
  "response_url": "https://queue.fal.run/...",
  "uploaded_fields": ["video_url"],
  "receipt_path": "/home/me/.multix/fal-jobs/<request_id>.json"
}
```

Receipt được lưu trước khi in ra, trong `~/.multix/fal-jobs/` (đổi bằng
`MULTIX_FAL_JOBS_DIR`), với quyền 0600. Receipt không chứa key hay input, chỉ
có hash của input. `run` cũng lưu receipt ngay sau khi submit, nên một lần chạy
bị dừng hoặc timeout vẫn lấy kết quả được về sau.
`multix fal jobs [--limit 20]` liệt kê các receipt đã lưu, mới nhất trước.

Việc submit không bao giờ được thử lại. Nếu kết nối hỏng sau khi request đã
gửi đi, lệnh báo `unknown_remote_state` (mã lỗi `UNKNOWN_REMOTE_STATE`): fal có
thể đã nhận và tính phí job, nên hãy kiểm tra
[danh sách request trên fal](https://fal.ai/dashboard/requests) trước khi gửi lại.

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

Dùng để lấy kết quả job đã `submit`, resume một job đã submit ở nơi khác, hoặc
sau khi lệnh `run`/`image`/`video` timeout — lỗi timeout luôn kèm request ID
cho chính mục đích này. Hai lệnh này không bao giờ submit gì, nên chạy lại bao
nhiêu lần cũng an toàn.

```bash
multix fal status [<model>] <requestId>
multix fal result [<model>] <requestId> [--download] [--output-dir <dir>]
```

Có thể bỏ model khi receipt của request đã được lưu. `status` báo trạng thái
queue của fal (`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`); `result` báo lỗi khi
job vẫn đang chạy. Cả hai cập nhật receipt đã lưu.

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
- Trích xuất media ưu tiên các field kết quả đã biết (`images[].url`,
  `video.url`, `image.url`, `audio.url`) trước khi rơi về quét chung toàn bộ
  payload kết quả.
