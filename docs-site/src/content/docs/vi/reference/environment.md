---
title: Biến môi trường
description: Cấu hình credential, model mặc định và thư mục output của multix bằng biến môi trường.
---

`multix` đọc cấu hình theo thứ tự: environment hiện tại, `.env` ở project đang
chạy, rồi `~/.multix/.env` (cùng [file `.claude` cũ](#file-env-claude-cũ) khi được
bật). Không commit API key hoặc đưa key vào shell history.

## Credential provider

| Biến | Dùng cho |
| --- | --- |
| `GEMINI_API_KEY` (và tùy chọn `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, …) | Gemini |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `MINIMAX_API_KEY` | MiniMax |
| `LEONARDO_API_KEY` | Leonardo |
| `BYTEPLUS_API_KEY` hoặc `ARK_API_KEY` | BytePlus |
| `CLOUDFLARE_ACCOUNT_ID` và `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI |
| `CLOUDFLARE_AI_GATEWAY_ID` và `REPLICATE_API_TOKEN` | Cloudflare AI Gateway video |
| `ELEVENLABS_API_KEY` | ElevenLabs |
| `FAL_KEY` | fal.ai |
| `ATLASCLOUD_API_KEY` | Atlas Cloud |
| `REPLICATE_API_TOKEN` hoặc `REPLICATE_API_KEY` | Replicate (API trực tiếp) |
| `HEYGEN_API_KEY` | HeyGen (credit API tính riêng với gói web) |

```bash
export GEMINI_API_KEY="your-key"
export MULTIX_OUTPUT_DIR="./multix-output"
multix check
```

## Xoay vòng Gemini key

Thêm key Gemini phụ bằng `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, … (hậu tố số
bất kỳ). `multix` dùng `GEMINI_API_KEY` trước, sau đó các key đánh số theo thứ
tự tăng dần; giá trị trùng lặp bị bỏ qua. Chỉ cần các key đánh số cũng đủ, không
bắt buộc có `GEMINI_API_KEY`.

- Key trả về HTTP 429, hoặc 400/403 kèm `RESOURCE_EXHAUSTED`, sẽ tạm nghỉ theo
  `Retry-After` hoặc `retryDelay` của server, nếu không có thì 60 giây, và chính
  request đó được thử lại với key sẵn sàng kế tiếp. Khi mọi key đều đang nghỉ,
  chỉ key hồi phục sớm nhất được thử một lần. Các lỗi khác không xoay vòng.
- Request nhiều bước giữ nguyên một key. Nếu lệnh generate sau khi upload qua
  Files API bị giới hạn, key kế tiếp sẽ upload lại file, vì file đã upload thuộc
  về key tạo ra nó.
- Veo chỉ xoay vòng ở bước submit. Khi job đã được nhận, polling và download dùng
  đúng key đó, nên giới hạn về sau không bao giờ tạo job thứ hai bị tính phí riêng.
- `multix doc convert` dừng vòng thử lại của chính nó khi gặp giới hạn, vì xoay
  vòng đã thử mọi key sẵn sàng.
- Thời gian nghỉ chỉ tồn tại trong process hiện tại. Log chỉ ghi tên biến môi
  trường, không bao giờ ghi giá trị key.
- `multix check` liệt kê các key đang xoay vòng và ping từng key.
- Quota Gemini tính theo từng Google Cloud project. Các key cùng project dùng
  chung quota, nên xoay vòng chỉ có ích với key thuộc các project khác nhau.

## File env `.claude` cũ

Bản cài AgentKit cũ lưu key trong các thư mục `.claude`. Đặt
`MULTIX_LEGACY_CLAUDE_ENV=1` (trong shell, `.env` của project hoặc
`~/.multix/.env`) để đọc thêm các file này. Mặc định tính năng này tắt. Các file
được nạp sau `~/.multix/.env`, không bao giờ ghi đè giá trị đã có, và file đầu
tiên đặt một biến sẽ thắng:

1. `.claude/skills/ai-multimodal/.env`, rồi `.claude/skills/ak-ai-multimodal/.env`
2. `.claude/skills/.env`
3. `.claude/.env`

Thư mục project được đọc trước, sau đó là các file tương tự trong thư mục home.
Chỉ các tên dạng credential được lấy từ những file này: tên kết thúc bằng
`_API_KEY` (có thể đánh số, như `GEMINI_API_KEY_2`), `_API_TOKEN`, `_ACCOUNT_ID`
hoặc `_GATEWAY_ID`, cùng `FAL_KEY` và `ARK_API_KEY`. Các thiết lập endpoint,
proxy và runtime như `*_BASE_URL` bị bỏ qua, nên một repository clone về không
thể gửi key của bạn tới host khác. Bản thân cờ này bị bỏ qua nếu đặt trong các
file đó.
`multix check` báo khi tìm thấy file cũ lúc cờ đang tắt, còn `multix check -v`
liệt kê mọi file env đã nạp (chỉ đường dẫn, không bao giờ in giá trị). Vẫn nên
chuyển key sang `.env` hoặc `~/.multix/.env`.

## Ghi đè model và endpoint

Chỉ đặt override khi cần thay default. Các biến gồm `IMAGE_GEN_MODEL`,
`VIDEO_GEN_MODEL`, `MULTIMODAL_MODEL`, `GEMINI_TTS_MODEL`,
`OPENAI_IMAGE_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_STT_MODEL`,
`OPENROUTER_IMAGE_MODEL`, `LEONARDO_BASE_URL`, `BYTEPLUS_BASE_URL`,
`BYTEPLUS_IMAGE_MODEL`, `BYTEPLUS_VIDEO_MODEL`, `BYTEPLUS_3D_MODEL`,
`FAL_BASE_URL`, `FAL_IMAGE_MODEL`, `FAL_VIDEO_MODEL` và
`FAL_VIDEO_IMAGE_MODEL` (default image-to-video của fal, dùng khi truyền
`multix fal video --image-url` mà không có `-m`). Replicate nhận
`REPLICATE_BASE_URL` (API root cho mock hoặc proxy), `REPLICATE_IMAGE_MODEL`
(mặc định `black-forest-labs/flux-schnell`) và `REPLICATE_VIDEO_MODEL`
(mặc định `prunaai/p-video`). Video qua Cloudflare AI Gateway chỉ đọc
`REPLICATE_API_TOKEN`.

Atlas Cloud nhận `ATLASCLOUD_BASE_URL` (base của media API, mặc định
`https://api.atlascloud.ai/api/v1`) và một biến ghi đè model mặc định cho mỗi
lệnh: `ATLASCLOUD_IMAGE_MODEL`, `ATLASCLOUD_IMAGE_EDIT_MODEL`,
`ATLASCLOUD_VIDEO_MODEL`, `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL`,
`ATLASCLOUD_TTS_MODEL`, `ATLASCLOUD_STT_MODEL`, `ATLASCLOUD_TEXT_TO_3D_MODEL`
và `ATLASCLOUD_IMAGE_TO_3D_MODEL`. Xem [Atlas Cloud](/vi/commands/atlascloud/)
để biết các model mặc định. `ATLASCLOUD_MAX_UPLOAD_MB` đặt giới hạn dung lượng
cho file cục bộ upload lên Atlas Cloud (mặc định 200).

`HEYGEN_BASE_URL` ghi đè API base của HeyGen (mặc định
`https://api.heygen.com`) cho proxy và test. Giá trị phải là `https://`;
`http://` chỉ được chấp nhận cho `localhost`, `127.0.0.1` hoặc `[::1]`.

### Ghi đè base URL và độ tin cậy

Biến ghi đè `*_BASE_URL` quyết định API key của bạn được gửi tới đâu, nên
`multix` chỉ tin giá trị này khi nó đến từ biến môi trường của shell hoặc
`~/.multix/.env`:

- `*_BASE_URL` chỉ có trong `.env` của project (thư mục hiện tại) sẽ bị bỏ qua,
  và `multix` in một cảnh báo nêu tên biến và đường dẫn file (không bao giờ in
  giá trị). Nếu `~/.multix/.env` cũng đặt biến đó thì giá trị ở đó được dùng;
  nếu không, provider dùng giá trị mặc định. Nhờ vậy một repository clone về
  không thể chuyển key của bạn sang host khác.
- Để cho phép ghi đè từ project (ví dụ mock server cục bộ), đặt
  `MULTIX_ALLOW_PROJECT_BASE_URL=1` trong shell hoặc `~/.multix/.env`. Biến
  này bị bỏ qua nếu được đặt ngay trong `.env` của project.
- Khi một base URL khác mặc định đang được dùng, `multix` in một cảnh báo mỗi
  lần chạy, nêu provider và chỉ hostname, không bao giờ in key hay URL đầy đủ.
  Cảnh báo được ghi ra stderr nên stdout vẫn đọc được bằng máy.

Các quy tắc riêng của từng provider ở trên (ví dụ HeyGen chỉ nhận `https://`)
vẫn được áp dụng.

Cloudflare chỉ chấp nhận các model image và speech Workers AI có sẵn;
`CLOUDFLARE_AI_IMAGE_MODEL` và `CLOUDFLARE_AI_TTS_MODEL` vì vậy chỉ dùng để
chỉ rõ lựa chọn được hỗ trợ. Chỉ đặt
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` khi muốn thu thập request
payload.

Sau khi đổi credential hoặc endpoint, chạy `multix check --verbose` để xem
provider nào dùng được.
