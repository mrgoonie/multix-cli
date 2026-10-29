---
title: MCP server từ xa trên Cloudflare Workers
description: Triển khai multix MCP server lên Cloudflare Workers để AI agent từ xa chạy lệnh multix CLI trong Cloudflare Container, qua Streamable HTTP, với đăng nhập GitHub, OAuth và dashboard quản lý provider key cùng bucket R2 của từng tài khoản.
---

Repository có kèm một [Model Context Protocol](https://modelcontextprotocol.io)
server tùy chọn, không trạng thái (stateless), trong thư mục `worker/`. Server
cung cấp MCP tool qua **Streamable HTTP** tại `/mcp`, để các agent không chạy
được CLI cục bộ (trợ lý hosted, web IDE, server khác) chạy được hầu hết lệnh
`multix` CLI từ xa: mỗi lần chạy có một
[Cloudflare Container](https://developers.cloudflare.com/containers/) riêng đã
cài CLI, ffmpeg và ImageMagick, và file đầu ra được tải lên bucket R2 của chính
người gọi. Mọi lệnh gọi provider đều đi qua `multix_run`.

Worker là package riêng. Nó không nằm trong CLI phát hành trên npm và không
thay đổi cách `multix` chạy trên máy bạn.

## Các tool được cung cấp

| Tool | Mục đích |
|---|---|
| `multix_catalog` | Các lệnh CLI mà `multix_run` chạy được. Không có `group`: mọi nhóm lệnh, các lệnh trong nhóm và bạn đã lưu key cho nhóm đó chưa (`has_keys`). Có `group`: positional và option của từng lệnh, option nào nhận file, và giá trị server bắt buộc. Có `task` (như `speech`): chỉ các lệnh và model đã xác minh cho task đó; thêm `group` để giới hạn trong một nhóm. Có `model`: input, voice và định dạng đầu ra của một model đã xác minh cùng cách truyền nó cho `multix_run`, hoặc `verified: null` khi chưa biết input của model. |
| `multix_model_catalog` | [Danh mục model và provider](/vi/commands/catalog/), chỉ đọc: `view` là `providers`, `models`, `show` (kèm `offering`) hoặc `compare` (đúng một request: `task`, `resolution`, `duration_s`, `audio`, `aspect_ratio`, `images`). Với `providers`, `models` và `compare`, cùng payload với phần `data` của `multix catalog <view> --json` (`show` chỉ trả về offering, không kèm usage, rating và ghi chú cục bộ của CLI); trạng thái sẵn sàng dựa trên key bạn đã lưu. Usage, rating, review và ghi chú vẫn nằm trên máy và không được phục vụ. |
| `multix_run` | Chạy một lệnh CLI trong container riêng bằng key đã lưu của bạn. Chờ tối đa `wait_seconds` (mặc định 25, tối đa 40, tính cả thời gian khởi động container), sau đó trả về kết quả hoặc job ID để poll. Mặc định mỗi tài khoản chạy tối đa 2 job cùng lúc (`MULTIX_MAX_JOBS_PER_ACCOUNT`). |
| `multix_job_status` | Đọc job `multix_run`: trạng thái, URL output, stdout và phần cuối của stderr. |
| `multix_job_cancel` | Dừng job đang chạy cùng container của nó. |
| `multix_skills` | Đọc (chỉ đọc) [danh mục skill](#skill): `search` để tìm skill, `get` để lấy mục của một skill, `read` để đọc một file văn bản của skill. |
| `multix_skills_manage` | [Tự tạo skill của bạn](#tự-tạo-skill-của-bạn): bản nháp, xuất bản, revision, cài đặt và chia sẻ trong nhóm. Tool này không bao giờ chạy skill. |

`multix_catalog`, `multix_model_catalog` và `multix_skills` luôn được liệt kê. `multix_run`,
`multix_job_status` và `multix_job_cancel` chỉ xuất hiện khi Worker có các binding chạy job
(`MULTIX_JOBS` và `MULTIX_JOB_QUOTA`, xem [Triển khai](#triển-khai)). `multix_skills_manage` chỉ
xuất hiện khi Worker có binding `MULTIX_SKILLS`.

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
- `estimate`: `true` ước tính chi phí như `--estimate` của CLI và trả về
  `{ estimate_only, command, estimate, budget? }` mà không khởi động job.
- `max_cost_usd`: số ≥ 0. Job không khởi động trừ khi chi phí nằm trong giới
  hạn, theo cùng quy tắc với `--max-cost` của CLI; khi bị từ chối, lệnh gọi trả
  về lỗi của tool. Lần chạy mà giới hạn không chặn được cần trường này khi
  server chạy chúng ở chế độ `budget` (xem bên dưới).
- `cost_policy`: `"strict"` (mặc định, chỉ chấp nhận mức trần đã chứng minh)
  hoặc `"estimate"` (chấp nhận mức cao ước tính). Xem
  [Chi phí](/vi/reference/for-ai-agents/#chi-phí-ước-tính-giới-hạn-chi-tiêu-và-biên-nhận)
  để biết lệnh nào có bảng giá.

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

**Webhook thay cho polling.** Script hoặc dịch vụ cũng có thể được báo khi job
kết thúc: đăng ký một endpoint https bằng [API key của tài khoản](#api-key-cho-rest-api)
và server sẽ POST một sự kiện có chữ ký (`multix.job.completed`, `failed`,
`canceled`, `timed_out`, cùng `multix.asset.ready` cho mỗi output đã lưu). Sự
kiện chỉ mang ID và trạng thái cuối, nên hãy đọc output bằng
`multix_job_status` khi nhận được sự kiện; polling vẫn là phương án dự phòng.
Xem [Webhook sự kiện job](/vi/guides/rest-api/#webhook-sự-kiện-job).

**Số job đồng thời.** Mỗi tài khoản chạy tối đa **2** job cùng lúc
(`MULTIX_MAX_JOBS_PER_ACCOUNT`). Lệnh `multix_run` tiếp theo báo lỗi
`busy: you already have 2 running jobs; wait for one to finish or cancel it`
cho đến khi một job kết thúc; nếu cần, hủy bớt bằng `multix_job_cancel`. Suất
chạy của job được trả lại khi job kết thúc, và tự giải phóng sau khoảng 45 phút
nếu job bị mất. Khi server đã chạy đủ `MULTIX_MAX_JOBS_TOTAL` job (mặc định 10)
trên mọi tài khoản, lệnh gọi báo lỗi `server at capacity`; hãy thử lại sau vài
phút.

**Mã lỗi.** Lệnh gọi tool lỗi giữ thông báo dạng text và thêm
`structuredContent.error` gồm `code`, `retryable` và `hint`, cùng bộ mã với
envelope `--json` của CLI (xem [Dành cho AI agent](/vi/reference/for-ai-agents/#exit-code-và-mã-lỗi)).
`busy` và `server at capacity` được trả về là `RATE_LIMITED` với
`retryable: true`. Job đã chạy nhưng lỗi báo `exit_code` khác 0, và
`stderr_tail` kết thúc bằng các dòng `code:`, `hint:` và `next:` của CLI, cho
biết nhóm lỗi.

**File đầu ra cần R2.** Các file CLI ghi ra được tải lên bucket R2 của bạn dưới
`<thư mục>/<hash tài khoản>/<job id>/<tên>` (thư mục là `multix` trừ khi bạn
chọn thư mục khác), và `outputs` liệt kê URL công khai
hoặc presigned của chúng. Mỗi job báo cáo tối đa 50 file, và file lớn hơn
500 MB được liệt kê với `url: null` thay vì được tải lên. Nếu bạn chưa lưu bucket R2, job vẫn chạy nhưng mỗi
output có `url: null` và kết quả kèm `note` nhắc bạn cấu hình R2 tại
`/dashboard`. stdout (gồm cả URL provider mà CLI in ra) vẫn được trả về trong
cả hai trường hợp. Key không bao giờ xuất hiện trong `stdout` hay
`stderr_tail`: giá trị các key đã lưu của bạn được thay bằng `[redacted]`.

Giới hạn của server cũng áp dụng cho `multix_run`: số output
(`MULTIX_MCP_MAX_OUTPUTS`), độ dài video (`MULTIX_MCP_MAX_VIDEO_SECONDS`, cũng
được gửi khi mặc định của lệnh video không rõ hoặc dài hơn; `leonardo video`
không có `--duration` và tạo video tới 8 giây, nên bị từ chối khi giới hạn
dưới 8) và độ phân giải (`MULTIX_MCP_ALLOWED_RESOLUTIONS`). Server tự chọn thư mục đầu ra, `--output`
phải là tên file thuần, option mà CLI ghép vào tên file (như
`elevenlabs voices design --output-prefix` hoặc mã ngôn ngữ khi lồng tiếng) chỉ
nhận chữ cái, chữ số, `_` và `-`, các lệnh ảnh OpenAI luôn dùng API driver,
các lệnh video Gemini luôn dùng Gemini Omni Flash (khi người gọi bỏ trống độ
phân giải, server gửi một giá trị được phép, ưu tiên 720p), và giá trị `@file`
bị từ chối. Lệnh thay đổi chính tài khoản provider của bạn (ví
dụ xóa một giọng ElevenLabs) chạy như mọi lệnh khác, bằng key của bạn.

**Lần chạy giới hạn không chặn được.** Một số lần chạy tốn nhiều hơn những gì
các giới hạn trên nhìn thấy. `multix_catalog` đánh dấu chúng bằng
`uncapped_spend` (trên lệnh, hoặc trên option khiến lần chạy không bị giới
hạn):

- body request chuyển thẳng tới provider: `fal run`, `replicate run`,
  `atlas run`, `heygen run`, `topview run`, `--input` của `replicate image`
  và `replicate video`, `--input` / `--text-field` của `fal tts`, và
  `--param` của `sume image`;
- lần chạy tính tiền theo độ dài nguồn hoặc kịch bản: `heygen video`,
  `heygen translate`, `heygen lipsync`, `elevenlabs dub`, `topview
  video-avatar`, `topview product-avatar`, và `heygen video-agent` /
  `heygen template`, nơi agent hoặc template quyết định độ dài;
- `sume video`, nơi dòng catalog của model quyết định giá, còn model lip-sync
  và phụ đề tính tiền theo độ dài media nguồn;
- `atlas image`, `atlas image-to-image`, `sume image` và `replicate image` khi không có
  `--num-images` / `--num-outputs`, lúc đó model tự chọn số output. Truyền số
  lượng (tối đa `MULTIX_MCP_MAX_OUTPUTS`) giúp lần chạy được giới hạn trở lại.

Operator quyết định điều kiện cho các lần chạy này bằng
`MULTIX_MCP_UNCAPPED_SPEND`. Ở chế độ `budget` (mặc định), lệnh gọi phải có
`max_cost_usd` và job chỉ khởi động khi ước tính giá chứng minh lần chạy nằm
trong mức đó (`cost_policy` được coi là `strict` với các lần chạy này, vì ước
tính không nhìn thấy phần không bị giới hạn). Hiện chưa lệnh nào trong số này có bảng giá, nên trên thực tế
`budget` từ chối chúng (đóng thay vì mở). `deny` luôn từ chối; `allow` chạy như
trước, bằng key của chính người gọi. Lệnh gọi `estimate: true` luôn được trả
lời ở mọi chế độ vì nó không khởi động gì. REST API (`POST /api/v1/jobs`) nhận
cùng các trường `max_cost_usd` và `cost_policy` và áp dụng cùng quy tắc.

**Gemini edit và extend.** `gemini extend-video --duration` là độ dài của đoạn
nối tiếp mới và bị giới hạn như mọi thời lượng khác, nhưng video trả về còn chứa
cả clip nguồn. Vì vậy giới hạn áp dụng cho từng lần gọi, không phải cho cả clip:
mỗi lần extend tiếp một interaction đã lưu (`--interaction-id`), clip lại dài
thêm, và `gemini edit-video` giữ nguyên độ dài của nguồn. Server không biết độ
dài của interaction đã lưu nên không giới hạn một chuỗi extend ngoài giới hạn
40 giây tổng cộng của Google; mọi lần gọi đều được tính phí trên key Gemini của
chính bạn.

**Runway.** `runway video` và `runway image` chạy được từ xa; truyền `--image`
và từng `--reference` dưới dạng URL `https://` trong `inputs`, còn `--duration`
bị giới hạn bởi `MULTIX_MCP_MAX_VIDEO_SECONDS`. Prompt không được bắt đầu bằng
`@`, nên hãy đặt chữ trước `@tag` (`"a portrait of @hero"`). `runway video`
mặc định không chờ, nên job kết thúc chỉ với task ID: đặt `"wait": true` trong
`options` để nhận video, hoặc chạy `runway status <id> --wait --download` sau.

**Sume và TopView.** Cả hai nhóm lệnh chạy được từ xa. Truyền các flag file
(của Sume là `--image`, `--end-image`, `--reference-image`, `--video` và
`--audio`; của TopView là các flag file của Legacy API và file của
`topview upload`) dưới dạng URL `https://` trong `inputs`. `sume estimate`
không upload gì, nên nhận media dưới dạng URL `https://` thông thường.
`sume image --num-images` và `topview product-anyshoot --count` bị giới hạn
bởi `MULTIX_MCP_MAX_OUTPUTS`, còn
`sume video --duration` và `--resolution` bị giới hạn bởi các giới hạn video;
hãy truyền một `--duration` có trong dòng catalog của model, vì nếu thiếu,
server sẽ gửi độ dài mặc định của riêng nó. `topview run --input` phải là JSON
viết trực tiếp, vì giá trị `@file` bị từ chối. `sume image`, `sume video`,
`topview run` và các lệnh Legacy của TopView trừ `product-avatar` mặc định
không chờ: đặt `"wait": true` trong `options`, hoặc tiếp tục sau bằng
`sume status <id> --wait --download`,
`topview status <kind> <taskId> --wait --download` hoặc
`topview prediction <id> --wait --download`. Xem
[Sume](/vi/commands/sume/) và [TopView](/vi/commands/topview/).

**Speech.** `speech generate` phải nêu `--provider`. Job chỉ nhận key của các
provider được nêu trong `--provider` và `--fallback`, không phải mọi key speech
bạn đã lưu. Truyền `--text-file` dưới dạng URL `https://` trong `inputs`.
`speech models --ready` bị từ chối khi chạy từ xa vì nó sẽ mô tả container;
thay vào đó `multix_catalog` báo `has_keys` theo key bạn đã lưu. Xem
[Lệnh speech](/vi/commands/speech/).

### Không hỗ trợ từ xa

- File cục bộ: thay bằng URL `https://` công khai trong `inputs`.
- Tính năng tương tác hoặc chỉ chạy cục bộ: `multix update`, `multix check`,
  Codex image driver, `--stdin-ext`, và đọc giá trị từ `@file`.
- Chọn nơi lưu file: server tự đặt thư mục đầu ra. Hãy tải output từ URL R2.
- Khi không có container chạy job, chỉ `multix_catalog`, `multix_model_catalog`
  và `multix_skills` được liệt kê, nên không lệnh nào chạy được.
- Các lệnh `multix catalog`: chúng đọc usage và review cục bộ của bạn. Hãy dùng
  `multix_model_catalog` để xem offering, giá và so sánh.

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
  làm tên dự phòng, Runway với `RUNWAYML_API_SECRET` mang nhãn "API secret",
  HeyGen, Sume, TopView với `TOPVIEW_API_KEY` và `TOPVIEW_UID`, và TopView
  Platform), cùng account ID, API token và AI Gateway ID (tùy chọn) của
  Cloudflare Workers AI. `TOPVIEW_UID` là account ID chứ không phải secret,
  nên được nhập bằng ô văn bản thường thay vì ô mật khẩu. Một job `topview`
  nhận cả ba giá trị TopView; các lệnh Legacy cần `TOPVIEW_API_KEY` và
  `TOPVIEW_UID`, các lệnh API Platform cần `TOPVIEW_PLATFORM_API_KEY`.

### API key cho REST API

Thẻ **API keys** trong `/dashboard` tạo và thu hồi API key của tài khoản
(`mxk_…`, chỉ hiển thị một lần, tối đa 10 key mỗi tài khoản) cho REST API tại
`/api/v1`, giúp script và CI quản lý provider key, lưu trữ R2 và chạy job mà
không cần MCP. Xem [REST API](/vi/guides/rest-api/) và tài liệu tham chiếu tại
`/api/docs`.

### Lưu trữ R2

Mỗi tài khoản cũng có thể lưu bucket Cloudflare R2 của riêng mình.
`multix_run` tải mọi file đầu ra lên đó; không có bucket thì job vẫn chạy
nhưng không trả về URL file.

1. Trong Cloudflare dashboard, tạo một bucket và một R2 API token có quyền
   **Object Read & Write** trên bucket đó.
2. Trong thẻ **R2 storage** tại `/dashboard`, nhập account ID (32 ký tự hex),
   access key ID và secret access key của token, tên bucket và, nếu muốn, một
   URL gốc công khai `https://` (custom domain hoặc địa chỉ `r2.dev` phục vụ
   bucket). Không có URL công khai thì file nhận liên kết presigned có hiệu lực
   tối đa 7 ngày. **Directory path** (mặc định `multix`) là thư mục trong
   bucket chứa file đầu ra, ví dụ `agents/outputs`. Chỉ dùng chữ, số, `.`, `_`,
   `-` và `/` (tối đa 256 ký tự, không có đoạn `.` hay `..`); dấu `/` ở đầu và
   cuối được bỏ đi.
3. **Check and save** liệt kê bucket (`ListObjectsV2`, một key), tải lên một
   object rỗng `.multix-probe-*` vào thư mục đó rồi xóa nó. Nếu một bước thất bại thì không có
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
   `durable_objects` và `exports`; khi đó chỉ `multix_catalog`,
   `multix_model_catalog` và `multix_skills` được liệt kê (chỉ có skill dựng sẵn).
   Binding `MULTIX_JOB_QUOTA` (class `AccountJobQuota`) giữ số job đang chạy
   theo từng tài khoản và trên toàn server, và phải đi cùng `MULTIX_JOBS`.
   Binding `MULTIX_EVENTS` (class `AccountEvents`) giữ
   [subscription webhook](/vi/guides/rest-api/#webhook-sự-kiện-job) và các lần
   gửi của từng tài khoản, tạo qua REST API lẫn
   [MCP Events](#mcp-events-giao-thức-2026-07-28); thiếu binding này, các route
   `/api/v1/events` trả về `503` và `server/discover` không cung cấp events.
   Binding `MULTIX_SKILLS` (class `AccountSkills`) giữ các
   [skill](#skill) riêng tư và skill nhóm của từng tài khoản; thiếu binding
   này, server chỉ cung cấp skill dựng sẵn, `multix_skills_manage` không được
   liệt kê và các route `/api/v1/skills` trả về `503`.
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
không đọc được nữa. Các key đó sẽ được coi là chưa lưu (`has_keys: false`
trong `multix_catalog`) cho đến khi mỗi
tài khoản lưu lại key. Thay `SESSION_SECRET`
sẽ đăng xuất mọi người khỏi dashboard.

Kiểm tra server (endpoint này công khai và chỉ trả về `{ "ok": true }`):

```bash
curl https://mcp.example.com/health
```

### Dùng chung host với site khác

Worker chỉ cần các path: `/mcp`, `/dashboard`, `/oauth/*`,
`/.well-known/oauth-*`, `/health` và `/api/*`. Route theo path được ưu tiên hơn Custom
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
quyền truy cập của chúng. `multix_catalog` báo `has_keys: false` cho group
mà bạn chưa lưu key; hãy lưu key trong dashboard trước khi chạy lệnh của group
đó.

Luồng thường gặp, ví dụ tạo video: `multix_catalog` → `multix_catalog` kèm
group (như `replicate`) → `multix_run` → gọi lại `multix_job_status` mỗi
10–30 giây đến khi `status` là `succeeded`, `failed`, `timed_out` hoặc
`canceled` → đọc `outputs`.

## MCP Events (giao thức 2026-07-28)

Server hỗ trợ hai phiên bản giao thức MCP trên cùng endpoint `/mcp`:

- **Client đời 2025** (handshake `initialize`, mọi phiên bản giao thức 2025)
  vẫn nhận các tool y như trước. Không có gì thay đổi với các client này.
- **Client 2026-07-28** thương lượng qua `server/discover` và gửi phiên bản
  giao thức trong mỗi request. `server/discover` liệt kê `2026-07-28` và, khi
  Worker có binding `MULTIX_EVENTS`, capability `events`, để
  client đăng ký
  [MCP Events](https://developers.openai.com/plugins/build/mcp-events) bằng
  `events/list`, `events/subscribe` và `events/unsubscribe`.

| Sự kiện | Khi nào |
|---|---|
| `multix.job.completed` | Một job `multix_run` bạn khởi chạy đã thành công. |
| `multix.job.failed` | Job thất bại. |
| `multix.job.canceled` | Job bị hủy. |
| `multix.job.timed_out` | Job hết thời gian. |
| `multix.asset.ready` | Một file output của job đã được lưu vào bucket R2 của bạn. |

Mọi sự kiện nhận một tham số tùy chọn, `job_id`, để chỉ theo dõi một job bạn
sở hữu; bỏ trống thì subscription áp dụng cho mọi job của bạn. `events/list`
trả về `payloadSchema` của từng sự kiện: cùng phần `data` với
[webhook REST](/vi/guides/rest-api/#webhook-sự-kiện-job) (id, trạng thái cuối,
lệnh, provider, thời điểm, exit code, tên và kích thước file output), không bao
giờ chứa key, prompt, log hay URL đã ký.

Mỗi lần gửi là một `POST` với body MCP Events
`{ "eventId", "name", "timestamp", "data", "cursor": null }`, các header
`webhook-id` (bằng `eventId`), `webhook-timestamp`, `webhook-signature` và
`X-MCP-Subscription-Id`. Lần gửi thất bại được thử lại với backoff rồi chuyển
vào dead letter, giống subscription REST; hãy khử trùng lặp theo `eventId`.

Subscription chỉ dùng kiểu gửi **webhook**:

- Callback phải là `https://` ở cổng mặc định với host name công khai, và mọi
  địa chỉ mà tên đó phân giải ra phải là địa chỉ công khai. IP literal,
  credential trong URL, tên kiểu `localhost` và địa chỉ private, loopback,
  link-local, CGNAT, ULA bị từ chối với `-32602`, trước khi gửi bất cứ thứ gì.
- Client cung cấp secret `whsec_` (base64 của 24–64 byte). Trước khi chấp nhận
  subscription, server POST một thông điệp đã ký
  `{ "type": "verification", "challenge": … }` (header
  [Standard Webhooks](https://www.standardwebhooks.com)) và chờ phản hồi 2xx
  trả lại đúng challenge trong 10 giây. Redirect không được đi theo. Nếu thất
  bại, server trả `-32015` kèm `data.reason` (`challenge_failed`, `timeout`,
  `connection_refused`, `http_4xx` hoặc `http_5xx`; host callback
  không phân giải được cũng báo `connection_refused`) và không lưu gì. Gia hạn
  một subscription còn hiệu lực với cùng callback và secret thì không xác minh
  lại.
- Đăng ký lại với cùng sự kiện, tham số và callback sẽ gia hạn subscription
  hiện có (cùng `id`). Khi đổi secret, server vẫn ký thêm bằng secret cũ trong
  một giờ. Thời hạn mặc định 24 giờ, được giới hạn trong khoảng 5 phút đến 7
  ngày; `ttlMs: null` nhận 7 ngày, không bao giờ vô hạn. Hãy gia hạn trước
  `refreshBefore`.
- Subscription MCP và REST dùng chung một kho cho mỗi tài khoản (Durable Object
  `AccountEvents`) và chung giới hạn 10 subscription đang hoạt động, nên không
  tài khoản nào đọc, gia hạn hay xóa được subscription của tài khoản khác.
  Chúng cũng hiện trong `GET /api/v1/events/subscriptions`, có
  `"source": "mcp"` và `job_id` khi chỉ theo dõi một job. Ngắt kết nối một
  client trong dashboard sẽ xóa các subscription client đó đã tạo hoặc gia hạn
  gần nhất, và trong 10 phút sau đó từ chối `events/subscribe` của client này
  bằng `-32600`, để một yêu cầu đang xử lý dở không tạo lại được subscription.
  Khi gia hạn mà subscription đã bị vô hiệu hóa hoặc hết hạn, server xác minh
  lại callback. Sự kiện cũ không được phát lại: `cursor` từ subscription trước
  sẽ nhận `truncated: true`.

`subscriptions/listen` không được hỗ trợ (danh sách tool cố định theo mỗi lần
triển khai).

## Skill

Server cung cấp một danh mục agent skill: các file hướng dẫn `SKILL.md` chỉ cho
agent cách dùng multix. Đọc một skill không bao giờ chạy hay kích hoạt nó, và
server không bao giờ thực thi file của skill.

Skill dựng sẵn chính là thư mục `skill/` của repository, được đóng gói vào
Worker lúc build (`npm run skills` trong `worker/`, tự chạy trước `dev`,
`build`, `typecheck`, `test` và `deploy`):

- `skill://multix/SKILL.md`: skill đầu vào, cùng nội dung mà package npm cài
  trên máy.
- `skill://multix/<name>/SKILL.md` cho các task skill `image-generation`,
  `video-production`, `speech-production`, `media-qa`,
  `document-conversion` và `3d-generation`. Mỗi skill hướng dẫn agent chọn
  model theo thời gian thực bằng `multix models --task <task> --ready` hoặc
  `multix models --model <id>`.

Hai không gian URI nữa được dành cho skill của tài khoản, lưu theo từng tài
khoản trong Durable Object `AccountSkills` dưới dạng các revision bất biến với
file định địa chỉ theo nội dung (SHA-256): `skill://private/<name>/<file>` cho
skill của riêng bạn và `skill://team/<ownerId>/<name>/<file>` cho skill nhóm
bạn sở hữu hoặc được cấp quyền. Bạn tự xuất bản và chia sẻ chúng (xem
[Tự tạo skill của bạn](#tự-tạo-skill-của-bạn)). Skill của tài khoản khác không
bao giờ hiện ra, trừ khi tài khoản đó cấp cho bạn một skill nhóm và bạn đã thêm
nó: skill không tồn tại và skill bị cấm nhận cùng một câu trả lời.

### Client giao thức 2026-07-28

`server/discover` khai báo `resources` và extension
`io.modelcontextprotocol/skills` với `directoryRead: true`. Khi đó client gọi
được:

| Method | Trả về |
|---|---|
| `skills/list` | Các mục skill, 50 mục mỗi trang; gửi lại `nextCursor` (opaque) làm `cursor`. |
| `skills/get` `{ uri }` | Một mục skill, theo URI của file `SKILL.md`. |
| `resources/read` `{ uri }` | Một file của skill. |
| `resources/directory/read` `{ uri, cursor? }` | Các phần tử con trực tiếp của một thư mục skill; thư mục có mimeType `inode/directory`. |

Mỗi mục skill có `uri` (file `SKILL.md` của nó), `frontmatter` (nguyên văn
YAML, dưới dạng JSON), `resources` (`uri`, `digest` dạng `sha256:<hex>`,
`size`), và `_meta["me.zuey.multix/skill"]` gồm `id`, `version`, `revision`,
`manifestDigest`, `status`, `visibility`, `tags` và `capabilities`. Gợi ý cache
là 5 phút, `public`, khi chỉ có skill dựng sẵn, và 1 phút, `private`, khi có
cả skill của tài khoản.

Lỗi là JSON-RPC `-32602` với thông điệp cố định (như
`No skill is served at <uri>` hoặc `Invalid cursor`) và mã ổn định trong
`data.code`: `INVALID_URI`, `UNKNOWN_SKILL`, `NOT_FOUND`, `NOT_DIRECTORY` hoặc
`INVALID_CURSOR`.

### Client đời 2025

Các method của extension trả về `-32601`, nhưng `resources/list` liệt kê mọi
`SKILL.md` và `resources/read` đọc được mọi file. Tool `multix_skills`, có ở
cả hai phiên bản giao thức, đảm nhận phần còn lại:

- `{"action": "search", "query": "trim", "task": "video"}`: tìm skill theo
  từ khóa, theo task (một giá trị của `multix models --task`), hoặc cả hai.
- `{"action": "get", "uri": "skill://multix/media-qa/SKILL.md"}`: cùng mục
  như `skills/get`.
- `{"action": "read", "uri": "…", "revision": 3}`: một file văn bản. Truyền
  `revision` hoặc `digest` từ lần `get` trước để nhận `STALE_REVISION: …` nếu
  file đã thay đổi từ đó. File nhị phân trả về `BINARY_FILE: …`, file văn bản
  lớn hơn 256 KiB trả về `PAYLOAD_TOO_LARGE: …`; hãy đọc chúng bằng
  `resources/read`.

Lỗi của tool bắt đầu bằng cùng các mã ổn định, cộng thêm `STALE_REVISION`,
`BINARY_FILE` và `PAYLOAD_TOO_LARGE`.

### Skill nào mô tả CLI nào

Skill cài kèm package npm khớp với CLI bạn đã cài. Danh mục từ xa cung cấp
`skill/` của Worker đang được triển khai, và `version` của nó (trong
frontmatter và trong `_meta`) là phiên bản CLI của Worker đó. Khi hai bên khác
nhau, agent dùng server này nên theo danh mục từ xa, còn agent chạy CLI trên
máy nên theo skill cục bộ.

### Tự tạo skill của bạn

`multix_skills_manage` và các route REST dưới
[`/api/v1/skills`](/vi/guides/rest-api/#skill) tạo, xuất bản và chia sẻ skill
của riêng bạn. Cả hai dùng chung một đoạn code, nên cách kiểm tra, xung đột và
giới hạn đều giống nhau. Mọi thao tác ghi đều vào registry của chính bạn: không
tài khoản nào sửa được skill của tài khoản khác. Không thao tác nào ở đây chạy
skill; việc đọc vẫn dùng các method ở trên.

Quy trình, theo `action` của MCP (route REST trong ngoặc):

1. `save_draft` (`PUT /skills/{skill}/draft`): thêm hoặc thay `files` (một
   `path` kèm `text`, hoặc `base64` cho mọi loại file) và xóa các path trong
   `delete`. Bản nháp mới bắt đầu từ revision đang phục vụ, từ
   `from_revision`, hoặc từ chỗ không có file nào với `replace`. Bản nháp không
   bao giờ được phục vụ.
2. `get_draft` và `read_file` (`GET …/draft`, `GET …/files?path=`) hiển thị
   bản nháp; `read_file` kèm `revision` thì đọc một revision đã lưu.
3. `publish` (`POST …/publish`): bản nháp trở thành revision bất biến tiếp
   theo, được phục vụ tại `skill://private/<name>/SKILL.md`, hoặc tại
   `skill://team/<id tài khoản của bạn>/<name>/SKILL.md` khi `visibility` là
   `team`. `name` trong frontmatter của `SKILL.md` phải trùng tên skill. Có thể
   đặt `visibility`, `tags` và `capabilities` (task id hoặc `any`) cùng lúc;
   skill mới mặc định là `private`.

Số revision tăng dần theo từng skill và không bao giờ được dùng lại, kể cả sau
khi revision đó bị xóa. `revisions` và `revision` liệt kê và xem chi tiết
chúng; `set_current` (`POST …/current`) phục vụ một revision đã lưu khác (quay
lui hoặc tiến lên); `unpublish` ngừng phục vụ skill nhưng giữ các revision;
`delete_revision` xóa bất kỳ revision nào trừ revision đang phục vụ; `delete`
xóa skill cùng mọi revision, bản nháp và các quyền đã cấp. `update`
(`PATCH /skills/{skill}`) đổi `visibility`, `tags` và `capabilities`; đổi
visibility sẽ chuyển skill sang URI còn lại và thu hồi mọi quyền đã cấp.

Để không ghi đè thay đổi đồng thời, hãy gửi giá trị bạn đọc lần gần nhất
(`get` trả về `draft.digest` và `skill.current_revision`); nếu không khớp, thao
tác thất bại với `CONFLICT` (REST `409`):

- `expected_digest`: digest của bản nháp, trên `save_draft`, `discard_draft`
  và `publish`. Qua REST, `null` khi cập nhật bản nháp nghĩa là bạn cho rằng
  chưa có bản nháp.
- `expected_revision`: revision đang phục vụ, trên `publish`, `set_current`,
  `unpublish` và `update`. "Không có revision nào được phục vụ" là `0` qua MCP
  và `null` qua REST.

Chia sẻ trong nhóm là tùy chọn của người nhận. Chủ của một skill nhóm gọi
`grant` với một id tài khoản (`gh-<digits>`, chính là `id` của
`GET /api/v1/me`); `grants` liệt kê các quyền đã cấp và `revoke` thu hồi một
quyền. Việc cấp quyền không thêm gì vào danh mục của người nhận: người nhận gọi
`add_shared` với `uri` của skill (`skill://team/<owner>/<name>/SKILL.md`) để
liệt kê nó trong `skills/list` và `multix_skills`, và `remove_shared` để bỏ
nó. Trong `list`, skill được chia sẻ có `available: false` khi chủ skill đã thu
hồi quyền, ngừng phục vụ hoặc xóa skill. Một lần thu hồi chấm dứt việc liệt kê
đó, kể cả khi chủ skill cấp quyền lại; khi đó người nhận phải thêm lại.

Lỗi của tool bắt đầu bằng `INVALID_INPUT`, `NOT_FOUND` hoặc `CONFLICT` (REST
`400`, `404`, `409`). Giới hạn:

- mỗi tài khoản: 200 skill, 200 bản nháp và 200 skill được chia sẻ đã thêm;
- mỗi skill: 100 revision đã lưu (xóa bớt revision cũ để xuất bản thêm), 100
  quyền đã cấp, 512 file và 16 MiB, 1 MiB mỗi file;
- mỗi lần cập nhật bản nháp mang tối đa 8 MiB file sau khi giải mã.

Request MCP bị giới hạn 64 KiB, nên hãy chia file ra nhiều lần gọi
`save_draft`, và tải một file không vừa trong một request lên bằng
`PUT /api/v1/skills/{skill}/draft` (body tối đa khoảng 11 MiB).

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
| `MULTIX_MCP_MAX_OUTPUTS` | `4` (tối đa 10) | Số output tối đa (ví dụ `--num-images`) mỗi lần gọi `multix_run`. |
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (tối đa 15) | Thời lượng video tối đa cho mỗi lần gọi (với `gemini extend-video` là đoạn nối tiếp mới). Khi caller bỏ qua thời lượng và mặc định của lệnh không rõ hoặc dài hơn, server gửi `min(5, giới hạn)` giây. |
| `MULTIX_MCP_ALLOWED_RESOLUTIONS` | `480p,720p,768p,1080p` | Độ phân giải video caller được yêu cầu (`768p` là kích thước của HeyGen Video). Giá trị khác (ví dụ `4k`), do caller truyền hay là mặc định của lệnh, bị từ chối trước khi job bắt đầu. |
| `MULTIX_MCP_UNCAPPED_SPEND` | `budget` | Lần chạy mà các giới hạn trên không chặn được (đánh dấu `uncapped_spend` trong `multix_catalog`): `budget` chỉ chạy khi có `max_cost_usd` mà ước tính giá chứng minh được (giá không rõ thì bị từ chối), `deny` từ chối, `allow` cho chạy. Giá trị khác được hiểu là `budget`. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | không có | Origin trình duyệt chính xác (ví dụ `https://app.example.com`) được phép gọi `/mcp`. Không hỗ trợ `*` hay wildcard khác: `*` chỉ khớp origin `*` theo nghĩa đen, thứ trình duyệt không bao giờ gửi. Sau khi access token được kiểm tra, request có header `Origin` khác nhận `403`; request không có `Origin` (client phía server) được chấp nhận. Origin trong danh sách nhận header CORS. Preflight `OPTIONS` được lớp OAuth trả lời cho mọi origin. |
| `MULTIX_MAX_JOBS_PER_ACCOUNT` | `2` (tối đa 50) | Số job `multix_run` một tài khoản được chạy cùng lúc. |
| `MULTIX_MAX_JOBS_TOTAL` | `10` (tối đa 1000) | Số job `multix_run` server được chạy cùng lúc trên mọi tài khoản. Giữ giá trị này không vượt `max_instances` của container trong `wrangler.jsonc`, là trần của nền tảng. |

Hai binding [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
trong `wrangler.jsonc` chặn lạm dụng; request vượt mức nhận `429`:

- `MCP_RATE_LIMITER`: khoảng 60 request mỗi phút cho mỗi tài khoản, dùng chung
  cho `/mcp` và REST API.
- `AUTH_RATE_LIMITER`: khoảng 30 request mỗi phút cho mỗi IP client ở các
  bước đăng nhập, yêu cầu ủy quyền, đăng ký client, cấp token, thao tác ghi
  trên dashboard và request REST API thiếu API key hoặc key không hợp lệ.

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
- **Kiểm tra input:** mọi tham số tool được kiểm tra bằng schema zod (độ dài
  chuỗi, kích thước danh sách và số đều có giới hạn), và option của
  `multix_run` được đối chiếu với catalog lệnh của CLI. Body lớn hơn 64 KiB
  bị từ chối với `413`. JSON-RPC batch (body dạng mảng) bị từ chối với `400` /
  `-32600`, nên mỗi request HTTP luôn là một lần gọi tool và rate limit cũng
  giới hạn số lần gọi.
- **Chống SSRF:** mọi URL trong `inputs` của `multix_run` phải là `https://`
  trên cổng mặc định, với tên miền DNS công khai. Địa chỉ IP, credential trong
  URL, `localhost`, tên kiểu `.local`/`.internal` và host metadata của cloud bị
  từ chối trước khi job bắt đầu.
- **Giới hạn chi phí:** `multix_run` giới hạn số output, thời lượng video và
  độ phân giải video trên các option mà server biết cho từng lệnh (xem
  [Chạy lệnh CLI](#chạy-lệnh-cli)). Lần chạy mà các giới hạn đó không chặn
  được (body JSON chuyển thẳng, giá theo độ dài nguồn, số output do model chọn)
  bị từ chối trừ khi `max_cost_usd` chứng minh được giá, hoặc theo
  `MULTIX_MCP_UNCAPPED_SPEND`. Người gọi cũng có thể đặt `max_cost_usd` để từ
  chối mọi lần chạy có thể tốn hơn mức đó.
- **Log và che thông tin nhạy cảm:** lệnh gọi thành công được log ở mức `info`,
  chỉ gồm tên tool, lệnh (hoặc group của catalog), kết quả và độ trễ. Prompt không bao giờ
  được log thành một trường riêng. Lệnh gọi thất bại được log ở mức `warn` (lỗi
  dự kiến) hoặc `error`, kèm thêm trường `detail`. Trường này chứa thông báo lỗi
  từ bước kiểm tra input hoặc từ job, đã loại bỏ secret đã cấu hình,
  bearer token và query string của URL, và bị cắt ngắn. Vì vậy lỗi provider có
  lặp lại một phần prompt (ví dụ thông báo kiểm duyệt nội dung) có thể xuất
  hiện ở đó. Client nhận cùng nội dung đã làm sạch này.
- **Trình chạy CLI:** mỗi job `multix_run` có container riêng (một Durable
  Object cho mỗi job), chạy bằng user không phải root. Worker dựng danh sách
  tham số từ catalog lệnh của CLI và từ chối lệnh, option không có trong
  catalog, giá trị `@file`, đường dẫn file và ký tự NUL; giá trị được truyền
  dạng `--name=value`, positional nằm sau `--`, và CLI được chạy không qua
  shell. Tiến trình CLI chỉ nhận key của nhóm provider ứng với lệnh (với
  `speech generate` là các provider mà nó route tới), một thư
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
- **Callback sự kiện:** khi đăng ký (MCP Events và REST API), server từ chối
  callback không công khai theo tên và theo mọi địa chỉ phân giải được (DNS
  over HTTPS), và kiểm tra địa chỉ lại ngay trước mỗi lần gửi, nên host bị trỏ
  sang địa chỉ private về sau (DNS rebinding) không nhận được gì: lần gửi được
  thử lại rồi cuối cùng chuyển vào dead letter. Request tới callback không bao
  giờ đi theo redirect, và chỉ loại lỗi xác minh được trả về hoặc ghi log.
  Worker không thể ghim kết nối vào đúng địa chỉ đã kiểm tra, nên tên đổi địa
  chỉ đúng giữa lúc kiểm tra và lúc kết nối thì không bị phát hiện.
- **MCP stateless:** không có MCP session. Mỗi request tạo một server mới với
  key của caller. Trạng thái OAuth và tài khoản nằm trong KV; subscription sự
  kiện nằm trong một Durable Object riêng cho từng tài khoản.

Trong CI, bundle Worker được kiểm tra để bảo đảm không chứa module `node:*`,
không import module có sẵn của Node theo tên trần (`fs`, `child_process`,
`path`, …), không có `commander` hay `execa`, và không có mã entry của CLI. Mã
nguồn Worker cũng được kiểm tra kiểu mà không có typings của Node.
