---
title: Lệnh fal.ai
description: Chạy bất kỳ model queue nào của fal.ai với file cục bộ và job tách rời, hoặc dùng lệnh image, video và text-to-speech với input có kiểu và default hợp lý.
---

Lệnh fal.ai cần `FAL_KEY`. `run` hoạt động với bất kỳ fal model id nào;
`image`, `video` và `tts` đặt sẵn default hợp lý và tự động download media.

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

## Giọng nói (text-to-speech)

`fal tts` ánh xạ các flag có kiểu vào đúng schema input của từng model, rồi
dùng cùng luồng queue với `run` (một lần submit, không bao giờ retry, receipt
với `--detach`, polling, download).

```bash
multix fal tts "Xin chào các bạn" --voice Puck --style "ấm áp, chậm rãi"
multix fal tts --text-file script.txt -m google/gemini-3.8-flash-lite-tts
multix fal tts "Hello" -m elevenlabs/tts/eleven-v4-turbo --format pcm_16000 --language en
multix fal tts "Hello" -m elevenlabs/tts/eleven-v4 --format opus_48000_64 --detach
```

Các model đã kiểm chứng (`multix fal voices` liệt kê; `multix fal voices <model>`
in input có kiểu dạng JSON):

| Model | Field văn bản | Giọng | Style | Ngôn ngữ | Định dạng | Output |
|---|---|---|---|---|---|---|
| `google/gemini-3.8-flash-tts` (mặc định) | `prompt` | 30 giọng có tên (mặc định `Kore`) | `--style` | — | — | wav |
| `google/gemini-3.8-flash-lite-tts` (độ trễ thấp) | `prompt` | như trên | `--style` | — | — | wav |
| `elevenlabs/tts/eleven-v4` | `text` (≤ 5000 ký tự) | tên hoặc voice id bất kỳ (mặc định `Rachel`) | — | `--language` | `--format` (`mp3_*`, `pcm_*`, `opus_*`, `ulaw_8000`, ...) | theo định dạng |
| `elevenlabs/tts/eleven-v4-turbo` (độ trễ thấp) | như trên | như trên | — | `--language` | như trên | theo định dạng |

- Truyền văn bản một lần: positional, `--text` hoặc `--text-file` (UTF-8, tối
  đa 1 MB; BOM và một dòng trống cuối file được bỏ). Văn bản rỗng bị từ chối.
- Flag mà model không có field tương ứng (`--style` với ElevenLabs, `--format`
  với Gemini), giọng ngoài danh sách của model, hoặc định dạng ngoài enum sẽ
  lỗi `INVALID_INPUT` trước khi gửi bất cứ gì. `--input` thêm field khác
  (`stability`, `seed`, ...); một field được đặt bởi cả flag và `--input` là
  lỗi. Giá trị truyền qua `--input` được kiểm tra như flag: độ dài văn bản (đếm
  theo ký tự), danh sách giọng, enum `output_format` và mã ngôn ngữ (`en`, `vi`,
  `pt-BR`).
- Hội thoại nhiều người nói của Gemini truyền qua `--input` thay cho văn bản:
  đúng hai `speakers` với `speaker_id` khác nhau và giọng thuộc danh sách, cùng
  một hoặc nhiều `turns`, mỗi lượt gọi tên một trong hai người nói và có `text`
  không rỗng. `--voice` và văn bản bị từ chối khi có hội thoại. Hội thoại sai
  cấu trúc bị từ chối trước khi vào hàng đợi nên không tốn phí; hiện fal vẫn
  trả HTTP 422 cho cả hội thoại đúng cấu trúc sau khi đã xếp hàng
  ([#310](https://github.com/mrgoonie/multix-cli/issues/310)).

  ```bash
  multix fal tts --input '{"speakers":[{"speaker_id":"A","voice":"Kore"},{"speaker_id":"B","voice":"Puck"}],"turns":[{"speaker_id":"A","text":"Xin chào!"},{"speaker_id":"B","text":"Chào bạn."}]}'
  ```
- Đặt model mặc định bằng `FAL_TTS_MODEL`.
- Endpoint TTS khác của fal dùng được khi bạn chỉ rõ field:
  `multix fal tts "hi" -m <model> --text-field input [--voice-field speaker --voice anna]`.
  multix không bao giờ đoán schema. `multix fal voices --live` liệt kê catalog
  text-to-speech đang có trên fal (không cần key) và đánh dấu model chưa kiểm chứng.

Audio được lưu thành `fal-<request_id>-01.<ext>`, phần mở rộng lấy từ chính
các byte: WAV, MP3, Ogg/Opus, FLAC, M4A, AAC, WebM và AIFF được nhận ra qua
header, bất kể URL hay Content-Type ghi gì. Định dạng thô không có header
(`pcm_*` → `.pcm`, `ulaw_8000` → `.ulaw`, `alaw_8000` → `.alaw`) được đặt tên
theo định dạng đã yêu cầu. File rỗng, trang lỗi, WAV chỉ có header mà không có
mẫu âm thanh, hoặc byte không đúng container fal khai báo sẽ bị từ chối và không để lại file nào. `fal result <model> <id>
--download` áp dụng cùng các kiểm tra cho job giọng nói; với định dạng thô hãy
thêm `--format <fmt>` (`result_command` trong receipt của `--detach` đã có sẵn),
nếu không thì không thể đặt tên cho các byte không có header.

## Status và result

Dùng để resume một job đã submit ở nơi khác, hoặc sau khi lệnh
`run`/`image`/`video` timeout — lỗi timeout luôn kèm request ID cho chính
mục đích này.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>] [--format <fmt>]
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
  vị mili-giây) và tự retry lỗi network, 408, 429 (chờ theo `Retry-After`, không bao giờ quá hạn chót)
  và phản hồi 5xx (trừ 501 và 505), cả khi poll trạng thái lẫn khi lấy kết quả
  sau khi job hoàn tất. Timeout của từng request bằng thời gian còn lại trước
  hạn chót (tối thiểu 10 giây, tối đa 120 giây). Khi timeout hoặc gặp lỗi
  không khôi phục được, lệnh in request ID để bạn resume bằng
  `multix fal status` hoặc `multix fal result`.
- Trích xuất media ưu tiên các field kết quả đã biết (`images[].url`,
  `video.url`, `image.url`, `audio.url`) trước khi rơi về quét chung toàn bộ
  payload kết quả.
