---
title: MCP server từ xa trên Cloudflare Workers
description: Triển khai multix MCP server lên Cloudflare Workers để AI agent từ xa tạo ảnh và video qua Streamable HTTP với xác thực bearer.
---

Repository có kèm một [Model Context Protocol](https://modelcontextprotocol.io)
server tùy chọn, không trạng thái (stateless), trong thư mục `worker/`. Server
cung cấp các lệnh gọi provider phù hợp chạy từ xa của multix dưới dạng MCP tool
qua **Streamable HTTP** tại `/mcp`, để các agent không chạy được CLI cục bộ
(trợ lý hosted, web IDE, server khác) có thể khởi chạy job ảnh, video và theo
dõi trạng thái.

Worker là package riêng. Nó không nằm trong CLI phát hành trên npm và không
thay đổi cách `multix` chạy trên máy bạn.

## Các tool được cung cấp

| Tool | Mục đích |
|---|---|
| `multix_list_providers` | Provider nào được bật và đã cấu hình, model được phép, và giới hạn của server. |
| `multix_generate_image` | Tạo ảnh từ văn bản trên `replicate` hoặc `atlascloud`. Chờ tối đa `wait_seconds` (mặc định 20, tối đa 25), sau đó trả về URL output hoặc prediction ID để poll. |
| `multix_generate_video` | Tạo video từ văn bản hoặc ảnh trên `replicate`, `atlascloud`, `heygen` hoặc `cloudflare` (Replicate qua AI Gateway). Không bao giờ chờ: trả về prediction ID. |
| `multix_prediction_status` | Poll một prediction theo provider và ID. |
| `multix_prediction_cancel` | Hủy prediction đang chạy (chỉ Replicate). |

Kết quả chứa **URL** do provider lưu trữ, không bao giờ chứa byte của file. Một
số provider trả về URL có chữ ký sẽ hết hạn; hãy tải về sớm. Khi job còn chạy,
kết quả có gợi ý `next` với đúng tham số cần gọi cho `multix_prediction_status`.

### Không hỗ trợ từ xa

Mọi thứ cần hệ thống file hoặc binary cục bộ vẫn chỉ có trong CLI:
`--output`/tải file, input là file cục bộ (chỉ chấp nhận URL ảnh `https://`
công khai), `doc-to-md`, các lệnh ffmpeg và ImageMagick, Gemini/OpenAI/MiniMax
và các provider khác chưa có client độc lập runtime, tạo ảnh và giọng nói
Cloudflare Workers AI (trả về byte), Codex image driver và `multix update`.

## Mô hình credential

Server là **single-tenant**. Provider key là secret của Worker thuộc về người
triển khai, và mọi client đã xác thực đều tiêu credit của tài khoản đó. Client
không bao giờ gửi provider key. Chỉ chia sẻ `MCP_AUTH_TOKEN` với client bạn tin
tưởng giao ngân sách của các key đó, và dùng allowlist cùng giới hạn bên dưới
để kiểm soát phạm vi.

## Triển khai

Yêu cầu: Node 20+, tài khoản Cloudflare và `wrangler` (đã có trong dev
dependency của worker).

```bash
npm ci --prefix worker
cd worker
npx wrangler login

# Bắt buộc: bearer token client phải gửi (ít nhất 32 ký tự)
openssl rand -hex 32 | npx wrangler secret put MCP_AUTH_TOKEN

# Provider key: chỉ đặt những key bạn muốn mở
npx wrangler secret put REPLICATE_API_TOKEN
npx wrangler secret put ATLASCLOUD_API_KEY
npx wrangler secret put HEYGEN_API_KEY
# Video Cloudflare cần cả bốn:
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ID
# (cùng với REPLICATE_API_TOKEN ở trên)

cd ..
npm run deploy:mcp
```

Kiểm tra server (endpoint này công khai và chỉ trả về `{ "ok": true }`):

```bash
curl https://multix-mcp.<your-subdomain>.workers.dev/health
```

### Chạy cục bộ

Sao chép `worker/.dev.vars.example` thành `worker/.dev.vars` (đã được
git-ignore), điền token và các key cần thiết, rồi chạy:

```bash
npm run dev:mcp   # http://localhost:8787/mcp
```

## Kết nối client

Mọi MCP client hỗ trợ Streamable HTTP với header tùy chỉnh đều dùng được. Gửi
token dưới dạng bearer header:

```json
{
  "mcpServers": {
    "multix": {
      "type": "http",
      "url": "https://multix-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

Với Claude Code:

```bash
claude mcp add --transport http multix https://multix-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer $MULTIX_MCP_TOKEN"
```

Luồng video thường gặp: `multix_generate_video` → gọi lại
`multix_prediction_status` mỗi 10–30 giây đến khi `done` là `true` → đọc
`outputs`.

## Cấu hình

Đặt dưới dạng `vars` trong `worker/wrangler.jsonc` hoặc dưới dạng secret:

| Biến | Mặc định | Tác dụng |
|---|---|---|
| `MCP_AUTH_TOKEN` | — (bắt buộc) | Bearer token. Nếu chưa đặt hoặc ngắn hơn 32 ký tự, `/mcp` trả về `503` (fail closed). |
| `MULTIX_MCP_ALLOWED_PROVIDERS` | tất cả | Allowlist provider, phân tách bằng dấu phẩy, ví dụ `replicate,heygen`. |
| `MULTIX_MCP_ALLOWED_MODELS` | bất kỳ | Allowlist `provider:model`, ví dụ `replicate:black-forest-labs/flux-schnell,heygen:heygen-video-1`. Khi đặt, mọi model (kể cả model mặc định) phải có trong danh sách. |
| `MULTIX_MCP_MAX_OUTPUTS` | `4` (tối đa 10) | Số `num_outputs` tối đa mỗi lần tạo ảnh. |
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (tối đa 15) | `duration` video tối đa. Khi caller bỏ qua `duration`, server gửi rõ một thời lượng thay vì để mặc định của provider: `min(5, giới hạn)` giây với Replicate, HeyGen và Cloudflare; với Atlas Cloud xem [Giới hạn chi phí](#mô-hình-bảo-mật). |
| `MULTIX_MCP_ALLOWED_RESOLUTIONS` | `480p,720p,768p,1080p` | Độ phân giải video caller được yêu cầu (`768p` là kích thước của HeyGen Video). Giá trị khác (ví dụ `4k`) bị từ chối trước khi gọi provider. Nếu bỏ qua resolution, model dùng mặc định của nó; với Atlas Cloud, mặc định đó (và mọi `size`, `width` hoặc `height`) cũng được kiểm tra theo danh sách này. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | không có | Origin trình duyệt chính xác (ví dụ `https://app.example.com`) được phép gọi `/mcp`. Không hỗ trợ `*` hay wildcard khác: `*` chỉ khớp origin `*` theo nghĩa đen, thứ trình duyệt không bao giờ gửi. Request có header `Origin` khác nhận `403`; request không có `Origin` (client phía server) được chấp nhận. Origin trong danh sách nhận header CORS, và preflight `OPTIONS` của chúng được trả lời mà không cần token. Request thật vẫn cần bearer token. |

Binding `MCP_RATE_LIMITER` trong `wrangler.jsonc` dùng
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
cho phép khoảng 60 request mỗi phút cho mỗi IP client; request vượt mức nhận
`429`. Giới hạn này chỉ gần đúng: Cloudflare đếm theo từng location và bộ đếm
chỉ nhất quán dần, nên hãy xem nó là lớp chống lạm dụng, không phải ngân sách
chính xác. Điều chỉnh `simple.limit`/`simple.period` tại đó. `namespace_id`
phải là duy nhất trong tài khoản Cloudflare của bạn. Nếu Worker khác đã dùng
`1001`, hãy chọn số nguyên khác, nếu không hai Worker sẽ dùng chung bộ đếm.

## Mô hình bảo mật

- **Xác thực:** mọi request `/mcp` cần `Authorization: Bearer <token>`. Phép so
  sánh chạy thời gian hằng định trên digest SHA-256. Khi thất bại server trả
  `401` không kèm chi tiết.
- **Kiểm tra input:** mọi tham số tool được kiểm tra bằng schema zod (prompt ≤
  4000 ký tự, ID chỉ gồm `[A-Za-z0-9_-]`, số có giới hạn). Body lớn hơn 64 KiB
  bị từ chối với `413`. JSON-RPC batch (body dạng mảng) bị từ chối với `400` /
  `-32600`, nên mỗi request HTTP luôn là một lần gọi tool và rate limit cũng
  giới hạn số lần gọi.
- **Chống SSRF:** `image_url` phải là `https://` trên cổng mặc định, với tên
  miền DNS công khai. Địa chỉ IP, credential trong URL, `localhost`, tên kiểu
  `.local`/`.internal` và host metadata của cloud bị từ chối trước khi gọi
  provider.
- **Giới hạn chi phí:** số output, thời lượng video và độ phân giải video có
  giới hạn, và lệnh tạo video không bao giờ chờ. Với Replicate, HeyGen và
  Cloudflare, `duration` của video luôn được gửi rõ ràng (giá trị của caller
  hoặc `min(5, giới hạn)`), nên mặc định của provider không thể vượt giới hạn.
  Model Replicate đặt tên input thời lượng khác `duration` thì không giới hạn
  được theo cách này.

  Atlas Cloud tự điền mọi trường bị bỏ trống từ schema của model, nên Worker
  đọc schema trước và áp dụng các quy tắc sau trước khi submit. Mọi trường hợp
  bị từ chối đều xảy ra trước bất kỳ lệnh gọi tính phí nào.

  - **Không có schema:** nếu không tải được schema của model (lỗi catalog,
    hoặc model không có trong catalog công khai), mọi lệnh tạo video Atlas đều
    bị từ chối, dù caller truyền gì. Hãy thử lại sau, và dùng
    `MULTIX_MCP_ALLOWED_MODELS` để chỉ cho phép model đã kiểm duyệt.
  - **Trường số giây:** `duration`, `seconds`, `length`, `num_seconds` và
    `video_length`. Giá trị có thể là số hoặc chuỗi như `"8"` hay `"8s"`, và
    `anyOf`/`oneOf` chỉ có một thành phần khác null sẽ được mở ra. Trường số
    giây có type không đọc được theo cách này sẽ bị từ chối.
  - **Caller truyền `duration`:** giá trị được gửi vào trường số giây đầu
    tiên, theo định dạng của schema (`4` thành `"4s"` khi enum là
    `"4s"`/`"8s"`).
  - **Mọi trường số giây khác đều được gửi rõ ràng:** mặc định của schema nếu
    nằm trong giới hạn, chính giới hạn nếu mặc định dài hơn, và
    `min(5, giới hạn)` nếu không có mặc định dương. Giá trị được làm tròn theo
    các giá trị schema cho phép: giá trị enum lớn nhất không vượt nó (nếu
    không có thì giá trị nhỏ nhất trong giới hạn), trong khoảng
    `minimum`/`maximum`. Không bao giờ gửi giá trị 0 hoặc âm (thường nghĩa là
    thời lượng "auto" hay "smart"). Nếu không có giá trị hợp lệ nào nằm trong
    giới hạn, lệnh gọi bị từ chối.
  - **Số frame** (`num_frames`, `frames`): giới hạn ở `giới hạn × fps`, dùng
    mặc định `fps` (hoặc `frames_per_second`) của schema, và được gửi rõ ràng.
    Nếu schema không khai báo frame rate, server giả định một frame mỗi giây,
    nên chỉ mặc định không quá `giới hạn` frame mới được chấp nhận; trường hợp
    khác bị từ chối.
  - **Input khác giống thời lượng:** mọi trường khác có tên chứa `duration`,
    `seconds` hoặc `frames` (ví dụ `duration_seconds`) đều bị từ chối, vì
    Worker không giới hạn được nó.
  - **Kiểm tra cuối:** mọi trường số giây và số frame, dù được gửi hay được
    điền từ mặc định của schema, phải nằm trong giới hạn. `resolution` sẽ được
    render (giá trị của caller hoặc mặc định của schema) phải nằm trong
    `MULTIX_MCP_ALLOWED_RESOLUTIONS`. Giá trị `size`/`video_size`
    (`1920*1080`) hoặc `width`/`height` không được vượt cạnh dài nhất của độ
    phân giải lớn nhất được phép (16:9; `1080p` cho phép 1920 pixel). Giá trị
    không đọc được sẽ bị từ chối.

  Giới hạn: khi schema không khai báo trường kích thước và không có mặc định,
  model tự chọn kích thước đầu ra. Hãy dùng `MULTIX_MCP_ALLOWED_MODELS` để chỉ
  cho phép model đã kiểm duyệt.
- **Log và che thông tin nhạy cảm:** lệnh gọi thành công được log ở mức `info`,
  chỉ gồm tên tool, provider, model, kết quả và độ trễ. Prompt không bao giờ
  được log thành một trường riêng. Lệnh gọi thất bại được log ở mức `warn` (lỗi
  dự kiến) hoặc `error`, kèm thêm trường `detail`. Trường này chứa thông báo lỗi
  từ provider hoặc từ bước kiểm tra input, đã loại bỏ secret đã cấu hình,
  bearer token và query string của URL, và bị cắt ngắn. Vì vậy lỗi provider có
  lặp lại một phần prompt (ví dụ thông báo kiểm duyệt nội dung) có thể xuất
  hiện ở đó. Client nhận cùng nội dung đã làm sạch này.
- **Stateless:** không session, không lưu trữ. Mỗi request tạo một server mới.

Trong CI, bundle Worker được kiểm tra để bảo đảm không chứa module `node:*`,
không import module có sẵn của Node theo tên trần (`fs`, `child_process`,
`path`, …), không có `commander` hay `execa`, và không có mã entry của CLI. Mã
nguồn Worker cũng được kiểm tra kiểu mà không có typings của Node.

## Kiểm thử live

CI chỉ dùng lệnh gọi provider giả lập. Để kiểm tra provider thật từ đầu đến
cuối, hãy chạy bài test live tùy chọn. Bài test bị bỏ qua trừ khi đặt cả
`MULTIX_MCP_LIVE=1` và token Replicate. Nó chạy handler của Worker ngay trong
tiến trình: `tools/list`, rồi tạo một ảnh duy nhất. Thêm
`MULTIX_MCP_LIVE_VIDEO=1` để bắt đầu thêm một video, đọc trạng thái và hủy nó.
Bài test tốn vài cent và không bao giờ in giá trị credential.

```bash
MULTIX_MCP_LIVE=1 REPLICATE_API_TOKEN=r8_... npm test --prefix worker -- live-smoke
```
