---
title: Lệnh HeyGen
description: HeyGen v3 gồm Video Agent tạo video từ prompt, video avatar theo kịch bản, dịch video, lipsync, TTS, template và HeyGen Video model.
---

Lệnh HeyGen cần `HEYGEN_API_KEY` (tạo tại
[app.heygen.com/developers/api](https://app.heygen.com/developers/api)).
Provider chỉ dùng API **v3** của HeyGen và xác thực bằng header `X-Api-Key`.

:::caution[Thanh toán]
Phí sử dụng HeyGen API được tính riêng, không nằm trong gói đăng ký web/app của
HeyGen. Gói web không bao gồm credit API. Kiểm tra số dư API bằng
`multix heygen me` hoặc tại
[app.heygen.com/developers/usage](https://app.heygen.com/developers/usage).
:::

## Chọn đúng lệnh

| Bạn muốn | Lệnh | Ai viết kịch bản |
| --- | --- | --- |
| Video hoàn chỉnh từ một ý tưởng hoặc brief | `heygen video-agent "<prompt>"` | HeyGen Video Agent: tự viết kịch bản, chọn avatar, giọng, cảnh và B-roll |
| Avatar nói đúng từng chữ của bạn | `heygen video "<script>" --avatar <look-id>` | Bạn. Bạn chọn look avatar, giọng và kịch bản chính xác, hoặc dùng audio thu sẵn |
| Một clip điện ảnh ngắn (không có avatar) | `heygen model-video "<prompt>"` | HeyGen Video model (`heygen-video-1`), dài 5-15 giây, có âm thanh |
| Video có sẵn sang ngôn ngữ khác | `heygen translate <source> --languages ...` | Bản dịch giữ giọng người nói và khớp khẩu hình |
| Video có sẵn với audio mới | `heygen lipsync --video <ref> --audio <ref>` | Audio của bạn |
| Template Studio điền sẵn giá trị | `heygen template <id> --input vars.json` | Template của bạn |

**Video Agent** (`video-agent`) tạo video từ prompt: bạn mô tả video, agent tự
lên kế hoạch. **Video avatar theo kịch bản** (`video`) cho kết quả xác định:
avatar đọc đúng từng chữ trong kịch bản. Dùng `video-agent` cho bản nháp và
video giải thích từ một brief. Dùng `video` khi câu chữ, avatar và giọng đọc
phải chính xác.

## Video Agent (tạo video từ prompt)

```bash
multix heygen video-agent "A 45-second product explainer for our note app, upbeat tone" \
  [--avatar <look-id>] [--voice <voice-id>] [--style <style-id>] \
  [--orientation landscape|portrait] [--file <ref>]... \
  [--brand-kit <id>] [--brand-glossary <id>] \
  [--callback-url <https-url>] [--callback-id <id>]
```

- Prompt dài tối đa 10.000 ký tự. `--file` đính kèm tối đa 20 tệp tham khảo
  (slide, ảnh, footage).
- Agent chạy ở chế độ generate: một session (`session_id`) được tạo, agent lên
  kế hoạch video, và `video_id` được gán khi bắt đầu render. CLI theo session
  đến video, chờ rồi tải về MP4 và thumbnail.
- Nếu session dừng để chờ input hoặc thất bại trước khi render, lệnh thoát
  với mã khác 0 kèm lý do.
- Xem danh sách style bằng `multix heygen styles [--tag cinematic]`.

## Video avatar theo kịch bản

```bash
multix heygen video "Hi, I'm Anna. Here's what's new this week." --avatar <look-id> \
  [--voice <voice-id>] [--aspect-ratio 16:9|9:16|4:5|5:4|1:1|auto] \
  [--resolution 4k|1080p|720p] [--engine avatar_iv|avatar_v|avatar_iii] \
  [--background-color "#ffffff" | --background-image <ref>] [--remove-background] \
  [--output-format mp4|webm] [--burn-captions] [--captions] \
  [--speed 0.5-1.5] [--pitch -50..50] [--volume 0-1] [--locale en-US] \
  [--motion-prompt <text>] [--expressiveness high|medium|low] [--reference-look <look-id>] \
  [--title <text>] [--folder <id>] [--brand-glossary <id>]

# Cho avatar khớp khẩu hình với audio thu sẵn thay vì đọc kịch bản
multix heygen video --avatar <look-id> --audio ./voiceover.mp3
```

- `--avatar` nhận ID **look** từ `multix heygen avatars` (không phải ID group).
  Kịch bản dài tối đa 5.000 ký tự.
- Chỉ dùng kịch bản hoặc `--audio`, không dùng cả hai. `--voice` và các tùy
  chỉnh giọng chỉ áp dụng cho kịch bản.
- `--resolution 4k` cần `--engine avatar_iii` (digital twin và studio avatar).
  `--reference-look` cần `--engine avatar_v`. `--expressiveness` chỉ dành cho
  Avatar IV. `--motion-prompt` không dùng được với Avatar III.
- `--output-format webm` cho nền trong suốt, nên không kết hợp được với
  `--background-*`.
- Khi yêu cầu phụ đề, file phụ đề luôn được tạo. `--burn-captions` còn in phụ
  đề vào video và tải về bản render có phụ đề (`captioned_video_url`); lệnh sẽ
  báo lỗi nếu HeyGen không trả về bản này. `--captions` yêu cầu HeyGen tạo phụ
  đề (thêm object `caption` vào request tạo video) và tải file phụ đề về cạnh
  video.
- Các biến thể khác của `POST /v3/videos` (image, cinematic avatar, studio)
  dùng qua `heygen run video --input <json>`.

## HeyGen Video model

```bash
multix heygen model-video "A drone shot over a misty forest at sunrise" \
  [--mode text_to_video|image_to_video|reference_to_video] \
  [--image <ref>] [--reference-image <ref>]... [--reference-video <ref>]... [--reference-audio <ref>]... \
  [--duration 5-15] [--resolution 480p|768p|1080p|2k] \
  [--aspect-ratio 21:9|16:9|4:3|1:1|3:4|9:16|adaptive] \
  [--prompt-enhancement turbo|quality|disabled] [--seed <n>]
```

Chế độ được suy ra tự động: có `--image` thì là image-to-video, có bất kỳ
`--reference-*` nào thì là reference-to-video, còn lại là text-to-video. Tỉ lệ
khung hình `adaptive` chỉ hợp lệ với reference-to-video. Image-to-video bám
theo khung hình đầu nên không nhận tỉ lệ khung hình. Tối đa 9 ảnh, 3 video và
3 audio tham chiếu, và tổng cộng không quá 12 tệp tham chiếu.

## Dịch video và lipsync

```bash
multix heygen languages
multix heygen translate ./talk.mp4 --languages "Spanish, French, Chinese (Cantonese, Traditional)" \
  [--mode speed|precision] [--input-language <code>] [--audio-only] [--audio <ref>] \
  [--speakers <n>] [--keep-format] [--no-dynamic-duration] [--disable-music] [--enhance-speech] \
  [--start <s>] [--end <s>] [--brand-glossary <id>] [--captions] [--output <dir|name.mp4>]

multix heygen lipsync --video <ref> --audio <ref> [--mode speed|precision] [--start <s>] [--end <s>]
```

- `--languages` nhận **tên** ngôn ngữ từ `heygen languages`. Dấu phẩy nằm trong
  ngoặc đơn được giữ nguyên, nên `Chinese (Cantonese, Traditional)` vẫn là một
  ngôn ngữ.
- Mỗi ngôn ngữ tạo một job dịch riêng. CLI chờ tất cả các job, tải về mọi kết
  quả thành công, và thoát với mã khác 0 nếu có ngôn ngữ nào hoặc lượt tải nào
  thất bại. Một lượt tải lỗi không chặn việc tải các ngôn ngữ còn lại.
- Khi dịch sang nhiều ngôn ngữ, `--output` có đuôi media (`.mp4`, `.webm`,
  `.mov`, `.mp3`, `.wav`, `.m4a`, `.aac`, `.srt`, `.vtt`) được hiểu là mẫu tên
  tệp: `--output dub.mp4` lưu thành `dub-Spanish.mp4`, `dub-French.mp4`, v.v.
  Mọi `--output` khác được hiểu là thư mục chứa các tệp với tên mặc định.

## Chuyển văn bản thành giọng nói

```bash
multix heygen tts "Welcome to the show." --voice <voice-id> \
  [--ssml] [--speed 0.5-2] [--language en] [--locale en-US] \
  [--engine starfish|orca|elevenlabs] [--output hello.mp3] [--no-download] [--json]
```

Speech chạy đồng bộ (tối đa 5.000 ký tự) và file audio được tải về ngay.

## Danh mục và tài khoản

```bash
multix heygen avatars [--groups] [--group <group-id>] [--type studio_avatar|digital_twin|photo_avatar] \
  [--ownership public|private] [--limit 1-50] [--cursor <token>] [--json]
multix heygen voices [--language English] [--gender male|female] [--engine <e>] \
  [--type public|private] [--limit 1-100] [--cursor <token>] [--json]
multix heygen styles [--tag <tag>] [--limit <n>] [--cursor <token>] [--json]
multix heygen me
```

Danh sách được phân trang. Khi còn kết quả, bảng kết thúc bằng dòng
`More results: --cursor <token>`, còn `--json` in ra
`{ data, has_more, next_token }`.

## Template và thao tác thô

```bash
multix heygen template <template-id> --input '{"name":{"type":"text","properties":{"content":"Duy"}}}' [--title <text>]
multix heygen run <operation> --input <json|@file.json>
```

`template` nhận map biến trực tiếp hoặc toàn bộ request body. `run` gửi
nguyên văn payload v3 đến một thao tác tạo đã được tài liệu hóa: `video-agent`,
`video`, `video-translation`, `lipsync`, `model-video` hoặc `speech`. Sau đó
lệnh chờ và tải kết quả giống các lệnh chuyên biệt. `run` không upload tệp cục
bộ; hãy dùng URL hoặc input dạng `asset_id`.

## Tham chiếu media và upload

Ở mọi chỗ lệnh nhận `<ref>` (`--audio`, `--file`, `--image`,
`--background-image`, nguồn của translate/lipsync), bạn có thể truyền:

- `https://...`: URL công khai, gửi dưới dạng `{ "type": "url" }`.
- `asset:<asset_id>`: asset đã upload lên HeyGen.
- Đường dẫn cục bộ: được upload trước qua `POST /v3/assets` (multipart, **tối
  đa 32 MB**; png, jpg, mp4, webm, mp3, wav, pdf, srt). Với tệp lớn hơn, hãy
  đặt ở một URL HTTPS công khai.

## Job bất đồng bộ, trạng thái và tiếp tục

Mọi lệnh tạo nội dung mặc định chờ hoàn thành rồi tải kết quả về. Chúng dùng
chung một bộ cờ:

- `--async` in ID job và lệnh tiếp tục mà không chờ.
- `--wait-timeout <ms>` đặt hạn chờ (mặc định 30 phút).
- `--poll-interval <ms>` đặt khoảng poll đầu tiên (mặc định 10 giây), sau đó
  giãn dần đến 30 giây.
- `--no-download` in URL kết quả thay vì tải về. Khi dùng kèm `--json`, bản tóm
  tắt có `output_url` (và `caption_url`) dùng được ngay. Các URL này có chữ ký,
  nên hãy xem output là dữ liệu nhạy cảm.
- Tệp đã có ở đích chỉ bị thay thế sau khi tải xong; lượt tải lỗi không đụng
  đến tệp đó.
- `--output`, `--captions`, `--no-thumb` và `--json` hoạt động đúng như tên gọi.

```bash
multix heygen status <id> --type agent|video|translation|lipsync|model-video [--wait] [--download] [--burn-captions] [--json] [--raw]
```

- `--burn-captions` đọc bản render có phụ đề in sẵn của video, giống lệnh tiếp
  tục mà `heygen video --burn-captions` in ra.

- `--type agent` nhận `session_id` của Video Agent và theo session đến video.
  Các loại khác nhận ID mà lệnh tương ứng đã in ra.
- Có thể tiếp tục kiểm tra trạng thái bất cứ lúc nào vì trạng thái job nằm phía
  HeyGen. Khi hết thời gian chờ, CLI in sẵn lệnh
  `multix heygen status ... --wait --download` để tiếp tục.
- URL kết quả có chữ ký và sẽ hết hạn. Nếu tải về lỗi 403/404/410, hãy chạy lại
  `status ... --download` để lấy URL mới.
- Kết quả, file phụ đề và thumbnail chỉ được tải từ URL `https://`. URL kết
  quả hoặc phụ đề không phải HTTPS sẽ làm lượt giao kết quả của job đó thất
  bại; thumbnail không phải HTTPS được bỏ qua kèm cảnh báo.

## Webhook

`--callback-url` (chỉ HTTPS) yêu cầu HeyGen thông báo cho endpoint của bạn khi
job hoàn thành hoặc thất bại. HeyGen ký raw request body bằng HMAC-SHA256 với
secret của endpoint và gửi digest dạng hex trong header `signature`.

Package `multix-cli` đã publish không export hàm xác minh webhook. Mã nguồn
repository có sẵn một hàm tại `src/providers/heygen/webhook.ts`
(`verifyHeygenWebhookSignature`, dùng Web Crypto, chạy được trên Node 20+ và
Cloudflare Workers) để bạn chép vào receiver của mình. Trên Node, phép kiểm tra
như sau:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
```

Hãy xác minh đúng raw body như khi nhận được, không dùng JSON đã serialize lại.

## Lỗi và giới hạn

Khi thất bại, lệnh thoát với mã 1 kèm thông báo hướng dẫn cách xử lý. CLI không
bao giờ báo thành công cho job thất bại hoặc bị hủy.

| Mã | Ý nghĩa | Cách xử lý |
| --- | --- | --- |
| 401 | Key sai hoặc thiếu | Kiểm tra `HEYGEN_API_KEY` |
| 402 | `insufficient_credit` / `plan_upgrade_required` | Nạp thêm credit API; phí API tính riêng với gói web |
| 403 | Thiếu scope hoặc quyền | Dùng key có đủ scope; một số tính năng avatar cần gói Enterprise |
| 404 | ID không tồn tại | Kiểm tra ID và `--type` có khớp với ID không |
| 429 | Giới hạn tốc độ/đồng thời hoặc `quota_exceeded` | CLI tuân theo `Retry-After`; hãy giảm số job chạy song song |

- Request tạo bị giới hạn tốc độ (429) được thử lại sau `Retry-After`. Lỗi
  server chỉ được thử lại ở các endpoint có tài liệu hỗ trợ `Idempotency-Key`
  (video, dịch, lipsync, template, asset, model video), header này được CLI tự
  gửi. Request tạo Video Agent và speech không bao giờ bị gửi lại.
- Tài khoản API trả theo mức dùng (pay-as-you-go) chạy được khoảng 10 workflow
  đồng thời. HeyGen khuyến nghị poll mỗi 10-30 giây, và cơ chế giãn poll mặc
  định tuân theo khuyến nghị này.
- Log không bao giờ chứa API key hay query string của URL có chữ ký, và prompt
  không được ghi log.

## Cấu hình

| Biến | Bắt buộc | Mô tả |
| --- | --- | --- |
| `HEYGEN_API_KEY` | Cho HeyGen | API key, gửi qua header `X-Api-Key` |
| `HEYGEN_BASE_URL` | Không | Ghi đè API base (mặc định `https://api.heygen.com`), dùng cho proxy và test. Phải là `https://`; `http://` chỉ được chấp nhận cho `localhost`, `127.0.0.1` hoặc `[::1]` |

Provider này không hỗ trợ tạo digital twin hay clone giọng nói.
