---
title: Server tự host (Docker, Kubernetes)
description: Chạy multix MCP server, dashboard và REST API thành một container Node.js không cần Cloudflare, với SQLite trên volume bền vững, đăng nhập admin cục bộ, health probe và hợp đồng triển khai Kubernetes.
---

`multix-server` chạy cùng ứng dụng với
[Cloudflare Worker](/vi/guides/mcp-server/) (`/mcp`, `/dashboard`, OAuth,
`/api/v1`, `/api/docs`, `/health`) trong một tiến trình Node.js, không cần tài
khoản Cloudflare. Nó không sao chép Worker: `worker/server/` cung cấp cho mã
Worker các bản cài đặt Node của binding Cloudflare và giữ toàn bộ trạng thái
trong một file SQLite. Dùng nó trên máy chủ của bạn, với Docker Compose hoặc
trên Kubernetes.

## Khác biệt so với bản triển khai Cloudflare

- **Không có job runner.** Không có container theo từng job (`MULTIX_JOBS`,
  `MULTIX_JOB_QUOTA`), nên `multix_run`, `multix_job_status` và
  `multix_job_cancel` không được liệt kê, các route job của REST API trả về
  `503`, và workflow không thể khởi chạy run. `multix_catalog`,
  `multix_model_catalog`, skill, event, tài khoản, API key và dashboard vẫn
  hoạt động. Việc chạy job khi tự host được theo dõi tại
  [issue #550](https://github.com/mrgoonie/multix-cli/issues/550).
- **Lưu trữ:** trạng thái OAuth, tài khoản, provider key đã mã hóa, skill và
  đăng ký event nằm trong `$MULTIX_DATA_DIR/multix.sqlite` (mặc định
  `/data/multix.sqlite`, chế độ WAL) thay vì KV và Durable Object.
- **Một replica duy nhất.** Rate limit được đếm trong bộ nhớ và chỉ một tiến
  trình sở hữu file SQLite. Chạy đúng một instance.
- **Đăng nhập:** đăng nhập bằng username và mật khẩu với một admin bootstrap
  dùng một lần (`MULTIX_LOCAL_AUTH=true`), nên GitHub OAuth App là tùy chọn.
  Không có đăng ký công khai.
- **Request ra ngoài** (đăng nhập GitHub, client metadata document, API của
  provider, webhook event) chỉ được kết nối tới địa chỉ công khai, kiểm tra
  trên chính địa chỉ được kết nối, giống `fetch` chỉ-công-khai của Worker.

Provider key không bao giờ được đọc từ biến môi trường của server: mỗi tài
khoản tự lưu key của mình trong dashboard, giống trên Cloudflare.

## Image

Mỗi bản phát hành publish `ghcr.io/mrgoonie/multix-server` cho `linux/amd64`
và `linux/arm64` với hai tag bất biến, `<version>` (ví dụ phiên bản npm) và
`sha-<12 ký tự hex của commit>`. Không có tag `latest`. Hãy ghim một phiên bản,
hoặc tốt hơn là digest hiển thị trong phần tóm tắt lần chạy của
[workflow publish](https://github.com/mrgoonie/multix-cli/blob/main/.github/workflows/publish-server-image.yml).

Image chạy bằng user không phải root `node`, lắng nghe cổng `3000`, khai báo
`/data` là volume, và chạy được với root file system chỉ đọc khi `/tmp` là
tmpfs ghi được. Không có secret nào được đóng gói sẵn. Để tự build từ thư mục
gốc của repository:

```bash
docker build -f worker/server/Dockerfile -t multix-server:dev .
```

Image này không phải job container (`worker/container/Dockerfile`), thứ không
bao giờ được để lộ ra Internet.

## Bắt đầu nhanh với Docker

Tạo secret một lần và giữ lại: thay `SECRETS_ENCRYPTION_KEY` khiến mọi
provider key đã lưu không đọc được nữa, còn thay `SESSION_SECRET` sẽ đăng xuất
tất cả mọi người.

```bash
umask 077
cat > multix.env <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
MULTIX_PUBLIC_URL=http://localhost:3000
MULTIX_LOCAL_AUTH=true
EOF

docker run -d --name multix-server \
  --env-file multix.env \
  -p 127.0.0.1:3000:3000 \
  -v multix-data:/data \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --stop-timeout 30 \
  ghcr.io/mrgoonie/multix-server:<version>

docker logs multix-server   # in bootstrap token ở lần khởi động đầu tiên
```

Mở `http://localhost:3000/dashboard/setup`, nhập bootstrap token và tạo admin
(xem [Đăng nhập lần đầu](#đăng-nhập-lần-đầu)). Nếu bạn mount một thư mục trên
máy chủ thay cho named volume, thư mục đó phải ghi được bởi user `node`
(uid 1000).

## Bắt đầu nhanh với Docker Compose

[`worker/server/compose.yaml`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/compose.yaml)
build image từ mã nguồn đã checkout và chạy nó tại `http://localhost:3000` với
một named volume, root file system chỉ đọc và health check readiness:

```bash
cp worker/server/server.env.example worker/server/.env   # điền hai secret
docker compose -f worker/server/compose.yaml up --build
```

[`worker/server/server.env.example`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/server.env.example)
liệt kê mọi thiết lập kèm cách tạo từng secret. `worker/server/.env` đã được
git-ignore; đừng bao giờ commit nó.

## Đăng nhập lần đầu

Với `MULTIX_LOCAL_AUTH=true`, server chưa có tài khoản nào cho tới khi bạn tạo
admin bootstrap tại `<origin>/dashboard/setup`. Form yêu cầu một bootstrap
token:

- Nếu đặt `MULTIX_BOOTSTRAP_TOKEN` (một secret dài ít nhất 32 ký tự), dùng giá
  trị đó. Giá trị ngắn hơn bị bỏ qua.
- Nếu không, mỗi lần khởi động server tạo một token ngẫu nhiên, chỉ lưu hash
  của nó và in token một lần ra stdout (log của container). Lần khởi động sau
  sẽ thay token đó, và đặt `MULTIX_BOOTSTRAP_TOKEN` sau này sẽ thu hồi nó.

Token chỉ dùng được một lần: khi admin đã tồn tại, `/dashboard/setup` trả về
`404` và token mất hiệu lực. Username dài 3 đến 32 ký tự gồm chữ thường, chữ
số, `.`, `_` hoặc `-`; mật khẩu dài 12 đến 256 ký tự. Nếu log được thu thập tập
trung, hãy đặt `MULTIX_BOOTSTRAP_TOKEN` từ secret store để token không bao giờ
xuất hiện trong log.

Admin là tài khoản cục bộ duy nhất. Người khác đăng nhập bằng GitHub: đặt
`GITHUB_CLIENT_ID` và `GITHUB_CLIENT_SECRET` (callback
`<origin>/oauth/github/callback`) và liệt kê họ trong `MULTIX_ALLOWED_USERS`.
Khi không đặt `MULTIX_LOCAL_AUTH`, GitHub là cách đăng nhập duy nhất và admin
cục bộ không đăng nhập được nữa.

Sau đó kết nối client đúng như trong
[Kết nối client](/vi/guides/mcp-server/#kết-nối-client), với `/mcp` trên origin
của bạn.

## Cấu hình

Bắt buộc:

| Biến | Tác dụng |
|---|---|
| `MULTIX_PUBLIC_URL` | Origin bên ngoài mà người dùng và MCP client truy cập, ví dụ `https://multix.example.com` (chỉ dùng `http://` cho `localhost`). Mọi URL của request được dựng lại trên origin này; header `Host` và `X-Forwarded-*` bị bỏ qua, nên chúng không thể điều khiển OAuth metadata hay redirect. Thiếu giá trị hợp lệ thì ứng dụng trả về `503` và readiness thất bại. |
| `SESSION_SECRET` | Ít nhất 32 ký tự (`openssl rand -hex 32`). Ký cookie dashboard và token của form. |
| `SECRETS_ENCRYPTION_KEY` | Base64 của đúng 32 byte ngẫu nhiên (`openssl rand -base64 32`). Mã hóa provider key đã lưu. |
| `MULTIX_LOCAL_AUTH` hoặc `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | Ít nhất một cách đăng nhập. `MULTIX_LOCAL_AUTH=true` bật đăng nhập cục bộ. |

Đăng nhập:

| Biến | Tác dụng |
|---|---|
| `MULTIX_BOOTSTRAP_TOKEN` | Bootstrap token tùy chọn (32+ ký tự). Nếu không đặt, một token được tạo và in ra ở mỗi lần khởi động cho tới khi admin tồn tại. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Đăng nhập GitHub tùy chọn. |
| `MULTIX_ALLOWED_USERS` | Login GitHub hoặc email đã xác minh được phép đăng nhập bằng GitHub. Để trống thì không tài khoản GitHub nào được phép. |

Server:

| Biến | Mặc định | Tác dụng |
|---|---|---|
| `HOST` | `0.0.0.0` | Địa chỉ lắng nghe. |
| `PORT` | `3000` | Cổng lắng nghe. |
| `MULTIX_DATA_DIR` | `/data` | Thư mục chứa `multix.sqlite`. Phải bền vững. |
| `MULTIX_TRUST_PROXY_HOPS` | `0` | Số reverse proxy phía trước server có nối thêm vào `X-Forwarded-For` (0 đến 10). `0` dùng địa chỉ socket làm IP client cho rate limit theo IP; đặt `1` khi đứng sau một ingress. |
| `MULTIX_SHUTDOWN_TIMEOUT_MS` | `20000` | Thời gian cho request đang mở và tác vụ nền hoàn tất sau `SIGTERM` (0 đến 300000). |
| `MULTIX_MAX_BODY_BYTES` | `16777216` | Body request lớn nhất mà listener chấp nhận (64 KiB đến 64 MiB); body lớn hơn nhận `413`. Giới hạn của từng route, như 64 KiB của `/mcp`, vẫn áp dụng. |
| `MULTIX_MCP_RATE_LIMIT` | `60` | Số request mỗi phút cho mỗi tài khoản trên `/mcp` và REST API. |
| `MULTIX_AUTH_RATE_LIMIT` | `30` | Số request mỗi phút cho mỗi IP client trên đăng nhập và các route xác thực khác. |

Các giới hạn tool `MULTIX_MCP_*` trong [cấu hình Worker](/vi/guides/mcp-server/#cấu-hình)
được đọc theo cùng cách. Một số không hợp lệ trong bảng server khiến tiến trình
dừng ngay khi khởi động với thông báo nêu tên biến. Bộ phân tích cấu hình là
[`worker/server/server-config.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/server-config.ts).

## Health, tắt server và smoke test

- `GET /health` (liveness): `{ "ok": true }` khi tiến trình đang phục vụ
  request.
- `GET /health/ready` (readiness): `200` khi database ghi được và cấu hình đầy
  đủ, ngược lại `503` với `checks` nêu phần bị lỗi. Nó cũng trả về `503` khi
  server đang drain.

Khi nhận `SIGTERM` hoặc `SIGINT`, readiness chuyển sang `503`, listener ngừng
nhận kết nối, request đang mở và tác vụ nền có `MULTIX_SHUTDOWN_TIMEOUT_MS` để
hoàn tất, sau đó database được đóng. Hãy cho orchestrator thời gian chờ dài hơn
timeout này.

`npm run smoke:server` trong `worker/` kiểm tra đầu-cuối một server đang chạy
như một MCP client: readiness, tạo admin hoặc đăng nhập, đăng ký client, ủy
quyền PKCE kèm xác nhận, rồi `tools/list` và một lệnh gọi `multix_catalog`
(không liên hệ provider nào). Trên server mới, nó tạo admin với thông tin đăng
nhập được cung cấp.

```bash
npm ci --prefix worker
cd worker
MULTIX_SMOKE_URL=http://localhost:3000 \
MULTIX_SMOKE_USERNAME=admin \
MULTIX_SMOKE_PASSWORD='<12+ ký tự>' \
MULTIX_SMOKE_BOOTSTRAP_TOKEN='<token trong log>' \
npm run smoke:server
```

`MULTIX_SMOKE_URL` phải bằng `MULTIX_PUBLIC_URL` của server. Bootstrap token
chỉ cần khi trang setup còn mở.

## Hợp đồng Kubernetes (TOSE)

Những gì một bản triển khai Kubernetes hoặc TOSE phải cung cấp:

| Mục | Hợp đồng |
|---|---|
| Image | `ghcr.io/mrgoonie/multix-server`, ghim theo tag phiên bản hoặc digest. |
| Replica | Đúng `1`, với strategy `Recreate`. Rolling update sẽ chạy hai tiến trình trên cùng một file SQLite. |
| Cổng | Container port `3000` (`PORT`), HTTP. Kết thúc TLS tại ingress. |
| Volume | Một persistent volume (PVC, `ReadWriteOnce`) tại `/data`. `emptyDir` sẽ mất mọi tài khoản ở lần khởi động lại. |
| Đường dẫn ghi được | Chỉ `/data` và `/tmp` (một `emptyDir`); root file system có thể chỉ đọc. |
| User | `node` không phải root (uid 1000); đặt `fsGroup: 1000` để volume ghi được. |
| Biến môi trường | `MULTIX_PUBLIC_URL` (origin của ingress), `MULTIX_LOCAL_AUTH=true` và/hoặc đăng nhập GitHub, `MULTIX_TRUST_PROXY_HOPS=1` khi đứng sau một ingress. |
| Secret | `SESSION_SECRET`, `SECRETS_ENCRYPTION_KEY`, `MULTIX_BOOTSTRAP_TOKEN`, và `GITHUB_CLIENT_SECRET` / `MULTIX_ALLOWED_USERS` nếu dùng, nạp từ secret store, không bao giờ ghi vào manifest. |
| Probe | Liveness `GET /health`, readiness `GET /health/ready`. |
| Tắt server | `terminationGracePeriodSeconds` lớn hơn `MULTIX_SHUTDOWN_TIMEOUT_MS` (ví dụ 30 giây cho mặc định 20 giây). |
| Tài nguyên | Không có job nào chạy trong tiến trình này. Giá trị bên dưới là điểm khởi đầu, không phải kết quả benchmark; điều chỉnh theo mức sử dụng thực tế. |

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multix-server
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: { app: multix-server }
  template:
    metadata:
      labels: { app: multix-server }
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: multix-server
          image: ghcr.io/mrgoonie/multix-server:<version>
          ports:
            - containerPort: 3000
          env:
            - { name: MULTIX_PUBLIC_URL, value: https://multix.example.com }
            - { name: MULTIX_LOCAL_AUTH, value: "true" }
            - { name: MULTIX_TRUST_PROXY_HOPS, value: "1" }
          envFrom:
            - secretRef:
                name: multix-server-secrets   # SESSION_SECRET, SECRETS_ENCRYPTION_KEY, MULTIX_BOOTSTRAP_TOKEN
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 512Mi }
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: multix-data
        - name: tmp
          emptyDir: {}
```

## Sao lưu và khôi phục

Mọi thứ trừ secret đều nằm trong `/data`: `multix.sqlite` cùng các file
`multix.sqlite-wal` và `multix.sqlite-shm` khi server đang chạy.

- **Offline:** dừng server (hoặc scale về 0), sao chép toàn bộ thư mục `/data`,
  rồi khởi động lại.
- **Online:** dùng cơ chế backup của SQLite, vốn đọc một bản sao nhất quán gồm
  cả WAL, từ một công cụ mount cùng volume, ví dụ
  `sqlite3 /data/multix.sqlite ".backup '/backup/multix.sqlite'"`. Image không
  có sẵn CLI `sqlite3`. Chỉ sao chép `multix.sqlite` từ server đang chạy có thể
  bỏ sót những lần ghi gần nhất.

Sao lưu `SECRETS_ENCRYPTION_KEY` cùng với dữ liệu: thiếu nó, provider key đã
lưu trong database được khôi phục sẽ không đọc được. Để khôi phục, dừng
server, thay nội dung của `/data`, rồi khởi động lại.

## PostgreSQL (ghi chú thiết kế, chưa triển khai)

Server chỉ hỗ trợ SQLite. Adapter PostgreSQL chưa được triển khai. Nó sẽ không
thay đổi mã Worker: nó sẽ cung cấp đúng các interface binding mà adapter
SQLite đang cài đặt
([`sqlite-kv-namespace.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/sqlite-kv-namespace.ts)
cho các KV namespace, [`durable-object-host.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/durable-object-host.ts)
cho storage và alarm của Durable Object) trên các bảng PostgreSQL tương đương
với các bảng `kv`, `do_storage` và `do_alarm`. Chỉ riêng PostgreSQL sẽ không
cho phép chạy nhiều hơn một replica: rate limiter nằm trong bộ nhớ, và mỗi
instance Durable Object cùng alarm của nó chạy bên trong một tiến trình, nên
nhiều replica còn cần rate limit dùng chung và một chủ sở hữu duy nhất cho mỗi
object.
