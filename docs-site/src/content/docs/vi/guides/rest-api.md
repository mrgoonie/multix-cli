---
title: REST API và API key của tài khoản
description: Dùng REST API của multix MCP server từ script và CI bằng API key của tài khoản để quản lý provider key và lưu trữ R2, đọc catalog CLI, và chạy, theo dõi, hủy job CLI.
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

Mỗi request kiểm tra key, rồi danh sách được phép đăng nhập
(`MULTIX_ALLOWED_USERS`, nên xóa một tài khoản khỏi danh sách cũng chặn luôn
các API key của nó), rồi giới hạn tốc độ theo tài khoản. Body của request là
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

Tên provider key là tên biến môi trường mà CLI đọc (ví dụ `GEMINI_API_KEY`),
cùng các tên của Cloudflare Workers AI; `GET /provider-keys` liệt kê tất cả.
Giá trị phải gồm 1–1024 ký tự in được, không có khoảng trắng.

## Provider key

Đặt một key, lấy giá trị từ biến môi trường để nó không nằm trong lịch sử
shell:

```bash
curl -s -X PUT https://multix.zuey.me/api/v1/provider-keys/GEMINI_API_KEY \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"value\": \"$GEMINI_API_KEY\"}"
```

Đặt và xóa nhiều key trong một request (`null` xóa key). Response chỉ liệt kê
tên: `{ "saved": [...], "removed": [...] }`.

```bash
curl -s -X PATCH https://multix.zuey.me/api/v1/provider-keys \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"keys\": {\"GEMINI_API_KEY\": \"$GEMINI_API_KEY\", \"OPENAI_API_KEY\": \"$OPENAI_API_KEY\", \"FAL_KEY\": null}}"
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
  const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
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
  -d "{\"account_id\": \"$R2_ACCOUNT_ID\", \"access_key_id\": \"$R2_ACCESS_KEY_ID\", \"secret_access_key\": \"$R2_SECRET_ACCESS_KEY\", \"bucket\": \"my-multix-outputs\", \"public_base_url\": \"https://files.example.com\"}"
```

`public_base_url` là tùy chọn. Response, giống `GET /storage`, không bao giờ
chứa access key.

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
- `202`: job vẫn `running`; `next.path` là URL cần gọi lại, ví dụ
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
| `404` | `not_found` | Path, job hoặc API key không tồn tại, hoặc job của tài khoản khác. |
| `405` | `method_not_allowed` | Sai method; header `Allow` liệt kê các method được chấp nhận. |
| `413` | `payload_too_large` | Body lớn hơn 64 KiB. |
| `415` | `unsupported_media_type` | Body không gửi dưới dạng `application/json`. |
| `422` | `storage_check_failed` | Kiểm tra quyền truy cập R2 thất bại; không có gì được lưu. |
| `429` | `rate_limited` | Quá nhiều request; thử lại sau số giây trong `Retry-After`. |
| `429` | `busy` | Đã chạm giới hạn job: số job đang chạy của tài khoản hoặc tổng số job của server. Chờ một job kết thúc (hoặc hủy một job) thay vì thử lại ngay. |
| `503` | `unavailable` | Server không có job container, nên không chạy được job. |
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
- **Body:** object JSON tối đa 64 KiB.
