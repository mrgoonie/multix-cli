---
title: Lệnh Sume
description: Tạo ảnh và video với bất kỳ model nào trong catalog trực tiếp của Sume, báo giá trước khi gửi, rồi kiểm tra, tiếp tục, tải về hoặc hủy job theo ID.
---

Lệnh Sume gọi trực tiếp REST API gốc của Sume (`https://api.sume.com`).
multix không dùng MCP server do Sume host. Việc tạo nội dung cần `SUME_API_KEY`,
tạo theo hướng dẫn tại [Sume authentication](https://www.sume.com/docs/authentication).
Key chỉ được gửi tới Sume API; hãy giữ key ở phía server.

## Model

```bash
multix sume models                       # mọi model: id, loại, mode, giá niêm yết
multix sume models --kind video          # image | video | lipsync | captions
multix sume models --mode image-to-video
multix sume models --model kling-3       # toàn bộ mục catalog, dạng JSON
multix sume models --refresh             # đọc lại thay vì dùng bản cache
```

Model lấy từ catalog công khai của Sume (`GET /v1/open/catalog`), không cần key
và không mất phí. multix không tự công bố danh sách model hay model mặc định:
truyền đúng id trong catalog bằng `-m`. Id không bao giờ bị viết lại hay đoán,
và id không có trong catalog bị từ chối trước khi gửi bất cứ gì.

Catalog được cache tại `~/.multix/cache/models/sume-catalog.json` (hoặc trong
`MULTIX_CACHE_DIR`) theo cùng quy tắc với [`multix models --live`](/vi/reference/for-ai-agents/):

| Trạng thái | Ý nghĩa |
| --- | --- |
| `fresh` | Vừa đọc xong. |
| `cached` | Bản sao mới hơn `MULTIX_MODELS_TTL` (mặc định 24 giờ). |
| `stale` | Đọc trực tiếp thất bại; dùng bản sao chưa quá 7 ngày, kèm ghi chú. |
| `unavailable` | Không có bản sao dùng được. `sume image` và `sume video` không gửi gì. |

Mỗi lần liệt kê đều hiện URL catalog, thời điểm đọc và trạng thái.

## Ảnh

```bash
multix sume image "a red fox in snow" -m seedream-v4 \
  [--aspect-ratio 1:1] [--resolution 2K] [--quality high] \
  [-n 2] [--output-format png] [--output <path>]

# Sửa ảnh: file cục bộ được upload trước, URL https được truyền nguyên
multix sume image "make the sky purple" -m seedream-v4 --image ./photo.png
```

## Video

```bash
# Text-to-video và image-to-video (khung đầu và khung cuối)
multix sume video "a lighthouse in a storm" -m kling-3 --duration 5 [--aspect-ratio 16:9]
multix sume video "the camera orbits the statue" -m kling-3 \
  --image ./first.png [--end-image ./last.png] [--generate-audio | --no-generate-audio]

# Media tham chiếu, video-to-video và lipsync, khi model hỗ trợ
multix sume video "..." -m <id> --ref-image a.png --ref-image b.png [--ref-video v.mp4] [--ref-audio s.mp3]
multix sume video "..." -m <id> --video ./source.mp4
multix sume video "a podcast studio" -m infinitalk --image ./face.png --audio ./speech.mp3 --duration 12
```

Mỗi flag được đối chiếu với mục catalog của model trước khi gửi: capabilities
(`text_to_video`, `image_to_video`, `end_frame`, `reference_*`,
`video_to_video`, `lipsync`, `audio`), các resolution, aspect ratio và duration
được liệt kê, và `request_fields` (bắt buộc, bị bỏ, giá trị nhỏ nhất hoặc lớn
nhất). Flag mà model không nhận sẽ bị từ chối.

Media đầu vào là URL `https://` công khai hoặc file cục bộ. File cục bộ được
upload qua URL upload ký sẵn của Sume (tối đa 2 GiB; chỉ ảnh, video và audio).
URL upload là bí mật và không bao giờ được in ra.

Không hỗ trợ: model chạy qua route riêng (các model `sume-remix-*`), model bắt
buộc một trường multix không ánh xạ (ví dụ kiểu caption, ngôn ngữ lồng tiếng
hoặc preset; bị từ chối vì lệch schema), webhook, chế độ sync và batch.

## Job

Việc tạo nội dung chạy bất đồng bộ. Mặc định lệnh chờ job (ảnh tối đa 5 phút,
video tối đa 20 phút; `--wait-timeout <ms>`), rồi lưu kết quả thành
`sume-<job id>-NN.<ext>` trong thư mục output.

```bash
multix sume video "..." -m kling-3 --async           # in job id rồi thoát
multix sume status <jobId>                            # đọc trạng thái một lần (JSON)
multix sume status <jobId> --wait --download          # tiếp tục: chờ rồi lưu
multix sume result <jobId> [--no-download]            # lưu (hoặc in URL) job đã xong
multix sume cancel <jobId>                            # chỉ trước khi bắt đầu tạo
```

- `--no-download` in URL kết quả thay vì lưu file.
- `--output` là một file khi có một kết quả, một tên gốc khi có nhiều, hoặc
  một thư mục. Tiếp tục vào cùng chỗ sẽ giữ các file đã lưu.
- Dừng chờ không dừng job: job vẫn chạy và vẫn bị tính phí. Lệnh in ra lệnh
  tiếp tục; đừng gửi lại.
- Việc đọc trạng thái tự thử lại có backoff khi lỗi mạng, 429 (theo
  `Retry-After`) và 5xx.

## Idempotency và lỗi

Mỗi yêu cầu tạo chỉ được gửi một lần, kèm header `Idempotency-Key` (một UUID
mới, hoặc `--idempotency-key <key>`). multix không bao giờ tự gửi lại. Nếu kết
nối đứt, hoặc gateway trả 5xx mà không có error body của Sume, job có thể đã
tồn tại: lệnh thất bại với `UNKNOWN_REMOTE_STATE` và nêu key. Chạy lại đúng
lệnh đó với `--idempotency-key <key>`: Sume trả về job ban đầu thay vì tính phí
hai lần.

| Phản hồi | Mã | Bị tính phí |
| --- | --- | --- |
| 401 | `INVALID_KEY` | Không |
| 402 `insufficient_funds`, 403 `api_key_spend_limit_exceeded` | `QUOTA_EXCEEDED` | Không |
| 429 | `RATE_LIMITED` | Không |
| Job thất bại hoặc bị hủy | `JOB_FAILED` | Được hoàn tiền |

## Chi phí

```bash
multix sume video "..." -m kling-3 --duration 5 --estimate
multix sume video "..." -m kling-3 --duration 5 --max-cost 1.00
```

- Khi có `SUME_API_KEY`, `--estimate` và `--max-cost` báo giá đúng yêu cầu đó
  qua `POST /v1/open/estimate` (không tính phí) của Sume. Báo giá, làm tròn lên
  tới cent, là mức trần đã chứng minh.
- Khi không có key, hoặc khi lệnh gọi đó thất bại, multix dùng giá niêm yết
  trong catalog theo ảnh hoặc theo giây, kèm URL catalog và thời điểm đọc. Đây
  là ước tính, không phải mức trần, nên `--max-cost` từ chối trừ khi có
  `--cost-policy estimate`.
- File cục bộ không được upload chỉ để báo giá.

Sume giữ chỗ giá của job khi gửi, thu tiền khi job hoàn tất và hoàn tiền khi
job thất bại hoặc bị hủy. Sau khi job kết thúc, multix đọc sổ usage cuối cùng
của job: biên nhận ghi số tiền đã thu, hoặc `$0` khi được hoàn. Khoản giữ chỗ
không bao giờ được tính là chi tiêu, số dư tài khoản không bao giờ được ghi
thành usage, và chi phí chưa biết vẫn là chưa biết, không phải `$0`.
