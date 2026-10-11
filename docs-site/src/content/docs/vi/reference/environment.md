---
title: Biến môi trường
description: Cấu hình credential, model mặc định và thư mục output của multix bằng biến môi trường.
---

`multix` đọc cấu hình theo thứ tự: environment hiện tại, `.env` ở project đang
chạy, rồi `~/.multix/.env` (cùng [file `.claude` cũ](#file-env-claude-cũ) khi được
bật). Không commit API key hoặc đưa key vào shell history.

Nguồn đầu tiên đặt một biến sẽ thắng. Giá trị rỗng hoặc chỉ có khoảng trắng
trong file `.env` không được tính là đã đặt, nên `.env` của project chép từ
`.env.example` (ví dụ `GEMINI_API_KEY=` hay `FAL_IMAGE_MODEL=`) không che giá
trị trong `~/.multix/.env`. Biến trong shell luôn thắng, kể cả khi rỗng: chạy
`GEMINI_API_KEY= multix ...` để bỏ qua key trong các file `.env` cho một lệnh.

## Biến được phép trong `.env` của project

`.env` của project (thư mục hiện tại, hoặc một file `.claude` cũ nằm trong đó)
chỉ được đặt những biến mà chính `multix` đọc:

- các credential provider liệt kê bên dưới, gồm cả `GEMINI_API_KEY_2`,
  `GEMINI_API_KEY_3`, …;
- các thiết lập provider trong trang này, như `*_BASE_URL`,
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID` và các biến ghi đè model;
- các thiết lập `MULTIX_*` có trong tài liệu: `MULTIX_OUTPUT_DIR` (nên project
  có thể chọn nơi ghi file được tạo), `MULTIX_IMAGE_FORMAT`,
  `MULTIX_MAX_DOWNLOAD_MB`, `MULTIX_UPLOAD_MIN_KBPS` và `MULTIX_DISABLE_HOME_ENV`
  (không có tác dụng ở đó), cùng `NO_COLOR`.

Hai biến opt-in `MULTIX_ALLOW_PROJECT_BASE_URL` và `MULTIX_LEGACY_CLAUDE_ENV` bị
từ chối: repository không được nới rộng những gì nó có thể làm với key của bạn
hay kéo theo credential trong các file `.claude` ở thư mục home.

[`.env.example`](https://github.com/mrgoonie/multix-cli/blob/main/.env.example)
liệt kê các biến này, cùng hai biến opt-in. Mọi tên khác, ví dụ `NODE_OPTIONS`, `npm_config_registry`,
`LD_PRELOAD`, `HTTPS_PROXY` hay `NODE_TLS_REJECT_UNAUTHORIZED`, không được nạp,
nên không bao giờ tới được `multix` hay các công cụ nó khởi chạy (`npm` khi chạy
`multix update`, ffmpeg, ImageMagick, cwebp). `multix` in một cảnh báo duy nhất
ra stderr, liệt kê tên các biến bị bỏ qua, không bao giờ in giá trị:

```text
⚠ Ignoring 2 variable(s) in project env file /repo/.env: NODE_OPTIONS, HTTPS_PROXY. A project .env may only set provider keys and documented multix settings; set anything else in your shell.
```

Hãy đặt những biến đó trong shell. Shell và `~/.multix/.env` không bị lọc. Trên
Windows, việc kiểm tra không phân biệt hoa thường, giống hệ điều hành.

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

Key không bao giờ bị chuyển tiếp sang origin khác khi gặp HTTP redirect. Nếu
một request API bị chuyển hướng (redirect) sang host khác, hoặc từ `https://` sang `http://`,
multix dừng lại và báo mã HTTP 3xx thay vì đi theo. Bản tải xuống mà provider
chuyển sang host lưu trữ vẫn hoạt động, nhưng header chứa key được gỡ bỏ trước
khi đi theo redirect đó.

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
- `multix doc convert` chỉ thử lại một file sau lỗi mạng, timeout, 408 và 5xx
  (trừ 501 và 505). Lệnh dừng khi gặp giới hạn, vì xoay vòng đã thử mọi key sẵn
  sàng, và báo lỗi ngay khi thiếu key hoặc gặp mã 4xx khác. Lượt upload qua Files
  API bị timeout khi đang gửi dữ liệu file, hoặc bị server chuyển hướng, cũng
  không được thử lại; request không thể gửi đi được, ví dụ API key chứa ký tự
  không phải ASCII (như dấu nháy cong), cũng vậy.
- Thời gian nghỉ chỉ tồn tại trong process hiện tại. Log chỉ ghi tên biến môi
  trường, không bao giờ ghi giá trị key.
- `multix check` liệt kê các key đang xoay vòng và ping từng key.
- Quota Gemini tính theo từng Google Cloud project. Các key cùng project dùng
  chung quota, nên xoay vòng chỉ có ích với key thuộc các project khác nhau.

## File env `.claude` cũ

Bản cài AgentKit cũ lưu key trong các thư mục `.claude`. Đặt
`MULTIX_LEGACY_CLAUDE_ENV=1` (trong shell hoặc `~/.multix/.env`; `.env` của project
không thể đặt biến này) để đọc thêm các file này. Mặc định tính năng này tắt. Các file
được nạp sau `~/.multix/.env`, không bao giờ ghi đè giá trị không rỗng đã có,
và file đầu tiên đặt một biến sẽ thắng:

1. `.claude/skills/ai-multimodal/.env`, rồi `.claude/skills/ak-ai-multimodal/.env`
2. `.claude/skills/.env`
3. `.claude/.env`

Thư mục project được đọc trước, sau đó là các file tương tự trong thư mục home.
Chỉ các tên dạng credential được lấy từ những file này: tên kết thúc bằng
`_API_KEY` (có thể đánh số, như `GEMINI_API_KEY_2`), `_API_TOKEN`, `_ACCOUNT_ID`
hoặc `_GATEWAY_ID`, cùng `FAL_KEY` và `ARK_API_KEY`. Các thiết lập endpoint,
proxy và runtime như `*_BASE_URL` bị bỏ qua. Các file trong thư mục hiện tại
còn bị giới hạn ở những tên mà `multix` đọc (xem
[Biến được phép trong `.env` của project](#biến-được-phép-trong-env-của-project));
các tên khác trong đó bị bỏ qua mà không cảnh báo. Account ID và gateway ID lấy từ
các file `.claude` của thư mục hiện tại tuân theo cùng quy tắc tin cậy như
`.env` của project (xem
[Ghi đè base URL và độ tin cậy](#ghi-đè-base-url-và-độ-tin-cậy)). Bản thân cờ
này bị bỏ qua nếu đặt trong các file đó.
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
`REPLICATE_API_TOKEN`. `MULTIX_MAX_DOWNLOAD_MB` đặt giới hạn dung lượng cho
mỗi file output Replicate hoặc Atlas Cloud được tải về (mặc định 2048); xem
[Replicate](/vi/commands/replicate/) và [Atlas Cloud](/vi/commands/atlascloud/)
để biết chính sách tải file.

`MULTIX_UPLOAD_MIN_KBPS` đặt tốc độ upload chậm nhất, tính theo kilobyte (1.000
byte) mỗi giây, mà một lần upload lên Gemini Files API được cho đủ thời gian
(mặc định `1000`, tức 1 MB/s cộng thêm một phút; tối thiểu `1`). Giảm giá trị
này khi đường truyền chậm để file lớn không bị hết thời gian chờ; xem
[Gemini](/vi/commands/gemini/).

Atlas Cloud nhận `ATLASCLOUD_BASE_URL` (base của media API, mặc định
`https://api.atlascloud.ai/api/v1`; phải dùng `https://`, còn `http://` chỉ được
chấp nhận cho `localhost`, `127.0.0.1` hoặc `[::1]`) và một biến ghi đè model
mặc định cho mỗi lệnh: `ATLASCLOUD_IMAGE_MODEL`, `ATLASCLOUD_IMAGE_EDIT_MODEL`,
`ATLASCLOUD_VIDEO_MODEL`, `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL`,
`ATLASCLOUD_TTS_MODEL`, `ATLASCLOUD_STT_MODEL`, `ATLASCLOUD_TEXT_TO_3D_MODEL`
và `ATLASCLOUD_IMAGE_TO_3D_MODEL`. Xem [Atlas Cloud](/vi/commands/atlascloud/)
để biết các model mặc định. `ATLASCLOUD_MAX_UPLOAD_MB` đặt giới hạn dung lượng
cho file cục bộ upload lên Atlas Cloud (mặc định 200).

`HEYGEN_BASE_URL` ghi đè API base của HeyGen (mặc định
`https://api.heygen.com`) cho proxy và test. Giá trị phải là `https://`;
`http://` chỉ được chấp nhận cho `localhost`, `127.0.0.1` hoặc `[::1]`.

### Ghi đè base URL và độ tin cậy

Biến ghi đè `*_BASE_URL` quyết định API key của bạn được gửi tới đâu.
`CLOUDFLARE_ACCOUNT_ID` và `CLOUDFLARE_AI_GATEWAY_ID` cũng vậy: chúng chọn
account Cloudflare và AI Gateway nào nhận token của bạn. Giá trị từ biến môi
trường của shell hoặc `~/.multix/.env` luôn được dùng. Giá trị từ `.env` của
project (thư mục hiện tại, hoặc một file `.claude` cũ bên trong nó) chỉ được
dùng khi nó không thể gửi key của người khác:

- Giá trị được dùng khi mọi key mà provider gửi kèm request đó đều đến từ cùng
  file project, vì khi đó key duy nhất được gửi đi là key của chính repository.
  Ví dụ: `FAL_BASE_URL` và `FAL_KEY` cùng nằm trong `.env` của project, hoặc
  `CLOUDFLARE_API_TOKEN` cùng với account ID và gateway ID. Video Cloudflare
  còn gửi `REPLICATE_API_TOKEN`, nên token này cũng phải đến từ cùng file đó.
  Quy tắc này bảo vệ key của bạn, không bảo vệ dữ liệu của bạn: một `.env` của
  project có sẵn key và base URL riêng sẽ gửi các request trong project đó, kể cả
  prompt và mọi file bạn tải lên, tới host đó, và key của nó thay thế key của bạn
  trong `~/.multix/.env`. Hãy xem kỹ `.env` của repository vừa clone trước khi
  chạy `multix` trong đó.
- Giá trị bị bỏ qua khi có key đến từ nơi khác: shell, `~/.multix/.env`, một
  file cũ trong thư mục home, hoặc một file project khác. Nếu `~/.multix/.env`
  đặt cùng biến đó, giá trị ở đó được dùng và `multix` in một cảnh báo nêu tên
  biến, đường dẫn file và nguồn của key (không bao giờ in giá trị). Nếu không,
  lệnh dừng với một lỗi trước khi gửi bất kỳ request nào. Lệnh không quay về
  giá trị mặc định của nhà cung cấp, nên request bạn định gửi tới mock server
  không bao giờ tới API trả phí.
- Giá trị rỗng trong project không bao giờ che giá trị trong `~/.multix/.env`.
- `multix check` liệt kê từng thiết lập loại này đang được đặt, và cho biết nó
  đang có hiệu lực hay bị bỏ qua (ví dụ
  `FAL_BASE_URL ignored: set in project .env while FAL_KEY comes from the shell`).
  Lệnh này dùng đúng các bước kiểm tra của các lệnh khác, nên nó cũng báo base
  URL vi phạm quy tắc `https://` và ID Cloudflare dùng được cho image và speech
  nhưng không dùng được cho video.
- Để dùng giá trị của project (ví dụ mock server cục bộ), bật cho đúng một lệnh
  từ shell: `MULTIX_ALLOW_PROJECT_BASE_URL=1 multix ...`. Tránh đặt biến này
  trong `~/.multix/.env`: như vậy sẽ tắt cơ chế bảo vệ cho mọi thư mục bạn chạy
  `multix`. Biến này bị bỏ qua nếu được đặt ngay trong `.env` của project.
- Base URL khác mặc định phải dùng `https://`; `http://` chỉ được chấp nhận cho
  `localhost`, `127.0.0.1` hoặc `[::1]`.
- Khi một base URL khác mặc định đang được dùng, `multix` in một cảnh báo cho
  mỗi biến, nêu provider và chỉ hostname, không bao giờ in key hay URL đầy đủ.
  Cảnh báo được ghi ra stderr nên stdout vẫn đọc được bằng máy.

`.env` của project hoàn toàn không thể đặt biến proxy, TLS hay Node (xem
[Biến được phép trong `.env` của project](#biến-được-phép-trong-env-của-project)),
nhưng vẫn có thể chọn model và, với key của chính nó, chọn endpoint. Đừng chạy `multix` trong repository có `.env` mà bạn chưa đọc.

Cloudflare chỉ chấp nhận các model image và speech Workers AI có sẵn;
`CLOUDFLARE_AI_IMAGE_MODEL` và `CLOUDFLARE_AI_TTS_MODEL` vì vậy chỉ dùng để
chỉ rõ lựa chọn được hỗ trợ. Chỉ đặt
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` khi muốn thu thập request
payload.

Sau khi đổi credential hoặc endpoint, chạy `multix check --verbose` để xem
provider nào dùng được.
