---
title: Lệnh fal.ai
description: Chạy bất kỳ model queue nào của fal.ai với file cục bộ và job tách rời, dùng lệnh tiện lợi image/video/text-to-speech, hoặc tra cứu fal model id.
---

Lệnh fal.ai cần `FAL_KEY`. `run` hoạt động với bất kỳ fal model id nào;
`image`, `video` và `tts` đặt sẵn default hợp lý và tự động download media,
còn `models` liệt kê fal endpoint id.

```bash
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}'
multix fal run fal-ai/flux/schnell --input @input.json
```

`--input` nhận JSON inline hoặc `@path/to/file.json`. Mặc định lệnh sẽ poll
đến khi hoàn thành và download mọi media URL tìm thấy trong kết quả;
`--no-download` in kết quả JSON thay vì download, còn `--output-dir <dir>`
chọn thư mục tải về (mặc định `MULTIX_OUTPUT_DIR` hoặc `./multix-output`).
Tiến trình được in ra stderr, nên stdout chỉ chứa JSON kết quả, receipt hoặc
đường dẫn các file đã lưu.

## File cục bộ

Model fal nhận media dưới dạng URL mà fal truy cập được. `--file field=path`
upload file cục bộ lên fal storage trước, rồi ghi URL của nó vào trường `field`
của input, nên bạn không phải tự host clip:

```bash
multix fal run fal-ai/mmaudio-v2 \
  --input '{"prompt":"soft rain on a window","duration":8}' \
  --file video_url=./shot.mp4

multix fal run fal-ai/hunyuan-video-foley \
  --input '{"text_prompt":"footsteps on gravel"}' \
  --file video_url=./shot.mp4 --detach
```

- Lặp lại `--file` cho nhiều trường. `a.b=path` đặt trường lồng nhau,
  `field[]=path` thêm vào cuối một mảng (sau các URL đã có trong `--input`).
  Giá trị từ `--file` thay thế cùng trường trong `--input`.
- Không cần `--input` khi `--file` đã đủ toàn bộ input.
- Chỉ file bạn chỉ định mới được upload; input JSON không bao giờ bị quét để
  tìm đường dẫn. Mọi file được kiểm tra trước lần upload đầu tiên: phải tồn
  tại, đọc được, không rỗng, là file ảnh, video hoặc audio (png, jpg, webp,
  gif, mp4, mov, webm, mkv, wav, mp3, m4a, flac, ogg, ...) và không vượt quá
  `FAL_MAX_UPLOAD_MB` (mặc định 1024). Cùng một đường dẫn chỉ upload một lần.
- Để upload mà không chạy model, dùng `fal upload`. stdout chỉ chứa JSON:

```bash
multix fal upload ./shot.mp4
# {"url":"https://v3b.fal.media/files/...","mime_type":"video/mp4","size_bytes":70180,"file_name":"shot.mp4"}
```

:::caution[File đã upload là công khai theo link]
Ai có URL fal storage cũng mở được file, và fal quyết định file được giữ bao
lâu: multix không đặt được thời hạn hay xóa file. Đừng upload media mà bạn
không muốn chia sẻ. Việc upload dùng cùng luồng với `@fal-ai/client` chính thức
(initiate qua `rest.fal.ai`, rồi PUT lên một URL đã ký sẵn; file trên 90 MB
được gửi theo từng phần 10 MB). `FAL_KEY` chỉ được gửi tới `https://rest.fal.ai`;
URL upload đã ký không bao giờ nhận key và không bao giờ được in ra.
:::

## Job tách rời (submit rồi resume)

`--detach` trả về ngay khi fal đã đưa job vào hàng đợi, không poll, và in ra
một receipt:

```bash
multix fal run fal-ai/mmaudio-v2 --input @mmaudio.json --file video_url=./shot-01.mp4 --detach
```

```json
{
  "provider": "fal",
  "model": "fal-ai/mmaudio-v2",
  "request_id": "01a173ff-f807-7733-87ed-013873a72fb8",
  "status": "IN_QUEUE",
  "submitted_at": "2026-10-25T16:58:37.444Z",
  "input_hash": "sha256:675b…",
  "status_command": "multix fal status fal-ai/mmaudio-v2 01a173ff-…",
  "result_command": "multix fal result fal-ai/mmaudio-v2 01a173ff-… --download",
  "receipt_path": "/home/you/.multix/fal/requests/01a173ff-….json"
}
```

Chạy hai lệnh này sau đó, từ shell bất kỳ, để kiểm tra và lấy kết quả. Chúng
chỉ đọc: không bao giờ submit lại job, nên không tốn thêm phí. Có thể submit
nhiều shot theo cách này rồi lần lượt lấy kết quả.

Với `--detach`, receipt được lưu ở
`~/.multix/fal/requests/<request_id>.json`; `--receipt <path>` lưu vào đường
dẫn đó, và cũng dùng được khi không có `--detach` để một lần chạy bị kill khi
đang chờ vẫn resume được. Không có hai flag này thì `fal run` không ghi file
nào, còn request id được in ra stderr ngay khi fal nhận job. Receipt được ghi
nguyên tử với mode 0600 ngay sau khi fal nhận job. Receipt chỉ chứa các id,
trạng thái lúc submit và SHA-256 của input, không bao giờ chứa input, các URL
trong đó hay key. multix không tự xóa receipt cũ.

Nếu submit thất bại theo cách không chứng minh được là fal đã từ chối (kết nối
bị đứt trước khi fal trả lời, lỗi gateway 5xx, hoặc trả lời thành công nhưng
không có request id dùng được), multix không biết fal đã nhận job hay chưa.
Lệnh dừng với `UNKNOWN_REMOTE_STATE`
(exit 6 khi dùng `--json`) thay vì submit lại: hãy kiểm tra
[danh sách request trên fal](https://fal.ai/dashboard/requests) trước khi
submit lần nữa. fal không có idempotency key, nên multix không bao giờ tự
retry một lần submit.

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

## Chuyển văn bản thành giọng nói

```bash
multix fal tts "Xin chào từ multix" \
  [-m <model>] [--text-file <path>] [--voice <name>] [--style <text>] \
  [--format <fmt>] [--language <code>] [--input <json|@file>] \
  [--detach] [--receipt <path>] [--no-download] [--output-dir <dir>] [-v]
```

Các endpoint TTS của fal không dùng chung một schema đầu vào, nên `tts` ánh xạ
các flag sang đúng field của từng endpoint và kiểm tra trước khi đưa vào hàng
đợi (fal vẫn nhận một job sai và chỉ báo lỗi khi lấy kết quả, sau khi đã tính
phí):

| Model (`-m`) | Field văn bản | `--voice` | `--style` | `--format` / `--language` | Trả về |
|---|---|---|---|---|---|
| `google/gemini-3.8-flash-tts` (mặc định), `google/gemini-3.8-flash-lite-tts` | `prompt` | một trong 30 giọng dựng sẵn (mặc định `Kore`) | `style_instructions` | không hỗ trợ | WAV |
| `elevenlabs/tts/eleven-v4`, `elevenlabs/tts/eleven-v4-turbo` | `text` (tối đa 5000 ký tự) | tên hoặc id giọng bất kỳ (mặc định `Rachel`) | không hỗ trợ: dùng audio tag như `[whispering]` trong văn bản | `output_format` (mặc định `mp3_44100_128`; `pcm_*`, `ulaw_8000`, `opus_*`, ...) / `language_code` | MP3 (hoặc định dạng đã chọn) |

- Truyền văn bản qua đối số hoặc `--text-file` (UTF-8, tối đa 1 MB), không
  dùng cả hai. Hội thoại nhiều người nói của Gemini đặt trong `--input`, ví dụ
  `--input '{"speakers":[...],"turns":[...]}'`, và không truyền đối số văn bản:
  đúng hai người nói, mỗi người một trong 30 giọng, và các lượt thoại gọi đúng
  tên họ. Tính đến 2026-10-26, fal vẫn nhận hội thoại vào hàng đợi rồi từ chối
  với HTTP 422, nên `tts` cảnh báo trước khi submit
  ([#310](https://github.com/mrgoonie/multix-cli/issues/310)).
- Flag mà endpoint không có field tương ứng (ví dụ `--format` với Gemini),
  giọng hoặc định dạng không hợp lệ, văn bản vượt giới hạn, hay một field được
  đặt cả bằng flag lẫn `--input` đều báo lỗi validation và không có gì được
  submit.
- Mọi fal TTS id khác chạy ở chế độ untyped, kèm cảnh báo: văn bản đi vào
  `--text-field` (mặc định `text`), `--voice` đi vào `voice`, các field khác
  lấy từ `--input`. Hãy xem schema trên trang fal của model.
- Đổi model mặc định bằng `FAL_TTS_MODEL`.
- Audio được lưu thành `fal-<request_id>-NN.<ext>`, phần mở rộng lấy theo nội
  dung byte (file WAV trả về với tên `audio.mp3` hoặc từ URL không có phần mở
  rộng vẫn được lưu thành `.wav`). Định dạng thô không có header (`.pcm`,
  `.ulaw`, `.alaw`) giữ tên fal khai báo. File rỗng, hoặc nội dung là văn bản,
  HTML hay JSON, bị từ chối và xóa, lệnh báo lỗi kèm gợi ý
  `multix fal result <model> <request_id> --download`.
- `--detach`, `--receipt`, `UNKNOWN_REMOTE_STATE` và việc tiếp tục bằng
  `status`/`result` hoạt động giống hệt `run`. Receipt chỉ chứa id và hash của
  input, không bao giờ chứa văn bản.

## Tìm model

```bash
multix fal models --typed [--json]                       # offline: các endpoint TTS mà tts kiểm tra
multix fal models --category text-to-speech [--json]     # catalog trực tiếp
multix fal models --query "gemini tts" [--limit 50] [--json]
```

Danh sách trực tiếp lấy từ catalog công khai của fal
(`https://api.fal.ai/v1/models`). Không cần key, và `FAL_KEY` không bao giờ
được gửi tới đó. Những dòng mà `tts` biết rõ từng field được đánh dấu `typed`.
`multix models --task speech --provider fal --json` hiển thị cùng lệnh này cho
agent, kèm danh sách input, `output: audio` và `async: true`.

## Status và result

Dùng để resume một job đã submit ở nơi khác, hoặc sau khi lệnh
`run`/`image`/`video` timeout — lỗi timeout luôn kèm request ID cho chính
mục đích này.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>]
```

`status` in trạng thái hàng đợi của fal (`IN_QUEUE`, `IN_PROGRESS` hoặc
`COMPLETED`) dưới dạng JSON. Job thất bại sẽ hiện thành lỗi khi gọi `result`.

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
  payload kết quả. Mỗi file được đặt tên theo nội dung byte thực tế, sau đó
  theo `content_type` / `file_name` fal trả về, theo URL, rồi theo
  `Content-Type` của lượt tải, theo đúng thứ tự đó.
