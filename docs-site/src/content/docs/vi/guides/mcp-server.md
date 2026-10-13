---
title: MCP server từ xa trên Cloudflare Workers
description: Triển khai multix MCP server lên Cloudflare Workers để AI agent từ xa tạo ảnh và video, hoặc chạy lệnh multix CLI bất kỳ trong Cloudflare Container, qua Streamable HTTP, với đăng nhập GitHub, OAuth và dashboard quản lý provider key cùng bucket R2 của từng tài khoản.
---

Repository có kèm một [Model Context Protocol](https://modelcontextprotocol.io)
server tùy chọn, không trạng thái (stateless), trong thư mục `worker/`. Server
cung cấp các lệnh gọi provider phù hợp chạy từ xa của multix dưới dạng MCP tool
qua **Streamable HTTP** tại `/mcp`, để các agent không chạy được CLI cục bộ
(trợ lý hosted, web IDE, server khác) có thể khởi chạy job ảnh, video và theo
dõi trạng thái. Khi Worker được triển khai kèm container chạy job, các agent
này còn chạy được hầu hết lệnh `multix` CLI từ xa: mỗi lần chạy có một
[Cloudflare Container](https://developers.cloudflare.com/containers/) riêng đã
cài CLI, ffmpeg và ImageMagick, và file đầu ra được tải lên bucket R2 của chính
người gọi.

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
| `multix_catalog` | Các lệnh CLI mà `multix_run` chạy được. Không có `group`: mọi nhóm lệnh, các lệnh trong nhóm và bạn đã lưu key cho nhóm đó chưa. Có `group`: positional và option của từng lệnh, option nào nhận file, và giá trị server bắt buộc. |
| `multix_run` | Chạy một lệnh CLI trong container riêng bằng key đã lưu của bạn. Chờ tối đa `wait_seconds` (mặc định 25, tối đa 40, tính cả thời gian khởi động container), sau đó trả về kết quả hoặc job ID để poll. Mỗi tài khoản chạy tối đa 2 job cùng lúc. |
| `multix_job_status` | Đọc job `multix_run`: trạng thái, URL output, stdout và phần cuối của stderr. |
| `multix_job_cancel` | Dừng job đang chạy cùng container của nó. |

Năm tool đầu gọi API của provider trực tiếp từ Worker. Kết quả của chúng chứa
**URL** do provider lưu trữ, không bao giờ chứa byte của file. Một số provider
trả về URL có chữ ký sẽ hết hạn; hãy tải về sớm. Khi job còn chạy, kết quả có
gợi ý `next` với đúng tham số cần gọi cho `multix_prediction_status`.

Bốn tool cuối chỉ xuất hiện khi Worker có binding container chạy job
(`MULTIX_JOBS`, xem [Triển khai](#triển-khai)).

## Chạy lệnh CLI

`multix_run` nhận đúng lệnh và option bạn vẫn gõ trên máy, dưới dạng JSON:

- `command`: đường dẫn lệnh, ví dụ `"gemini generate"` hoặc `"media optimize"`.
  Không chạy được `multix check` và `multix update`.
- `options`: option theo tên dài, không có dấu gạch ngang. Giá trị là chuỗi,
  số, `true` cho cờ (kể cả cờ `no-*`), hoặc danh sách cho option lặp lại được.
- `args`: các positional, theo thứ tự.
- `inputs`: URL `https://` công khai cho option và positional nhận file, theo
  tên của chúng. Container tải các file này về (tối đa 10 file, mỗi file
  200 MB) và truyền đường dẫn cục bộ cho CLI. Đường dẫn file thường bị từ
  chối. Ở chỗ provider nhận asset ID của chính nó, có thể truyền `asset:<id>`
  làm giá trị.
- `wait_seconds`: thời gian lệnh gọi chờ job, tính từ lúc gọi nên đã gồm cả
  thời gian khởi động container (0–40, mặc định 25).

Gọi `multix_catalog` kèm group để xem chính xác lệnh nhận option nào và option
nào là file. Ví dụ một lệnh gọi:

```json
{
  "command": "gemini analyze",
  "options": { "prompt": "Tóm tắt clip này thành ba gạch đầu dòng" },
  "inputs": { "files": "https://cdn.example.com/clip.mp4" },
  "wait_seconds": 40
}
```

Kết quả luôn có cùng dạng:

```json
{
  "job_id": "4b0c…",
  "status": "succeeded",
  "outputs": [{ "name": "frame.png", "url": "https://…", "bytes": 48213 }],
  "stdout": "…",
  "stderr_tail": "",
  "exit_code": 0
}
```

`status` là `running`, `succeeded`, `failed`, `timed_out` hoặc `canceled`. Khi
còn `running`, kết quả có gợi ý `next`: gọi `multix_job_status` với `job_id`
mỗi 10–30 giây. Một giới hạn 30 phút áp dụng cho toàn bộ job: tải input, chạy
CLI và tải output lên. Bản ghi của job được giữ 7 ngày. Chỉ tài khoản đã khởi
chạy job mới đọc hoặc hủy được job đó.

**Số job đồng thời.** Mỗi tài khoản chạy tối đa **2** job cùng lúc. Lệnh
`multix_run` thứ ba báo lỗi `busy: you already have 2 running jobs` cho đến khi
một job kết thúc; nếu cần, hủy bớt bằng `multix_job_cancel`. Suất chạy của job
được trả lại khi job kết thúc, và tự giải phóng sau khoảng 45 phút nếu job bị
mất. Khi mọi container chạy job trên server đều đang bận (`max_instances`),
lệnh gọi báo lỗi `server at capacity`; hãy thử lại sau vài phút.

**File đầu ra cần R2.** Các file CLI ghi ra được tải lên bucket R2 của bạn dưới
`multix/<hash tài khoản>/<job id>/<tên>`, và `outputs` liệt kê URL công khai
hoặc presigned của chúng. Mỗi job báo cáo tối đa 50 file, và file lớn hơn
500 MB được liệt kê với `url: null` thay vì được tải lên. Nếu bạn chưa lưu bucket R2, job vẫn chạy nhưng mỗi
output có `url: null` và kết quả kèm `note` nhắc bạn cấu hình R2 tại
`/dashboard`. stdout (gồm cả URL provider mà CLI in ra) vẫn được trả về trong
cả hai trường hợp. Key không bao giờ xuất hiện trong `stdout` hay
`stderr_tail`: giá trị các key đã lưu của bạn được thay bằng `[redacted]`.

Giới hạn của server cũng áp dụng cho `multix_run`: số output
(`MULTIX_MCP_MAX_OUTPUTS`), độ dài video (`MULTIX_MCP_MAX_VIDEO_SECONDS`, cũng
được gửi khi mặc định của lệnh video không rõ hoặc dài hơn) và độ phân giải
(`MULTIX_MCP_ALLOWED_RESOLUTIONS`). Server tự chọn thư mục đầu ra, `--output`
phải là tên file thuần, option mà CLI ghép vào tên file (như
`elevenlabs voices design --output-prefix` hoặc mã ngôn ngữ khi lồng tiếng) chỉ
nhận chữ cái, chữ số, `_` và `-`, các lệnh ảnh OpenAI luôn dùng API driver, và
giá trị `@file` bị từ chối. Lệnh thay đổi chính tài khoản provider của bạn (ví
dụ xóa một giọng ElevenLabs) chạy như mọi lệnh khác, bằng key của bạn.

### Không hỗ trợ từ xa

- File cục bộ: thay bằng URL `https://` công khai trong `inputs`.
- Tính năng tương tác hoặc chỉ chạy cục bộ: `multix update`, `multix check`,
  Codex image driver, `--stdin-ext`, và đọc giá trị từ `@file`.
- Chọn nơi lưu file: server tự đặt thư mục đầu ra. Hãy tải output từ URL R2.
- Khi không có container chạy job, `multix_run` và các tool job khác không
  được liệt kê, chỉ còn năm tool provider.

## Tài khoản và credential

Server hỗ trợ **nhiều tài khoản**. Mỗi người đăng nhập bằng GitHub và lưu
provider key của riêng mình trong dashboard tại `/dashboard`. Mỗi request MCP
chạy bằng key của tài khoản đã phê duyệt kết nối, nên mỗi người tự tiêu credit
của mình. Người vận hành không đặt provider key trên Worker, và key đặt ở đó sẽ
bị bỏ qua.

- **Ai được đăng nhập:** chỉ người dùng GitHub có trong `MULTIX_ALLOWED_USERS`.
  Danh sách được kiểm tra khi đăng nhập và ở mọi request dashboard và `/mcp`,
  nên xóa một tên sẽ cắt luôn các kết nối hiện có của tài khoản đó.
- **Lưu key:** key được mã hóa bằng AES-GCM (khóa `SECRETS_ENCRYPTION_KEY`,
  gắn với tài khoản và tên key) và lưu trong namespace `ACCOUNTS_KV`.
  Dashboard chỉ cho biết key đã được đặt hay chưa và khi nào; giá trị đã lưu
  không bao giờ được hiển thị lại. KV chỉ nhất quán dần, nên key mới thêm hoặc
  vừa xóa có thể mất khoảng một phút để đến mọi location của Cloudflare.
- **Token GitHub:** chỉ dùng một lần để đọc hồ sơ và email đã xác minh, rồi bị
  bỏ đi. multix lưu GitHub user ID, login, tên, URL avatar và các email đã xác
  minh.
- **Những key nào:** dashboard có ô nhập cho mọi tên biến môi trường chứa key
  mà CLI đọc, nhóm theo provider kèm liên kết đến trang tạo key (Gemini,
  OpenRouter, OpenAI, MiniMax, Leonardo.Ai, BytePlus với `ARK_API_KEY` làm tên
  dự phòng, ElevenLabs, fal.ai, Atlas Cloud, Replicate với `REPLICATE_API_KEY`
  làm tên dự phòng, HeyGen), cùng account ID, API token và AI Gateway ID (tùy
  chọn) của Cloudflare Workers AI. Các tool ảnh và video ở trên chỉ dùng key
  Replicate, Atlas Cloud, HeyGen và Cloudflare.

### Lưu trữ R2

Mỗi tài khoản cũng có thể lưu bucket Cloudflare R2 của riêng mình.
`multix_run` tải mọi file đầu ra lên đó; không có bucket thì job vẫn chạy
nhưng không trả về URL file. Năm tool provider trả về URL của provider và
không dùng R2.

1. Trong Cloudflare dashboard, tạo một bucket và một R2 API token có quyền
   **Object Read & Write** trên bucket đó.
2. Trong thẻ **R2 storage** tại `/dashboard`, nhập account ID (32 ký tự hex),
   access key ID và secret access key của token, tên bucket và, nếu muốn, một
   URL gốc công khai `https://` (custom domain hoặc địa chỉ `r2.dev` phục vụ
   bucket). Không có URL công khai thì file nhận liên kết presigned có hiệu lực
   tối đa 7 ngày.
3. **Check and save** liệt kê bucket (`ListObjectsV2`, một key), tải lên một
   object rỗng `.multix-probe-*` rồi xóa nó. Nếu một bước thất bại thì không có
   gì được lưu; trang cho biết bước nào (credential bị từ chối, không có
   bucket, token chỉ đọc, không xóa được object thử, không kết nối được R2).
   Nên dùng token chỉ cấp quyền cho một bucket: token toàn tài khoản truy cập
   được mọi bucket.

Thiết lập được lưu thành một bản ghi AES-GCM dưới `r2:<account>` trong
`ACCOUNTS_KV`, giống provider key. Trang chỉ hiển thị tên bucket và URL công
khai; khi thay thiết lập phải nhập lại secret. **Remove** sẽ xóa chúng.

## Triển khai

Yêu cầu: Node 20+, tài khoản Cloudflare có zone cho tên miền của bạn, và
`wrangler` (đã có trong dev dependency của worker). Trình chạy CLI còn cần
[gói Workers Paid](https://developers.cloudflare.com/containers/pricing/)
(Containers) và Docker đang chạy trên máy triển khai: `wrangler deploy` build
`worker/container/Dockerfile` từ thư mục gốc của repository và đẩy image lên
Cloudflare.

1. **Tạo GitHub OAuth App** tại
   [github.com/settings/applications/new](https://github.com/settings/applications/new).
   Homepage URL: origin công khai của bạn (ví dụ `https://mcp.example.com`).
   Authorization callback URL: `<origin>/oauth/github/callback`.
2. **Tạo hai KV namespace** và điền ID vào `worker/wrangler.jsonc`
   (`OAUTH_KV` chứa OAuth client, grant và token đã hash; `ACCOUNTS_KV` chứa
   tài khoản và provider key đã mã hóa):

   ```bash
   cd worker
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler kv namespace create ACCOUNTS_KV
   ```

3. **Sửa `worker/wrangler.jsonc`:** đặt `routes` theo host của bạn,
   và `MULTIX_PUBLIC_URL` là origin công khai. File trong repository đang cấu
   hình cho `multix.zuey.me`. Mục `containers` (class `MultixJobContainer`,
   instance type `basic`, tối đa 10 instance) và binding Durable Object
   `MULTIX_JOBS` bật `multix_run`. Để triển khai không kèm trình chạy CLI
   (không cần Docker, dùng được Workers Free), xóa `containers`,
   `durable_objects` và `exports`; khi đó bốn tool job không được liệt kê.
   Binding `MULTIX_JOB_QUOTA` (class `AccountJobQuota`) giữ số job đang chạy
   của từng tài khoản và phải đi cùng `MULTIX_JOBS`.
4. **Đặt secret** và triển khai:

   ```bash
   npm ci --prefix worker
   cd worker
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   openssl rand -base64 32 | npx wrangler secret put SECRETS_ENCRYPTION_KEY
   # Login GitHub hoặc email đã xác minh được phép đăng nhập, phân tách bằng dấu phẩy
   npx wrangler secret put MULTIX_ALLOWED_USERS
   cd ..
   npm run deploy:mcp
   ```

Giữ kỹ `SECRETS_ENCRYPTION_KEY`: thay khóa này khiến mọi provider key đã lưu
không đọc được nữa. Các provider đó sẽ báo chưa được cấu hình cho đến khi mỗi
tài khoản lưu lại key. Thay `SESSION_SECRET`
sẽ đăng xuất mọi người khỏi dashboard.

Kiểm tra server (endpoint này công khai và chỉ trả về `{ "ok": true }`):

```bash
curl https://mcp.example.com/health
```

### Dùng chung host với site khác

Worker chỉ cần các path: `/mcp`, `/dashboard`, `/oauth/*`,
`/.well-known/oauth-*` và `/health`. Route theo path được ưu tiên hơn Custom
Domain trên cùng host, nên một Worker khác (ví dụ site tài liệu) vẫn phục vụ
mọi path còn lại. `multix.zuey.me` được thiết lập theo cách này.

### Chạy cục bộ

Tạo GitHub OAuth App thứ hai với callback
`http://localhost:8787/oauth/github/callback`. Sao chép
`worker/.dev.vars.example` thành `worker/.dev.vars` (đã được git-ignore), điền
giá trị, rồi chạy:

```bash
npm run dev:mcp   # http://localhost:8787/mcp và /dashboard
```

## Kết nối client

1. Đăng nhập tại `<origin>/dashboard` và lưu các provider key bạn muốn dùng.
2. Thêm server vào bất kỳ MCP client nào hỗ trợ server từ xa với OAuth
   (Claude, Claude Code, Cursor, VS Code, …). Client tự đăng ký, mở trình
   duyệt để đăng nhập GitHub, và yêu cầu bạn phê duyệt kết nối.

Với Claude Code:

```bash
claude mcp add --transport http multix https://mcp.example.com/mcp
```

Sau đó chạy `/mcp` trong Claude Code và chọn **Authenticate**. Client khác:

```json
{
  "mcpServers": {
    "multix": { "type": "http", "url": "https://mcp.example.com/mcp" }
  }
}
```

Các client đã kết nối hiện trong dashboard, nơi nút **Disconnect** thu hồi
quyền truy cập của chúng. Tool cần một provider mà bạn chưa lưu key sẽ báo
provider đó chưa được cấu hình.

Luồng video thường gặp: `multix_generate_video` → gọi lại
`multix_prediction_status` mỗi 10–30 giây đến khi `done` là `true` → đọc
`outputs`. Với các lệnh CLI khác: `multix_catalog` → `multix_catalog` kèm
group → `multix_run` → gọi lại `multix_job_status` đến khi `status` là
`succeeded`, `failed`, `timed_out` hoặc `canceled` → đọc `outputs`.

## Cấu hình

Secret (đặt bằng `npx wrangler secret put <NAME>`):

| Secret | Tác dụng |
|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth App dùng để đăng nhập. |
| `SESSION_SECRET` | Ít nhất 32 ký tự. Ký cookie dashboard và token của form. |
| `SECRETS_ENCRYPTION_KEY` | Base64 của đúng 32 byte ngẫu nhiên. Mã hóa provider key đã lưu. |
| `MULTIX_ALLOWED_USERS` | Login GitHub (không phân biệt hoa thường) hoặc email đã xác minh (mục có `@`) được phép đăng nhập, phân tách bằng dấu phẩy. Chưa đặt hoặc để trống thì không ai đăng nhập được. Đặt dưới dạng secret để danh sách (có thể chứa email) không nằm trong repository, và đổi được mà không cần deploy. |

Nếu thiếu hoặc sai một trong bốn secret đầu, hoặc `MULTIX_PUBLIC_URL` không phải
origin `https://`, đăng nhập, trang phê duyệt và dashboard trả về `503` (fail
closed). `http://localhost` được chấp nhận khi phát triển cục bộ.

Đặt dưới dạng `vars` trong `worker/wrangler.jsonc`:

| Biến | Mặc định | Tác dụng |
|---|---|---|
| `MULTIX_PUBLIC_URL` | — (bắt buộc) | Origin công khai, ví dụ `https://mcp.example.com`. Dùng cho metadata OAuth, redirect và callback GitHub. |
| `MULTIX_MCP_ALLOWED_PROVIDERS` | tất cả | Allowlist provider, phân tách bằng dấu phẩy, ví dụ `replicate,heygen`. |
| `MULTIX_MCP_ALLOWED_MODELS` | bất kỳ | Allowlist `provider:model`, ví dụ `replicate:black-forest-labs/flux-schnell,heygen:heygen-video-1`. Khi đặt, mọi model (kể cả model mặc định) phải có trong danh sách. |
| `MULTIX_MCP_MAX_OUTPUTS` | `4` (tối đa 10) | Số `num_outputs` tối đa mỗi lần tạo ảnh. |
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (tối đa 15) | `duration` video tối đa. Khi caller bỏ qua `duration`, server gửi rõ một thời lượng thay vì để mặc định của provider: `min(5, giới hạn)` giây với Replicate, HeyGen và Cloudflare; với Atlas Cloud xem [Giới hạn chi phí](#mô-hình-bảo-mật). |
| `MULTIX_MCP_ALLOWED_RESOLUTIONS` | `480p,720p,768p,1080p` | Độ phân giải video caller được yêu cầu (`768p` là kích thước của HeyGen Video). Giá trị khác (ví dụ `4k`) bị từ chối trước khi gọi provider. Nếu bỏ qua resolution, model dùng mặc định của nó; với Atlas Cloud, mặc định đó (và mọi `output_resolution`, `target_resolution`, `quality` mang giá trị độ phân giải, `size`, `width` hoặc `height`, hoặc độ phân giải nêu trong ID model) cũng được kiểm tra theo danh sách này. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | không có | Origin trình duyệt chính xác (ví dụ `https://app.example.com`) được phép gọi `/mcp`. Không hỗ trợ `*` hay wildcard khác: `*` chỉ khớp origin `*` theo nghĩa đen, thứ trình duyệt không bao giờ gửi. Sau khi access token được kiểm tra, request có header `Origin` khác nhận `403`; request không có `Origin` (client phía server) được chấp nhận. Origin trong danh sách nhận header CORS. Preflight `OPTIONS` được lớp OAuth trả lời cho mọi origin. |

Hai binding [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
trong `wrangler.jsonc` chặn lạm dụng; request vượt mức nhận `429`:

- `MCP_RATE_LIMITER`: khoảng 60 request `/mcp` mỗi phút cho mỗi tài khoản.
- `AUTH_RATE_LIMITER`: khoảng 30 request mỗi phút cho mỗi IP client ở các
  bước đăng nhập, yêu cầu ủy quyền, đăng ký client, cấp token và thao tác ghi
  trên dashboard.

Các giới hạn này chỉ gần đúng: Cloudflare đếm theo từng location và bộ đếm chỉ
nhất quán dần, nên hãy xem chúng là lớp chống lạm dụng, không phải ngân sách
chính xác. Điều chỉnh `simple.limit`/`simple.period` tại đó. `namespace_id`
phải là duy nhất trong tài khoản Cloudflare của bạn. Nếu Worker khác đã dùng
`1001` hoặc `1002`, hãy chọn số nguyên khác, nếu không hai Worker sẽ dùng
chung bộ đếm.

## Mô hình bảo mật

- **Xác thực:** `/mcp` là protected resource OAuth 2.1, phục vụ bằng
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  Client tìm thấy nó qua `/.well-known/oauth-protected-resource/mcp` và
  `/.well-known/oauth-authorization-server`, đăng ký động (`/oauth/register`)
  hoặc bằng Client ID Metadata Document, và dùng PKCE. Request không có access
  token hợp lệ nhận `401` kèm challenge `WWW-Authenticate`. Token được lưu dạng
  hash trong `OAUTH_KV`.
- **Đăng nhập và phê duyệt:** GitHub OAuth (có PKCE và `state`), sau đó là
  trang phê duyệt ghi tên client và địa chỉ redirect của nó. Tài khoản không có
  trong `MULTIX_ALLOWED_USERS` bị từ chối trước khi lưu bất cứ thứ gì.
- **Dashboard:** cookie có tiền tố `__Host-`, `Secure`, `HttpOnly`,
  `SameSite=Lax` và được ký HMAC, phiên kéo dài 7 ngày. **Sign out** kết thúc
  mọi phiên dashboard của tài khoản trên mọi thiết bị (có thể mất khoảng một
  phút để đến mọi location); kết nối MCP vẫn giữ cho đến khi bạn ngắt. Mọi form
  cần CSRF token theo phiên và header `Origin` cùng origin. Các trang gửi Content Security
  Policy chặt và `frame-ancestors 'none'`.
- **Cô lập tài khoản:** mỗi request `/mcp` chỉ tải key của tài khoản đã cấp
  token. Key không bao giờ xuất hiện trong trang, log hay kết quả tool.
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
    bị từ chối, dù caller truyền gì, và không có request nào được gửi. Chỉ
    thử lại khi schema tải được mới giúp được; ghim model không bỏ qua bước
    kiểm tra này.
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
  - **Input khác giống thời lượng:** mọi trường khác có tên chứa `frame`,
    `second`, `duration` hoặc `length`, hoặc kết thúc bằng `_len` (ví dụ
    `frame_count` hay `clip_length`), đều bị từ chối khi là số hoặc khi
    schema của nó không đọc được, vì Worker không giới hạn được nó. Input ảnh
    và cờ như `first_frame` hay `return_last_frame` không bị ảnh hưởng.
  - **Kiểm tra cuối:** mọi trường số giây và số frame, dù được gửi hay được
    điền từ mặc định của schema, phải nằm trong giới hạn. Mọi trường độ phân
    giải sẽ được render (giá trị được gửi hoặc mặc định của schema) phải nằm
    trong `MULTIX_MCP_ALLOWED_RESOLUTIONS`. Các trường độ phân giải là
    `resolution`, `output_resolution`, `target_resolution`, và `quality` khi
    giá trị, mặc định hoặc enum của nó trông như độ phân giải (ví dụ `720p`,
    `1080p`, `2k`, `4k`, hoặc số nguyên là chiều cao video như `1080`). Số
    nguyên như `1080` được hiểu là `1080p`; `4k` và `2160p` là hai mục khác
    nhau trong allowlist. `quality` như `high`, `standard` hay thang `1`–`5`
    không phải độ phân giải nên được giữ nguyên; `quality` có schema mà server
    không đọc được (`$ref`, `allOf`) sẽ bị từ chối. Chỉ
    `resolution` là tham số của tool, nên model có trường độ phân giải khác
    nằm ngoài danh sách sẽ bị từ chối. Model mà ID nêu một độ phân giải thành
    token riêng, ngăn cách bởi `/`, `-` hoặc `_` (như
    `kwaivgi/kling-video-o3-4k/...` hay `kling-v3.0-4k`, đều là `4k`), render
    và tính phí ở độ phân giải đó, nên bị từ chối khi độ phân giải này không có
    trong danh sách, kể cả khi trường độ phân giải của chính model có mặc định
    hợp lệ. Quy tắc này cũng áp dụng cho preset `template` có nêu độ phân giải
    (mặc định `anime-enhance-4k` của Tencent upscaler là `4k`); nếu không có
    mặc định thì mọi preset trong danh sách đều phải được cho phép, và schema
    `template` mà server không đọc được sẽ bị từ chối. Các chuỗi trông giống như
    `2.4k` hay `4kids` không được tính. Giá trị `size`/`video_size`
    (`1920*1080`) hoặc cặp `width`/`height` phải nằm trong độ phân giải lớn
    nhất được phép ở tỉ lệ 16:9, theo cả hai chiều: `1080p` cho phép cạnh dài
    tối đa 1920 và cạnh ngắn tối đa 1080, nên `1920*1920` bị từ chối. Giá trị
    hoặc dạng schema không đọc được (`$ref`, `allOf`, union nhiều thành phần
    không có mặc định bên ngoài) sẽ bị từ chối.
  - **Các hệ số giá khác** được gửi ở giá trị rẻ nhất, vì tool không có
    tham số cho chúng và mặc định của schema thường là lựa chọn đắt:
    - **Công tắc tốn phí** `generate_audio`, `sound`, `audio`, `bgm`,
      `enable_thinking` và `hdr` được gửi ở trạng thái tắt: `false`, hoặc,
      khi schema dùng enum, giá trị `false`, `"no"`, `"off"`, `"none"` hoặc
      `"disabled"` của enum đó. `audio` kiểu chuỗi không có mặc định là URL
      đầu vào nên được giữ nguyên. Công tắc không có giá trị tắt sẽ bị từ
      chối. `bgm` (nhạc nền) của Vidu mặc định bật. Cả Atlas Cloud lẫn Vidu
      đều không công bố nó có làm đổi giá hay không, nên nó được coi là input
      tính giá và được gửi ở trạng thái tắt.
    - **Số lượng output** được gửi là `1`. Các trường chính xác là `n`,
      `count`, `batch_size`, `batch_count`, `num_output`, `num_video`,
      `num_sample`, `num_generation`, `num_result`, `output_count`,
      `video_count`, `sample_count` và `generation_count` (mỗi tên cũng khớp
      dạng số nhiều có `s`, như `num_videos` hoặc `videos_count`). Các trường
      `*_count` khác, như `face_count`, không phải số lượng output
      (`frame_count` là độ dài, xem ở trên). Nếu schema không cho phép `1`,
      lệnh gọi bị từ chối.
    - **Bậc giá** dùng một bảng cố định, rẻ nhất trước: `thinking_level`
      (`minimal`, `low`, `medium`, `default`, `high`), `motion` (`low`,
      `medium`, `high`), `bitrate_mode` (`standard`, `high`) và `mode`
      (`wan-std` < `wan-pro`, `std` < `pro`, hoặc `standard` <
      `professional`). Giá trị rẻ nhất có trong bảng của enum được gửi khi mọi
      giá trị enum đều có trong bảng hoặc mặc định có trong bảng. Nếu không,
      mặc định có trong bảng mà cao hơn bậc rẻ nhất sẽ bị từ chối, còn mặc
      định không xác định được giữ nguyên. Việc cố định `thinking_level`,
      `motion` và các bậc khác ở mức rẻ nhất có thể làm giảm chất lượng đầu
      ra. Operator cần bậc cao hơn nên gọi model trực tiếp bằng multix CLI
      (`multix atlas run <model> --input '{...}'`).
    - Bất kỳ trường nào ở trên có schema không đọc được sẽ bị từ chối.

  Giới hạn: Worker không giới hạn các input khác có thể làm đổi giá, như
  `enable_prompt_expansion` hoặc trường `quality` không phải độ phân giải.
  Model video-extend
  còn tính phí theo độ dài video đầu vào; Worker không đo được video từ xa,
  và tool MCP không có input video, nên model bắt buộc input này bị từ chối
  vì thiếu trường. Trường độ dài phần nối thêm khai báo rõ (`duration`) được
  giới hạn như mọi trường khác. Khi schema không khai báo trường kích thước
  và không có mặc định, model tự chọn kích thước đầu ra. Hãy dùng
  `MULTIX_MCP_ALLOWED_MODELS` để chỉ cho phép model đã kiểm duyệt.
- **Log và che thông tin nhạy cảm:** lệnh gọi thành công được log ở mức `info`,
  chỉ gồm tên tool, provider, model, kết quả và độ trễ. Prompt không bao giờ
  được log thành một trường riêng. Lệnh gọi thất bại được log ở mức `warn` (lỗi
  dự kiến) hoặc `error`, kèm thêm trường `detail`. Trường này chứa thông báo lỗi
  từ provider hoặc từ bước kiểm tra input, đã loại bỏ secret đã cấu hình,
  bearer token và query string của URL, và bị cắt ngắn. Vì vậy lỗi provider có
  lặp lại một phần prompt (ví dụ thông báo kiểm duyệt nội dung) có thể xuất
  hiện ở đó. Client nhận cùng nội dung đã làm sạch này.
- **Trình chạy CLI:** mỗi job `multix_run` có container riêng (một Durable
  Object cho mỗi job), chạy bằng user không phải root. Worker dựng danh sách
  tham số từ catalog lệnh của CLI và từ chối lệnh, option không có trong
  catalog, giá trị `@file`, đường dẫn file và ký tự NUL; giá trị được truyền
  dạng `--name=value`, positional nằm sau `--`, và CLI được chạy không qua
  shell. Tiến trình CLI chỉ nhận key của nhóm provider ứng với lệnh, một thư
  mục home tạm mới và `MULTIX_DISABLE_HOME_ENV=1`. URL input đi qua cùng lớp
  chặn SSRF ở Worker và một lần nữa trong container ở mỗi lần redirect;
  container còn phân giải từng host và từ chối kết nối khi có bất kỳ địa chỉ
  nào là private, loopback, link-local, CGNAT hoặc ULA, và chỉ kết nối tới
  đúng các địa chỉ đã kiểm tra (tối đa 5 lần redirect). File đầu ra được
  stream lên R2 mà không nạp toàn bộ vào bộ nhớ. Thư mục tạm bị xóa khi job
  kết thúc, stdout và stderr được loại bỏ giá trị key rồi mới cắt còn 16 KB,
  và log chỉ ghi job ID và trạng thái. Bản ghi
  `job:<id>` trong `ACCOUNTS_KV` chứa chủ sở hữu, lệnh và thời điểm bắt đầu,
  không bao giờ chứa key.
- **MCP stateless:** không có MCP session. Mỗi request tạo một server mới với
  key của caller. Trạng thái OAuth và tài khoản nằm trong KV.

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
