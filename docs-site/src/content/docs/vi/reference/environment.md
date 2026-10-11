---
title: Biến môi trường
description: Cấu hình credential, model mặc định và thư mục output của multix bằng biến môi trường.
---

`multix` đọc cấu hình theo thứ tự: environment hiện tại, `.env` ở project đang
chạy, rồi `~/.multix/.env`. Không commit API key hoặc đưa key vào shell history.

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

## Ghi đè model và endpoint

Chỉ đặt override khi cần thay default. Các biến gồm `IMAGE_GEN_MODEL`,
`VIDEO_GEN_MODEL`, `MULTIMODAL_MODEL`, `GEMINI_TTS_MODEL`,
`OPENAI_IMAGE_MODEL`, `OPENAI_TTS_MODEL`, `OPENAI_STT_MODEL`,
`OPENROUTER_IMAGE_MODEL`, `LEONARDO_BASE_URL`, `BYTEPLUS_BASE_URL`,
`BYTEPLUS_IMAGE_MODEL`, `BYTEPLUS_VIDEO_MODEL`, `BYTEPLUS_3D_MODEL`,
`FAL_BASE_URL`, `FAL_IMAGE_MODEL`, `FAL_VIDEO_MODEL` và
`FAL_VIDEO_IMAGE_MODEL` (default image-to-video của fal, dùng khi truyền
`multix fal video --image-url` mà không có `-m`).

Cloudflare chỉ chấp nhận các model image và speech Workers AI có sẵn;
`CLOUDFLARE_AI_IMAGE_MODEL` và `CLOUDFLARE_AI_TTS_MODEL` vì vậy chỉ dùng để
chỉ rõ lựa chọn được hỗ trợ. Chỉ đặt
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` khi muốn thu thập request
payload.

Sau khi đổi credential hoặc endpoint, chạy `multix check --verbose` để xem
provider nào dùng được.
