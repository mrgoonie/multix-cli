---
title: Server tự host (Docker, Kubernetes)
description: Chạy multix MCP server, dashboard và REST API thành một container Node.js không cần Cloudflare, với SQLite trên volume bền vững, đăng nhập admin cục bộ, tùy chọn chạy job ngay trong container, health probe và hợp đồng triển khai Kubernetes.
---

`multix-server` chạy cùng ứng dụng với
[Cloudflare Worker](/vi/guides/mcp-server/) (`/mcp`, `/dashboard`, OAuth,
`/api/v1`, `/api/docs`, `/health`) trong một tiến trình Node.js, không cần tài
khoản Cloudflare. Nó không sao chép Worker: `worker/server/` cung cấp cho mã
Worker các bản cài đặt Node của binding Cloudflare và giữ toàn bộ trạng thái
trong một file SQLite. Dùng nó trên máy chủ của bạn, với Docker Compose hoặc
trên Kubernetes.

## Khác biệt so với bản triển khai Cloudflare

- **Job chạy trong container của server, và chỉ khi được bật.** Không có
  container theo từng job. Với `MULTIX_LOCAL_JOBS=true`, server chạy mỗi job
  `multix_run` thành một tiến trình con của chính nó (xem
  [Chạy job](#chạy-job)). Nếu không bật, `multix_run`, `multix_job_status` và
  `multix_job_cancel` không được liệt kê, các route job của REST API trả về
  `503`, và workflow không thể khởi chạy run. `multix_catalog`,
  `multix_model_catalog`, skill, event, tài khoản, API key và dashboard hoạt
  động trong cả hai trường hợp.
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
tmpfs ghi được. Để chạy job, image còn chứa CLI `multix` được build từ cùng mã
nguồn (cùng phiên bản), `ffmpeg`, ImageMagick 7 kèm bộ mã JPEG và WebP, và
`cwebp`. `tini` chạy làm PID 1: nó chuyển `SIGTERM` cho server và thu dọn các
tiến trình mà CLI của job để lại. Không có secret nào được
đóng gói sẵn. Để tự build từ thư mục gốc của repository:

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
MULTIX_LOCAL_JOBS=true
MULTIX_MCP_UNCAPPED_SPEND=deny
EOF

docker run -d --name multix-server \
  --env-file multix.env \
  -p 127.0.0.1:3000:3000 \
  -v multix-data:/data \
  --read-only --tmpfs /tmp:size=2g \
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
một named volume, root file system chỉ đọc, tmpfs `/tmp` 2 GB cho file của job,
health check readiness, và bật chạy job (`MULTIX_LOCAL_JOBS=true`, mỗi lần một
job, `MULTIX_MCP_UNCAPPED_SPEND=deny`; đặt các biến này trong `.env` để thay
đổi):

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

## Chạy job

Chạy job tắt trừ khi đặt `MULTIX_LOCAL_JOBS=true`. Khi bật, server kiểm tra lúc
khởi động rằng CLI `multix` có trên `PATH` (image có sẵn) và từ chối khởi động
nếu không có. Dòng log `server_started` ghi `"jobs":"enabled"` hoặc
`"jobs":"disabled"`, và `/health/ready` báo `jobs` theo cùng cách.

Cách một job chạy:

- `multix_run`, `multix_job_status`, `multix_job_cancel` và
  `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}`,
  `POST /api/v1/jobs/{id}/cancel` dùng cùng mã, cùng kiểm tra đầu vào, giới hạn
  và chốt chặn chi phí như trên Cloudflare. Chỉ nơi CLI chạy là khác.
- Mỗi job là một tiến trình `multix` được khởi chạy bằng danh sách đối số
  (không bao giờ qua shell) trong thư mục riêng dưới `/tmp`, bị xóa khi job kết
  thúc. URL đầu vào chỉ được tải từ địa chỉ HTTPS công khai, kiểm tra trên
  chính địa chỉ được kết nối. Cả job có giới hạn 30 phút.
- Provider key của tài khoản được truyền cho tiến trình trong bộ nhớ, chỉ cho
  job đó. Chúng không bao giờ được ghi xuống đĩa; stdout và stderr được trả về
  với giá trị key thay bằng `[redacted]`.
- File đầu ra được upload lên bucket Cloudflare R2 của tài khoản, cấu hình
  trong `/dashboard` (Storage), và trả về dưới dạng link. Không có bucket thì
  file không được giữ lại: kết quả liệt kê tên và kích thước với `url: null`,
  và URL của provider mà CLI in ra được trả về nguyên vẹn.
- Bản ghi job (trạng thái, kết quả, chủ sở hữu; không có key, không có đối số)
  được giữ trong `$MULTIX_DATA_DIR/jobs` (mode `0700`) trong 7 ngày.

Đồng thời:

- `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` (1 đến 64, mặc định `1`) là số tiến trình
  CLI được chạy cùng lúc. Giới hạn toàn server `MULTIX_MAX_JOBS_TOTAL` được hạ
  xuống bằng giá trị này, nên job vượt giới hạn bị từ chối với
  `server at capacity` (lỗi MCP, REST `429`) trước khi gọi bất kỳ provider
  nào. `MULTIX_MAX_JOBS_PER_ACCOUNT` (mặc định `2`) vẫn giới hạn từng tài khoản.
- Job giữ slot cho đến khi tiến trình CLI của nó đã thoát, kể cả sau khi bị
  hủy hoặc hết giờ, nên job tạo ngay sau một lệnh hủy có thể bị từ chối trong
  chốc lát trong lúc tiến trình cũ dừng lại. CLI nào bỏ qua `SIGTERM` sẽ bị
  dừng bằng `SIGKILL` sau 10 giây.
- Cấp CPU, bộ nhớ và `/tmp` cho chừng đó job: một job có thể tải tới 200 MB
  cho mỗi file đầu vào, và job video chạy `ffmpeg`.

Khởi động lại và tắt server:

- Khi nhận `SIGTERM`, các job đang chạy bị dừng ngay và được ghi là `failed`
  kèm giải thích `interrupted`; người gọi còn đang chờ job đó nhận được kết
  quả này. Slot của chúng được giải phóng trước khi database đóng nếu CLI
  thoát trong thời gian chờ tắt; nếu không, lần khởi động sau sẽ giải phóng chúng.
- Job đang chạy khi tiến trình chết được ghi theo cùng cách ở lần khởi động
  sau. Nó không bao giờ được chạy lại, nên lệnh gọi provider có tính phí không
  bị lặp lại: người gọi tạo job mới để thử lại. Mọi slot job mà tiến trình
  trước để lại được xóa khi khởi động.

Một replica cho mỗi volume: executor giữ một lock socket trong
`$MULTIX_DATA_DIR/jobs`, ngăn tiến trình thứ hai trên cùng máy dùng chung thư
mục. Nó không thấy được tiến trình trên node khác, nên đừng bao giờ dùng chung
volume dữ liệu giữa các replica (dùng volume `ReadWriteOnce` và `replicas: 1`).

Chi phí: đặt `MULTIX_MCP_UNCAPPED_SPEND=deny` (mặc định của file mẫu) để run
có chi phí mà giới hạn của operator không chặn được bị từ chối. Nếu không đặt,
mặc định trong mã là `budget`, chỉ chạy lệnh như vậy khi người gọi truyền
`max_cost_usd` và giá đã biết và nằm trong mức đó.

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

Job:

| Biến | Mặc định | Tác dụng |
|---|---|---|
| `MULTIX_LOCAL_JOBS` | tắt | `true` chạy job `multix_run` thành tiến trình con của server (cần CLI `multix` trên `PATH`). |
| `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` | `1` | Số tiến trình CLI được chạy cùng lúc (1 đến 64). Cũng giới hạn `MULTIX_MAX_JOBS_TOTAL`. |
| `MULTIX_MAX_JOBS_PER_ACCOUNT` | `2` | Số job một tài khoản được chạy cùng lúc. |
| `MULTIX_MCP_UNCAPPED_SPEND` | `budget` | `deny` từ chối run mà giới hạn của operator không chặn được (khuyến nghị, mặc định của file mẫu); `budget` cần `max_cost_usd`; `allow` cho chạy. |

Các giới hạn tool `MULTIX_MCP_*` trong [cấu hình Worker](/vi/guides/mcp-server/#cấu-hình)
được đọc theo cùng cách. Một số không hợp lệ trong bảng server khiến tiến trình
dừng ngay khi khởi động với thông báo nêu tên biến. Bộ phân tích cấu hình là
[`worker/server/server-config.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/server-config.ts).

## Health, tắt server và smoke test

- `GET /health` (liveness): `{ "ok": true }` khi tiến trình đang phục vụ
  request.
- `GET /health/ready` (readiness): `200` khi database ghi được và cấu hình đầy
  đủ (và, khi bật job, executor đang nhận job), ngược lại `503` với `checks` nêu
  phần bị lỗi. Nó cũng trả về `503` khi server đang drain. `jobs` cho biết
  `enabled` hoặc `disabled`.

Khi nhận `SIGTERM` hoặc `SIGINT`, readiness chuyển sang `503`, listener ngừng
nhận kết nối và các job đang chạy bị dừng và được ghi là bị gián đoạn. Request
đang mở và tác vụ nền có `MULTIX_SHUTDOWN_TIMEOUT_MS` để hoàn tất; cùng lúc đó
tiến trình job có thời gian bằng giá trị nhỏ hơn giữa 10 giây và một nửa
timeout này để thoát (cộng tối đa 5 giây để ghi lại và giải phóng slot). Sau đó
database được đóng. Hãy cho orchestrator thời gian chờ dài hơn giá trị lớn hơn
giữa timeout này và 15 giây.

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
| Đường dẫn ghi được | Chỉ `/data` và `/tmp` (một `emptyDir`, đủ chỗ cho file của job); root file system có thể chỉ đọc. |
| User | `node` không phải root (uid 1000); đặt `fsGroup: 1000` để volume ghi được. |
| Biến môi trường | `MULTIX_PUBLIC_URL` (origin của ingress), `MULTIX_LOCAL_AUTH=true` và/hoặc đăng nhập GitHub, `MULTIX_TRUST_PROXY_HOPS=1` khi đứng sau một ingress; để chạy job thêm `MULTIX_LOCAL_JOBS=true`, `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` và `MULTIX_MCP_UNCAPPED_SPEND=deny`. |
| Secret | `SESSION_SECRET`, `SECRETS_ENCRYPTION_KEY`, `MULTIX_BOOTSTRAP_TOKEN`, và `GITHUB_CLIENT_SECRET` / `MULTIX_ALLOWED_USERS` nếu dùng, nạp từ secret store, không bao giờ ghi vào manifest. |
| Probe | Liveness `GET /health`, readiness `GET /health/ready`. |
| Tắt server | `terminationGracePeriodSeconds` lớn hơn giá trị lớn hơn giữa `MULTIX_SHUTDOWN_TIMEOUT_MS` và 15 giây (ví dụ 30 giây cho mặc định 20 giây). |
| Tài nguyên | Khi bật job, các tiến trình CLI (và `ffmpeg`) chạy trong container này: cấp CPU, bộ nhớ và `/tmp` cho `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` job. Giá trị bên dưới là điểm khởi đầu cho mỗi lần một job, không phải kết quả benchmark; điều chỉnh theo mức sử dụng thực tế. |

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
            - { name: MULTIX_LOCAL_JOBS, value: "true" }
            - { name: MULTIX_LOCAL_MAX_CONCURRENT_JOBS, value: "1" }
            - { name: MULTIX_MCP_UNCAPPED_SPEND, value: deny }
          envFrom:
            - secretRef:
                name: multix-server-secrets   # SESSION_SECRET, SECRETS_ENCRYPTION_KEY, MULTIX_BOOTSTRAP_TOKEN
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits: { memory: 2Gi }
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
          emptyDir: { sizeLimit: 2Gi }
```

## Sao lưu và khôi phục

Mọi thứ trừ secret đều nằm trong `/data`: `multix.sqlite` cùng các file
`multix.sqlite-wal` và `multix.sqlite-shm` khi server đang chạy, và bản ghi job
trong `/data/jobs`.

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
