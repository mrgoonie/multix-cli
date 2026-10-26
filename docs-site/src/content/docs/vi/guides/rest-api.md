---
title: REST API và API key của tài khoản
description: Dùng REST API của multix MCP server từ script và CI bằng API key của tài khoản để quản lý provider key và lưu trữ R2, đọc catalog CLI, chạy, theo dõi, hủy job CLI, nhận webhook có chữ ký khi job kết thúc, và đọc mức sử dụng, chi phí, ngân sách cùng nhật ký hoạt động.
---

[MCP server từ xa](/vi/guides/mcp-server/) còn cung cấp một REST API dạng JSON
tại `/api/v1` cho script và CI không dùng MCP. API làm việc trên cùng tài khoản
với dashboard và `/mcp`: cùng provider key, cùng bucket R2, và cùng bộ chạy CLI
với `multix_run`, với cùng các bước kiểm tra input, giới hạn job và lọc bỏ key
khỏi output.

- Base URL của bản host sẵn: `https://multix.zuey.me/api/v1` (chỉ tài khoản
  GitHub được mời). Trên bản tự triển khai, base URL là `<origin>/api/v1`.
- Tài liệu tương tác: [`/api/docs`](https://multix.zuey.me/api/docs), được
  dựng từ tài liệu OpenAPI 3.1 công khai tại
  [`/api/v1/openapi.json`](https://multix.zuey.me/api/v1/openapi.json). Tài
  liệu OpenAPI là nguồn chuẩn cho schema của request và response; trang này
  giải thích cách dùng chúng.

## Tạo API key

1. Đăng nhập tại `/dashboard`.
2. Trong thẻ **API keys**, nhập tên (ví dụ `laptop` hoặc `CI`, 1–64 ký tự in
   được) rồi chọn **Create API key**.
3. Sao chép key (`mxk_…`) ngay. Key chỉ hiển thị **một lần**; server chỉ lưu
   mã băm SHA-256 của key, nên key bị mất không thể khôi phục. Hãy thu hồi nó
   và tạo key khác.

Mỗi tài khoản có tối đa **10** key. Thẻ này liệt kê tên, vài ký tự đầu và thời
điểm tạo của từng key; **Revoke** xóa key. Key đã thu hồi có thể vẫn dùng được
thêm khoảng một phút ở các location khác của Cloudflare, vì kho key (KV) chỉ
nhất quán dần.

Một key hành động thay cho tài khoản của bạn: nó đọc được key nào đã được đặt,
thay đổi được provider key và lưu trữ R2, chạy được job tiêu credit provider
của bạn, và thu hồi được API key. Nó không tạo được API key; việc đó chỉ làm
được trong dashboard. Hãy giữ key như mật khẩu, trong kho secret hoặc biến môi
trường, không đặt trong mã nguồn.

## Xác thực

Gửi key dưới dạng bearer token ở mọi request, trừ `openapi.json`:

```bash
export MULTIX_API_KEY="mxk_your-key-here"   # tốt hơn: nạp từ kho secret của bạn
curl -s https://multix.zuey.me/api/v1/me \
  -H "Authorization: Bearer $MULTIX_API_KEY"
```

Mỗi request kiểm tra key, rồi giới hạn tốc độ theo tài khoản, rồi danh sách
được phép đăng nhập (`MULTIX_ALLOWED_USERS`, nên xóa một tài khoản khỏi danh
sách cũng chặn luôn các API key của nó). Body của request là
JSON (`Content-Type: application/json`, tối đa 64 KiB).

## Endpoint

Mọi path đều tương đối với `/api/v1`.

| Method | Path | Mục đích |
|---|---|---|
| `GET` | `/openapi.json` | Tài liệu OpenAPI 3.1. Công khai, không cần key. |
| `GET` | `/me` | Tài khoản đang gọi (`id`, `login`, `name`) và id của API key đang dùng. |
| `GET` | `/provider-keys` | Mọi tên provider key kèm `set` và `updated_at`. Không bao giờ trả về giá trị. |
| `PATCH` | `/provider-keys` | Đặt và xóa nhiều key cùng lúc: `{ "keys": { "NAME": "value" \| null } }`. Toàn bộ body được kiểm tra trước khi ghi bất cứ thứ gì. |
| `PUT` | `/provider-keys/{name}` | Đặt một key: `{ "value": "…" }`. |
| `DELETE` | `/provider-keys/{name}` | Xóa một key. |
| `GET` | `/storage` | Cấu hình R2 không kèm credential, hoặc `{ "configured": false }`. |
| `PUT` | `/storage` | Kiểm tra quyền truy cập bucket, rồi lưu cấu hình R2. |
| `DELETE` | `/storage` | Xóa cấu hình R2. |
| `GET` | `/catalog[?group=]` | Các lệnh CLI server chạy được; cùng payload với `multix_catalog`. |
| `POST` | `/jobs` | Chạy một lệnh CLI; cùng input với `multix_run`. |
| `GET` | `/jobs/{id}` | Trạng thái job, output, stdout và phần cuối stderr. |
| `POST` | `/jobs/{id}/cancel` | Dừng một job đang chạy. |
| `GET` | `/api-keys` | Các API key của tài khoản (`id`, `name`, `prefix`, `created_at`), không bao giờ có chính key. |
| `DELETE` | `/api-keys/{id}` | Thu hồi một API key. Một key có thể tự thu hồi chính nó. |
| `GET` | `/events` | Danh mục sự kiện: tên, mô tả và JSON Schema của `data` cho từng sự kiện. |
| `GET` | `/events/subscriptions` | Các subscription webhook của tài khoản, cả đang hoạt động lẫn không. Không bao giờ liệt kê secret. |
| `POST` | `/events/subscriptions` | Đăng ký một callback URL nhận sự kiện job; trả về secret ký một lần duy nhất. |
| `GET` | `/events/subscriptions/{id}` | Một subscription. |
| `DELETE` | `/events/subscriptions/{id}` | Thu hồi một subscription. |
| `GET` | `/events/dead-letters` | Các lần gửi đã bị bỏ cuộc (ID, lý do, số lần thử; không kèm payload). |
| `GET` | `/events/audit` | Nhật ký audit của subscription: tạo, thu hồi, vô hiệu hóa, hết hạn. |
| `GET` | `/usage/summary` | Tổng mức sử dụng, nhóm tùy chọn, chuỗi theo ngày và trạng thái của mọi ngân sách. |
| `GET` | `/usage/operations` | Các operation đã ghi, mới nhất trước, có phân trang. |
| `GET` | `/usage/operations/{op_id}` | Một operation cùng các điều chỉnh chi phí của nó. |
| `POST` | `/usage/operations/{op_id}/adjustments` | Ghi một khoản hoàn tiền hoặc điều chỉnh cho operation. |
| `GET` | `/usage/export?format=csv\|json` | Các operation đã lọc dưới dạng CSV (mặc định) hoặc JSON. |
| `POST` | `/usage/import` | Nhập lịch sử chạy CLI; đây là thứ `multix history push` gửi lên. |
| `DELETE` | `/usage/data?confirm=delete` | Xóa mọi bản ghi mức sử dụng của tài khoản. Ngân sách được giữ lại. |
| `GET` | `/budgets` | Các ngân sách kèm mức đã chi, dự báo và các ngưỡng đã vượt. |
| `POST` | `/budgets` | Tạo ngân sách. |
| `GET` | `/budgets/{id}` | Trạng thái của một ngân sách. |
| `PUT` | `/budgets/{id}` | Thay thế một ngân sách (cùng body như khi tạo). |
| `DELETE` | `/budgets/{id}` | Xóa một ngân sách. |
| `GET` | `/activities` | Nhật ký hoạt động của tài khoản, mới nhất trước, có phân trang. |
| `GET` | `/activities/verify` | Kiểm tra chuỗi hash của nhật ký hoạt động. |

Tên provider key là tên biến môi trường mà CLI đọc (ví dụ `GEMINI_API_KEY`),
cùng các tên của Cloudflare Workers AI; `GET /provider-keys` liệt kê tất cả.
Giá trị phải gồm 1–1024 ký tự in được, không có khoảng trắng.

## Provider key

Đặt một key, lấy giá trị từ biến môi trường để nó không nằm trong lịch sử
shell. Body được gửi qua stdin (`--data @-`) nên giá trị cũng không hiện trong
danh sách tiến trình:

```bash
curl -s -X PUT https://multix.zuey.me/api/v1/provider-keys/GEMINI_API_KEY \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{"value": "$GEMINI_API_KEY"}
JSON
```

Đặt và xóa nhiều key trong một request (`null` xóa key). Response chỉ liệt kê
tên: `{ "saved": [...], "removed": [...] }`.

```bash
curl -s -X PATCH https://multix.zuey.me/api/v1/provider-keys \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{"keys": {"GEMINI_API_KEY": "$GEMINI_API_KEY", "OPENAI_API_KEY": "$OPENAI_API_KEY", "FAL_KEY": null}}
JSON
```

Một tên không hợp lệ khiến cả request bị từ chối với `400`, nên không có
trường hợp chỉ lưu được một phần.

### Đồng bộ key từ file `.env` cục bộ

Script Node.js này (Node 20+, không cần thư viện) hỏi server những tên nào được
chấp nhận, lấy các tên đó từ một file `.env` cục bộ, rồi gửi tất cả trong một
request `PATCH`. Script chỉ in tên key, không bao giờ in giá trị. Lưu thành
`sync-multix-keys.mjs`:

```js
// Usage: MULTIX_API_KEY=… node sync-multix-keys.mjs [path/to/.env]
import { readFileSync } from "node:fs";

const base = process.env.MULTIX_API_URL ?? "https://multix.zuey.me/api/v1";
const headers = {
  authorization: `Bearer ${process.env.MULTIX_API_KEY}`,
  "content-type": "application/json",
};

// Names the server accepts.
const listed = await fetch(`${base}/provider-keys`, { headers });
if (!listed.ok) throw new Error(`GET /provider-keys: HTTP ${listed.status}`);
const accepted = new Set((await listed.json()).keys.map((k) => k.name));

// KEY=value lines; comments, blank lines and unknown names are skipped.
const keys = {};
for (const line of readFileSync(process.argv[2] ?? ".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!m || !accepted.has(m[1])) continue;
  const raw = m[2].trim();
  // Quoted values are kept as written; unquoted ones lose a trailing " # comment".
  const value = /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/, "");
  if (value) keys[m[1]] = value;
}
if (Object.keys(keys).length === 0) throw new Error("No provider keys found in the .env file");

const res = await fetch(`${base}/provider-keys`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ keys }),
});
const body = await res.json();
if (!res.ok) throw new Error(`PATCH /provider-keys: ${body.error?.code}: ${body.error?.message}`);
console.log(`saved: ${body.saved.join(", ")}`);
```

Chạy bằng `node sync-multix-keys.mjs ~/.multix/.env` hoặc đường dẫn `.env`
khác. Script không bao giờ xóa key: tên không có trong file được giữ nguyên.

## Lưu trữ R2

`PUT /storage` nhận cùng các trường với thẻ **R2 storage** trong dashboard (xem
[Lưu trữ R2](/vi/guides/mcp-server/#lưu-trữ-r2)). Trước khi lưu, server liệt kê
bucket, upload một object thử rỗng rồi xóa nó; nếu bước nào thất bại thì không
có gì được lưu và response là `422 storage_check_failed`, kèm tên bước thất
bại.

```bash
curl -s -X PUT https://multix.zuey.me/api/v1/storage \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  --data @- <<JSON
{"account_id": "$R2_ACCOUNT_ID", "access_key_id": "$R2_ACCESS_KEY_ID", "secret_access_key": "$R2_SECRET_ACCESS_KEY",
 "bucket": "my-multix-outputs", "public_base_url": "https://files.example.com", "prefix": "agents/outputs"}
JSON
```

`public_base_url` là tùy chọn. `prefix` (tùy chọn, mặc định `multix`) là thư
mục trong bucket chứa file đầu ra của job: chữ, số, `.`, `_`, `-` và `/`, tối đa
256 ký tự, không có đoạn `.` hay `..`. `PUT` thay toàn bộ cấu hình, nên bỏ
`prefix` sẽ đặt lại thư mục về `multix`. Response, giống `GET /storage`, trả về
giá trị này và không bao giờ chứa access key.

## Chạy job và theo dõi

`POST /jobs` nhận input của `multix_run` (`command`, `options`, `args`,
`inputs`, `wait_seconds`; xem
[Chạy lệnh CLI](/vi/guides/mcp-server/#chạy-lệnh-cli)). Dùng
`GET /catalog?group=gemini` để xem các option của một lệnh và option nào nhận
file.

```bash
curl -s -X POST https://multix.zuey.me/api/v1/jobs \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "gemini analyze",
    "options": { "prompt": "Summarise this clip in three bullet points" },
    "inputs": { "files": "https://cdn.example.com/clip.mp4" },
    "wait_seconds": 40
  }'
```

Body có cùng dạng với kết quả của `multix_run` (`job_id`, `status`, `outputs`,
`stdout`, `stderr_tail`, `exit_code`, và `note` khi chưa cấu hình R2). Mã HTTP
cho biết có cần theo dõi tiếp hay không:

- `200`: job đã kết thúc (`succeeded`, `failed`, `timed_out` hoặc `canceled`).
- `202`: job vẫn `starting` hoặc `running`; `next.path` là URL cần gọi lại, ví dụ
  `/api/v1/jobs/<job_id>`.

Gọi lại mỗi 10–30 giây cho đến khi mã trạng thái không còn là `202`:

```bash
JOB_ID="<job_id from the response>"
while [ "$(curl -s -o job.json -w '%{http_code}' \
  https://multix.zuey.me/api/v1/jobs/$JOB_ID \
  -H "Authorization: Bearer $MULTIX_API_KEY")" = "202" ]; do
  sleep 15
done
cat job.json   # outputs[].url chứa các file trong bucket R2 của bạn
```

Dừng job đang chạy bằng `POST /jobs/{id}/cancel`. Chỉ tài khoản đã bắt đầu job
mới đọc hoặc hủy được nó; tài khoản khác nhận `404`.

## Webhook sự kiện job

Thay vì polling, hãy đăng ký một endpoint https nhận sự kiện job. Khi job kết
thúc, server POST một sự kiện JSON có chữ ký tới mọi subscription phù hợp của
tài khoản đã khởi chạy job. Polling `GET /jobs/{id}` (hoặc `multix_job_status`
qua MCP) vẫn hoạt động và là phương án dự phòng khi một lần gửi bị trễ hoặc
thất lạc.

### Sự kiện

| Sự kiện | Khi nào |
|---|---|
| `multix.job.completed` | Job kết thúc và CLI thoát thành công. |
| `multix.job.failed` | Job kết thúc với lỗi (CLI lỗi, mất container, không khởi động được). |
| `multix.job.canceled` | Job bị chủ sở hữu hủy. |
| `multix.job.timed_out` | Job không xong trong giới hạn thời gian của server. |
| `multix.asset.ready` | Một file output của job thành công đã được lưu vào bucket R2 của tài khoản (mỗi file đã lưu một sự kiện, tối đa 20 mỗi job). |

`GET /events` trả về cùng danh sách này kèm JSON Schema của `data` cho từng sự
kiện; endpoint đó và `worker/src/events/event-catalog.ts` là nguồn chuẩn cho
các trường của payload.

Mọi sự kiện có cùng một envelope:

```json
{
  "id": "evt_<job_id>_succeeded",
  "name": "multix.job.completed",
  "schema_version": 1,
  "occurred_at": "2026-01-01T12:00:00.000Z",
  "resource": { "type": "job", "id": "<job_id>" },
  "data": {
    "job_id": "<job_id>",
    "status": "succeeded",
    "command": "gemini generate",
    "provider": "gemini",
    "created_at": "2026-01-01T11:59:20.000Z",
    "finished_at": "2026-01-01T12:00:00.000Z",
    "exit_code": 0,
    "outputs": [{ "name": "image-1.png", "bytes": 482113, "stored": true }]
  }
}
```

`multix.asset.ready` mang `job_id`, `command`, `provider`, vị trí `index` của
file trong `outputs`, `name` và `bytes` của file. Payload chỉ chứa ID và trạng
thái cuối: không bao giờ có prompt, output của CLI, nội dung lỗi, key hay URL
(URL output thường là URL presigned). Hãy đọc những thứ đó bằng
`GET /jobs/{id}` hoặc `multix_job_status` khi nhận được sự kiện.

### Đăng ký

`POST /events/subscriptions` nhận:

- `callback_url` (bắt buộc): URL `https://` công khai theo tên host, dùng cổng
  mặc định, không trỏ về chính server multix. Mọi địa chỉ mà tên đó phân giải
  ra (kiểm tra qua DNS over HTTPS) phải là địa chỉ công khai: tên phân giải ra
  địa chỉ private, loopback, link-local, CGNAT hay địa chỉ dành riêng khác,
  hoặc không phân giải được, sẽ nhận `400`. Nếu lúc đó không kiểm tra được tên,
  server trả `503 unavailable` kèm `Retry-After`.
- `events` (tùy chọn): tên các sự kiện muốn nhận; mặc định là tất cả.
- `ttl_seconds` (tùy chọn): thời gian sống của subscription, từ 3600 (1 giờ)
  đến 7776000 (90 ngày); mặc định 2592000 (30 ngày). Không gia hạn được: hãy
  tạo subscription mới trước khi subscription cũ hết hạn.
- `description` (tùy chọn): tối đa 200 ký tự.

```bash
curl -s -X POST https://multix.zuey.me/api/v1/events/subscriptions \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "callback_url": "https://hooks.example.com/multix",
    "events": ["multix.job.completed", "multix.job.failed"],
    "description": "CI notifier"
  }'
```

Response `201` gồm `subscription` (`id`, `status`, `expires_at` và các bộ đếm
lần gửi), `secret` (`whsec_…`) và `signing`, phần tóm tắt cơ chế ký bên dưới.
Secret chỉ hiển thị **một lần**: lưu ngay vào kho secret của bạn. Nếu làm mất,
hãy thu hồi subscription bằng `DELETE /events/subscriptions/{id}` rồi tạo cái
khác. Mỗi tài khoản có tối đa **10** subscription đang hoạt động; tạo thêm sẽ
nhận `409 limit_reached`. Subscription do client MCP tạo qua
[MCP Events](/vi/guides/mcp-server/) tính chung vào giới hạn này và cũng được
liệt kê, có `"source": "mcp"` và `job_id` khi chỉ theo dõi một job (chỉ sự
kiện của job đó được gửi tới chúng).

### Xác minh chữ ký

Các lần gửi tuân theo [Standard Webhooks](https://www.standardwebhooks.com).
Mỗi request mang:

- `webhook-id`: `id` của sự kiện;
- `webhook-timestamp`: thời điểm gửi lần thử này, tính bằng giây Unix;
- `webhook-signature`: `v1,<base64 của HMAC-SHA256 trên "<webhook-id>.<webhook-timestamp>.<raw body>">`.

Khóa HMAC là phần sau `whsec_` của secret, giải mã base64. Hãy từ chối lần gửi
có chữ ký không khớp hoặc timestamp lệch quá 5 phút so với đồng hồ của bạn, và
tính HMAC trên raw body đúng như khi nhận, trước khi parse. Thư viện Standard
Webhooks nào cũng dùng được; với Node.js thuần:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

// headers: header của request (tên viết thường); rawBody: body đúng như khi nhận, trước JSON.parse.
export function verifyMultixWebhook(secret, headers, rawBody) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  if (!id || !/^\d+$/.test(timestamp ?? "")) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  const expected = Buffer.from(`v1,${mac}`);
  return (headers["webhook-signature"] ?? "").split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

### Cơ chế gửi

- **Ít nhất một lần.** Cùng một sự kiện có thể đến nhiều lần, ví dụ khi câu
  trả lời của bạn bị mất và lần gửi được thử lại. Hãy khử trùng lặp theo
  `webhook-id`: đó là `id` của sự kiện, giống nhau ở mọi lần thử.
- **Thành công** là bất kỳ câu trả lời `2xx` nào trong vòng 10 giây. Hãy trả
  lời nhanh rồi xử lý sau.
- **Thử lại.** Hết thời gian chờ, lỗi mạng, `408`, `429` hoặc `5xx` được thử
  lại với độ trễ tăng dần 30 giây, 2 phút, 10 phút, 30 phút, 1 giờ, 3 giờ,
  6 giờ và 12 giờ (tổng cộng khoảng một ngày; lịch này là
  `RETRY_DELAYS_SECONDS` trong `worker/src/events/event-hub.ts`). Header
  `Retry-After` tính bằng giây có thể kéo dài một lần chờ, tối đa 1 giờ. Sau
  lần thử cuối, sự kiện được chuyển vào dead letter.
- **Kiểm tra lại địa chỉ.** Ngay trước mỗi lần thử, host của callback được
  phân giải lại. Nếu giờ nó phân giải ra địa chỉ không công khai (ví dụ sau DNS
  rebinding) hoặc không phân giải được, server không gửi gì và lần thử được
  thử lại như lỗi mạng, với lý do `endpoint address not public` hoặc
  `endpoint host could not be resolved`. Nếu chính bước tra DNS của server bị
  lỗi, lần thử được thử lại sau mà không tính vào giới hạn số lần thử
  (`callback address check unavailable`).
- **Không thử lại** với mọi câu trả lời khác: redirect (`3xx`, không bao giờ
  được theo) hoặc `4xx` khác đưa sự kiện vào dead letter ngay.
- **Vô hiệu hóa.** Câu trả lời `410 Gone` vô hiệu hóa subscription, 5 dead
  letter liên tiếp cũng vậy. Subscription bị vô hiệu hóa hoặc hết hạn vẫn được
  liệt kê kèm `status` và `status_reason`, nhưng không nhận gì nữa; hãy tạo
  subscription mới.

`GET /events/dead-letters` liệt kê các sự kiện đã bị bỏ cuộc, còn
`GET /events/audit` cho biết khi nào subscription được tạo, thu hồi, vô hiệu
hóa hoặc hết hạn. Để bắt kịp sau sự cố, hãy đọc các job có tên ở đó bằng
`GET /jobs/{id}`.

## Mức sử dụng, ngân sách và hoạt động

Khi Worker có binding `MULTIX_LEDGER`, mỗi tài khoản có một ledger mức sử dụng
riêng: một bản ghi (một *operation*) cho mỗi job `multix_run`, job REST và lần
chạy CLI được tải lên bằng
[`multix history push`](/vi/reference/for-ai-agents/#lịch-sử-chạy), cùng các
điều chỉnh chi phí, ngân sách và nhật ký hoạt động. Tài khoản này không bao
giờ đọc được bản ghi của tài khoản khác. Thiếu binding, các route này trả về
`503 ledger_unavailable`. Dashboard hiển thị cùng các bản ghi này (xem
[Dashboard mức sử dụng](/vi/guides/mcp-server/#dashboard-mức-sử-dụng)).

Cách đọc các con số:

- **Không biết thì là `null`, không bao giờ là `0`.** Chi phí, số token hay số
  credit mà provider không báo vẫn là `null`. `known_cost_usd` chỉ cộng các chi
  phí đã biết (do provider báo, ước tính và điều chỉnh), còn
  `unknown_cost_operations` đếm các operation không cộng được, nên một tổng
  chưa đủ không bao giờ được trình bày như tổng đầy đủ. Chi phí là bản ghi,
  không phải hóa đơn.
- `cost_provenance` của mỗi operation cho biết chi phí đến từ đâu
  (`provider_reported`, `estimated`, `billed` hoặc `unknown`).
- ID operation là `job_<job id>` cho job và `cli_<history id>` cho lần chạy CLI
  được nhập. Mỗi id chỉ được ghi một lần: một lần gửi lại hoặc push lại cùng
  lần chạy được tính là trùng lặp, không bao giờ tính hai lần.
- Chỉ lưu số đo: id, tên, thời gian, số đếm, kích thước, hash và các con số
  provider báo. Prompt, tham số CLI, thư mục làm việc, nội dung lỗi, signed URL
  và key không bao giờ được lưu.
- Operation, điều chỉnh và hoạt động cũ hơn **400 ngày** bị xóa hằng ngày.
  Hãy export trước nếu muốn giữ lâu hơn.

### Tổng hợp và operation

`GET /usage/summary`, `GET /usage/operations` và `GET /usage/export` nhận cùng
các bộ lọc:

- `from`, `to`: epoch mili giây hoặc ngày ISO. Mặc định: 30 ngày gần nhất;
  tối đa 400 ngày.
- `provider`, `model`, `command`, `client_id`, `project_id`: giá trị chính xác.
- `source` (`mcp`, `rest`, `cli`, `unknown`) và `status` (`running`,
  `succeeded`, `failed`, `timed_out`, `canceled`).

Phần tổng hợp còn nhận `group_by` (`provider`, `model`, `source`, `command`,
`status`, `client` hoặc `project`) và `tz_offset_minutes` (số phút lệch về phía
đông so với UTC cho chuỗi theo ngày, mặc định `0`):

```bash
curl -s "https://multix.zuey.me/api/v1/usage/summary?from=2026-10-01&group_by=provider" \
  -H "Authorization: Bearer $MULTIX_API_KEY"
```

Kết quả gồm `totals` (số operation, tỉ lệ thành công, chi phí đã biết và các
thành phần của nó, số operation chưa rõ chi phí, token, credit, output, lỗi
HTTP, độ trễ p50/p95), `groups` khi có `group_by`, chuỗi `series` theo ngày và
`budgets`, trạng thái của mọi ngân sách. `GET /usage/operations` liệt kê
operation mới nhất trước (`limit` 1–200, mặc định 50); truyền `next_cursor`
của response vào `cursor` để lấy trang tiếp. `GET /usage/operations/{op_id}`
trả về `{ operation, adjustments }`.

### Điều chỉnh, export và xóa

Chi phí không bao giờ bị sửa trực tiếp. Để ghi một khoản hoàn tiền hay điều
chỉnh, hãy thêm một adjustment: một số USD có dấu, được tính vào mọi tổng (hoàn
tiền là số âm).

```bash
curl -s -X POST https://multix.zuey.me/api/v1/usage/operations/job_<job_id>/adjustments \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kind": "refund", "amount_usd": -0.04, "note": "provider credit"}'
```

`kind` là `refund` hoặc `correction`, `amount_usd` nằm trong khoảng -1.000.000
đến 1.000.000, và `note` là tùy chọn (tối đa 200 ký tự).

`GET /usage/export?format=csv` (mặc định) tải về các operation đã lọc, cũ nhất
trước, tối đa 10.000 dòng: thời gian ISO 8601 UTC, ô trống cho giá trị chưa
biết, và header `x-multix-truncated: true` khi bản export bị cắt bớt.
`format=json` trả về `{ operations, truncated }`. Mỗi lần export đều được ghi
vào nhật ký hoạt động.

`POST /usage/import` là thứ `multix history push` gọi: `{ "entries": [...] }`
với tối đa 200 entry và 512 KiB mỗi request. Response là
`{ accepted, duplicates, rejected }`; entry không hợp lệ bị từ chối riêng lẻ,
còn các lần chạy đã nhập được tính là trùng lặp.

`DELETE /usage/data?confirm=delete` xóa mọi operation, điều chỉnh, cảnh báo
ngân sách và hoạt động của tài khoản. Định nghĩa ngân sách được giữ lại, và một
hoạt động `ledger.deleted` ghi nhận việc xóa.

### Ngân sách

Ngân sách là ngân sách mềm: chúng phát cảnh báo và không bao giờ dừng job. Mỗi
tài khoản có tối đa **20** ngân sách.

```bash
curl -s -X POST https://multix.zuey.me/api/v1/budgets \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Gemini this month", "scope_kind": "provider", "scope_value": "gemini",
       "period": "month", "limit_usd": 50, "thresholds": [50, 80, 100]}'
```

- `scope_kind`: `account` (không có `scope_value`), `provider`, `model`,
  `command`, `source`, `client` hoặc `project`, kèm `scope_value` tương ứng.
- `period`: `day`, `week` hoặc `month`, theo UTC; tuần bắt đầu từ thứ Hai.
- `thresholds`: 1–5 phần trăm (mặc định `[50, 80, 100]`). Mỗi lần vượt một
  ngưỡng được ghi một lần mỗi kỳ dưới dạng hoạt động `budget.threshold_crossed`.

Trạng thái (từ `GET /budgets`, `GET /budgets/{id}` và phần tổng hợp mức sử
dụng) bổ sung `spent_usd` của kỳ hiện tại, `percent`, `state` (`ok`, `warning`
khi chạm ngưỡng thấp nhất, `exceeded` ở 100 %), các `alerts` đã vượt, và
`forecast_usd`, dự báo tuyến tính đến cuối kỳ (`null` khi kỳ mới bắt đầu). Mức
chi chỉ tính chi phí đã biết; `unknown_cost_operations` cho biết có bao nhiêu
operation trong phạm vi không tính được. `PUT /budgets/{id}` thay thế toàn bộ
ngân sách.

### Nhật ký hoạt động

`GET /activities` liệt kê những gì đã xảy ra trên tài khoản, mới nhất trước:
job, lần nhập, lần export, điều chỉnh, ngân sách và cảnh báo của chúng, cùng
các thay đổi thực hiện bằng API key (provider key theo tên, lưu trữ, API key,
webhook theo host), kèm `actor` đã thực hiện. Không bao giờ có giá trị key,
prompt hay URL đầy đủ. Lọc bằng `from`, `to`, `kind` (một tiền tố như
`budget.` hoặc `job.failed`) và `q` (tìm kiếm văn bản, tối đa 100 ký tự); phân
trang bằng `limit` và `cursor` như với operation.

Các mục tạo thành một chuỗi hash: mỗi mục chứa hash của mục trước nó.
`GET /activities/verify` tính lại chuỗi và trả về
`{ ok, checked, first_bad_seq }`, nên một mục bị sửa hay bị xóa hiện ra là
`seq` đầu tiên không còn khớp. Việc dọn dữ liệu cũ xóa các mục cũ nhất; phép
kiểm tra bắt đầu từ mục cũ nhất còn lại.

## Lỗi

Lỗi là JSON có `code` cố định và thông báo không bao giờ chứa giá trị đã gửi:

```json
{ "error": { "code": "bad_request", "message": "keys is empty" } }
```

| Mã HTTP | `code` | Khi nào |
|---|---|---|
| `400` | `bad_request` | JSON, trường hoặc giá trị không hợp lệ, tên provider key không hợp lệ, hoặc lệnh, option hay input mà `multix_run` sẽ từ chối. |
| `401` | `unauthorized` | Thiếu API key, sai định dạng, không tồn tại hoặc đã bị thu hồi. |
| `403` | `forbidden` | Tài khoản không còn trong danh sách được phép đăng nhập. |
| `404` | `not_found` | Path, job, API key, subscription sự kiện, operation hoặc ngân sách không tồn tại, hoặc thuộc tài khoản khác. |
| `405` | `method_not_allowed` | Sai method; header `Allow` liệt kê các method được chấp nhận. |
| `413` | `payload_too_large` | Body lớn hơn 64 KiB (512 KiB với `POST /usage/import`). |
| `415` | `unsupported_media_type` | Body không gửi dưới dạng `application/json`. |
| `409` | `limit_reached` | Tài khoản đã có 10 subscription sự kiện đang hoạt động. |
| `409` | `budget_limit` | Tài khoản đã có 20 ngân sách. |
| `422` | `storage_check_failed` | Kiểm tra quyền truy cập R2 thất bại; không có gì được lưu. |
| `429` | `rate_limited` | Quá nhiều request; thử lại sau số giây trong `Retry-After`. |
| `429` | `busy` | Đã chạm giới hạn job: số job đang chạy của tài khoản hoặc tổng số job của server. Chờ một job kết thúc (hoặc hủy một job) thay vì thử lại ngay. |
| `503` | `unavailable` | Server không có job container, nên không chạy được job, hoặc không có binding sự kiện, nên các route sự kiện bị tắt; hoặc không phân giải được host `callback_url` của subscription mới (thử lại sau `Retry-After`). |
| `503` | `ledger_unavailable` | Server không lưu bản ghi mức sử dụng (không có binding `MULTIX_LEDGER`), nên các route mức sử dụng, ngân sách và hoạt động bị tắt. |
| `500` | `internal` | Lỗi server không lường trước. |

Tập mã lỗi được định nghĩa trong `worker/src/api/api-http.ts`.

## Giới hạn

- **Giới hạn tốc độ:** khoảng 60 request mỗi phút cho mỗi tài khoản, dùng
  chung với `/mcp` (`MCP_RATE_LIMITER`). Request thiếu key hoặc key không hợp
  lệ bị giới hạn theo IP của client (`AUTH_RATE_LIMITER`, khoảng 30 mỗi phút).
  Cả hai đều là con số gần đúng; xem [Cấu hình](/vi/guides/mcp-server/#cấu-hình).
- **Job:** cùng giới hạn với `multix_run`: `MULTIX_MAX_JOBS_PER_ACCOUNT` job
  đang chạy cho mỗi tài khoản (mặc định 2), `MULTIX_MAX_JOBS_TOTAL` trên server
  (mặc định 10), `wait_seconds` 0–40 (mặc định 25), một giới hạn 30 phút cho
  mỗi job, cùng các giới hạn của server về số output, độ dài và độ phân giải
  video.
- **API key:** tối đa 10 key mỗi tài khoản; chỉ tạo được trong dashboard.
- **Subscription sự kiện:** tối đa 10 subscription đang hoạt động mỗi tài
  khoản; thời gian sống từ 1 giờ đến 90 ngày (mặc định 30 ngày).
- **Ledger mức sử dụng:** trang 1–200 mục (mặc định 50), khoảng thời gian tối
  đa 400 ngày, export tối đa 10.000 operation, nhập tối đa 200 entry và
  512 KiB, tối đa 20 ngân sách, và lưu giữ 400 ngày.
- **Body:** object JSON tối đa 64 KiB (512 KiB với `POST /usage/import`).
