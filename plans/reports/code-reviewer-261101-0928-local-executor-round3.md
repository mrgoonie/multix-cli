# Code review vòng 3: local child-process job executor (Unix-socket lock)

Branch `claude/relaxed-clarke-yce0xf`, `git diff origin/dev...HEAD`.
Files: `worker/container/local-executor.mjs` (502 LOC), `worker/test/local-executor.test.ts` (402 LOC), `worker/test/fixtures/lock-contender.mjs` (16 LOC).
Checks: `npx vitest run test/local-executor.test.ts` 16/16 pass, 5 lần liên tiếp và 3 lần khi CPU bị tải bằng `nproc` busy loop. `biome check` sạch. Module vẫn chưa có caller (grep `createLocalExecutor` chỉ thấy test/fixture).
Repro scripts (scratch, không commit): `/tmp/claude-0/r3/{long,long2,long3,marker}.mjs`, mutation copy `/tmp/claude-0/r3/mut/`.

## Tổng quan

Thay heartbeat lock bằng Unix-socket lock đã loại bỏ toàn bộ nhóm lỗi mtime/give-back của vòng 2. Probe hai lần dưới marker là đúng cho các contender **cùng kernel**. Còn một lỗi High tái hiện được: libuv **cắt ngắn âm thầm** socket path dài hơn 107 byte. Socket vì thế nằm ngoài `stateDir`, và sau một lần crash, server **không bao giờ khởi động lại được**. Ngoài ra, header hứa phát hiện replica thứ hai "on a shared volume". Điều này sai khi hai replica ở hai node khác nhau, và đây là regression về phạm vi bảo đảm so với lock dạng file.

## Đối chiếu finding vòng 2

| ID | Trạng thái | Ghi chú |
|---|---|---|
| N1 lock take over đã stale | **Obsolete** | Không còn dùng mtime hay heartbeat. |
| N2 heartbeat coi lỗi đọc là mất lock | **Obsolete** | Không còn heartbeat. Kernel giữ trạng thái socket. |
| N3 give-back race | **Obsolete** | Không còn rename/tomb. Việc xóa chỉ xảy ra dưới marker, sau probe lần hai (`:206-211`). |
| N4 vòng quay vô hạn | **Đã sửa** | Vòng lặp giới hạn 50 lần (`:187`), lỗi khác `EADDRINUSE`/`EEXIST` được ném ra. Xem H1 và L1 về hai trường hợp "giới hạn" trả lỗi sai. |
| N5 close lần hai resolve sớm | **Đã sửa** | `closing ??= shutdown()` (`:476`), `closed = true` được đặt đồng bộ ở đầu. |
| N6 / L4 | Xem phần L4 bên dưới | |
| N7 tmp/tomb lock không được dọn | **Obsolete** | Không còn tmp lock. Marker sót lại vô hại (xem L1). |
| N8 nhánh closed trả `running` | **Đã sửa** | `finishWithRetry` giờ luôn trả về view final (dù chỉ nằm trong memory), nên `?? view` (`:403`) không còn đạt tới được. |
| M4 final write lỗi | **Đã sửa (chưa có test)** | Có map `unsaved` (`:256`, `:311-319`). Còn một race nhỏ, xem L2. |
| L6 fsync thư mục | **Đã sửa** | `syncDir` có trong `writeAtomic` (`:130`) và `createExclusive` (`:138`). |
| T1 test phantom | **Đã sửa** | Đã kiểm chứng bằng mutation: đổi `if (closed)` ở `:398` thành `if (false)` thì test fail (`expected 'running' to be 'failed'`). Loop `activeJobs() === 0` + `setImmediate` gọi `close()` trong lúc `createExclusive` đang chờ, nên test đi vào đúng kiểm tra thứ hai. |

Regression vòng 1: không thấy. M1 ("close xóa lock của người khác") chỉ quay lại dưới điều kiện của M1-mới bên dưới (libuv `unlink` path khi close). M2, M3, M5, L1, L5 vẫn đúng.

## Finding

### High

**H1. State dir dài thì socket path bị cắt âm thầm: socket nằm ngoài `stateDir`, và sau một crash server bị khóa vĩnh viễn với `ExecutorLockedError`**
`local-executor.mjs:185`, `:189`, `:193`, `:208` (header `:33` chỉ "nhắc" giới hạn chứ không kiểm tra).
Node 22.23 / libuv không trả `ENAMETOOLONG` mà cắt `sun_path` còn 107 byte. Hệ quả:
- `listen` và `connect` dùng path đã cắt, nên socket được tạo ở thư mục **cha**, với tên là tiền tố của `stateDir`. Repro `long2.mjs`: `stateDir` = `<base>/` + 110 ký tự `y`. `readdir(stateDir)` ra `[]`, còn `readdir(base)` có thêm một entry 82 ký tự.
- `rm(path)` ở `:208` dùng path **đầy đủ**, nên không bao giờ xóa được socket chết ở path đã cắt. Sau khi process bị SIGKILL hoặc OOM, mọi lần khởi động: `listen` gặp EADDRINUSE, probe ra `dead`, `rm` path đầy đủ là no-op, lặp 50 lần. Kết quả là `ExecutorLockedError("Another multix server process is using this job state directory")`. Repro `long3.mjs`: `restart: ExecutorLockedError ... 56 ms`. Pod sẽ crash loop mãi với thông báo sai, cho tới khi có người tự tìm và xóa file ở thư mục cha.
- Phụ: hai `stateDir` khác nhau có chung 107 byte đầu sẽ khóa lẫn nhau. Socket cũng tạo file ngoài thư mục đã `chmod 0700`.
- Kịch bản thực tế: PVC mount ở đường dẫn sâu, ví dụ `/var/lib/kubelet/pods/<uuid>/volumes/kubernetes.io~csi/pvc-<uuid>/mount/...` (hostPath/CSI dễ vượt 100 byte), hoặc `stateDir` do operator đặt dưới một app root dài.
- Fix: kiểm tra trước `Buffer.byteLength(path) <= 107` (Linux; macOS là 103) và ném lỗi rõ, ví dụ `"job state directory path is too long for its lock socket (N bytes, max 107); use a shorter MULTIX_... path"`. Có thể thêm phương án chạy `listen`/`connect`/`rm` bằng path tương đối với `process.chdir` (không nên trong server). Thêm test cho `stateDir` dài: cả lỗi rõ lẫn trường hợp restart sau crash.

### Medium

**M1. Replica trên node khác dùng chung volume (RWX/NFS/CephFS) không bị phát hiện: cả hai cùng chạy, và mỗi bên xóa socket của bên kia**
`local-executor.mjs:26-33`, `:193`, `:208`, `:500`.
Unix socket chỉ connect được trong cùng một kernel. Từ node khác, `connect()` vào socket inode trên network FS trả `ECONNREFUSED`, nên `probeSocket` ra `"dead"`. Replica B (node 2) sẽ xóa socket đang sống của A (`:208`), tự bind và chạy `sweep({recover:true})`. Bước sweep này đánh dấu `interrupted` các job A đang chạy, trong khi CLI của A vẫn gọi provider. Cap thực tế gấp đôi, và job bị báo `interrupted` dù vẫn chạy và tính phí. Thêm nữa, libuv `unlink` path khi `server.close()` (`:500`), nên `close()` của A sẽ xóa socket của B. Đây là regression về bảo đảm: lock dạng file của vòng 2 vẫn phát hiện được trường hợp cross-host.
Header `:27-29` viết "A second server process (another replica on a shared volume) finds the socket answering and refuses to start". Câu này sai với cross-node. Câu "Supported layout: one replica per volume (a ReadWriteOnce PVC)" chỉ giới hạn đúng nếu thêm "trên cùng một node". Hai pod cùng node vẫn mount được một RWO PVC, và trường hợp đó socket xử lý đúng.
Không repro được trong sandbox một host. Dựa trên ngữ nghĩa Unix domain socket của Linux (socket gắn với inode trong kernel cục bộ).
Fix tối thiểu: sửa header và doc vận hành: "chỉ bảo vệ các process cùng host; không hỗ trợ RWX hoặc nhiều replica". Nếu cần phát hiện cross-host, ghi thêm một file `owner` (hostname + boot id) cạnh socket, và từ chối take over khi hostname khác mà socket chưa "dead" theo một tiêu chí khác.

### Low

**L1. Marker sót lại sau crash giữa lúc take over gây `ExecutorLockedError` sai trong ~5s**
`local-executor.mjs:195-205`, `:213`, `:55`.
Nhánh không giữ marker sleep 20-50ms, nhân 50 lần là khoảng 1.75s, ngắn hơn `TAKEOVER_STALE_MS` = 5s. Nếu process bị SIGKILL giữa `open(marker)` và `rm(marker)`, rồi restart trong vòng 5s, lần start đó báo "Another multix server process is using…" dù không ai giữ. Repro `marker.mjs`: `ExecutorLockedError after 1782 ms`. Cửa sổ crash rất hẹp và lần retry sau 5s sẽ thành công, nên chỉ là Low. Fix: cho tổng thời gian chờ ≥ `TAKEOVER_STALE_MS`, hoặc ném lỗi riêng ("takeover in progress") để phân biệt với việc có holder thật.

**L2. Race lý thuyết khi marker hết hạn: holder bị dừng > 5s giữa probe lần hai và `rm`**
`local-executor.mjs:204`, `:208`, `:210`.
A giữ marker và probe ra `dead`, rồi bị dừng > 5s (CPU throttling, GC, I/O treo). B xóa marker vì stale, tự take over, sau đó C bind socket mới. A chạy tiếp và `rm(path)` xóa socket đang sống của C. `rm(marker)` ở `:210` cũng xóa marker của người khác. Cuối cùng A bind và có hai holder. Cần một lần dừng > 5s nằm đúng giữa hai syscall cục bộ, nên rủi ro thấp. Ghi nhận để biết giới hạn của marker theo thời gian. Fix rẻ: probe lại ngay trước `rm` không giải quyết triệt để. Có thể ghi id ngẫu nhiên vào marker và chỉ `rm` marker khi id khớp, để giảm hậu quả.

**L3. Fallback `unsaved` chạy ngoài `serialized`: final state có thể ghi hai lần và `onFinal` có thể gọi hai lần**
`local-executor.mjs:311-319`.
Lần ghi thứ 3 thất bại. Fallback gọi `loadRecord` (file vẫn `running`) mà không giữ chain của job. Nếu một `cancel()` xếp hàng trong `serialized` ghi được `canceled` (disk vừa phục hồi) trước khi fallback `unsaved.set`, thì memory phục vụ `succeeded` trong khi file ghi `canceled`, và `onFinal` chạy hai lần. Điều này vi phạm bất biến "A job reaches a final state once" (`:21-22`). Chỉ xảy ra khi disk chập chờn. Fix: bọc fallback trong `serialized(jobId, …)`. Phụ: entry trong `unsaved` không bao giờ bị xóa (pruner `rm` file nhưng memory vẫn còn), và chưa có test cho nhánh này.

**L4. Shutdown khi disk lỗi: abort CLI bị trễ 0.75s × số job, không bị giới hạn bởi `closeTimeoutMs`**
`local-executor.mjs:486-489`.
`finishWithRetry` chạy tuần tự cho từng job (sleep 250 + 500ms) **trước** khi abort. Với cap 64 và disk lỗi, khoảng 48s trôi qua trước khi gửi SIGTERM cho CLI, vượt `terminationGracePeriodSeconds` mặc định 30s. Fix: abort trước (hoặc song song), hoặc chạy `Promise.all` cho các lần ghi interrupted.

## L4 (round-1) cancel trước khi có record: đánh giá lại

Cửa sổ trong module này kéo dài từ lúc `start()` vào cho tới khi `createExclusive` link xong (`:371-397`), vài ms gồm cả fsync. Cancel trong cửa sổ này trả `null` (`:462`), sau đó job vẫn chạy bình thường. Hành vi này giống DO backend (`job-controller.ts` `cancel` trả `undefined` trước khi `save(starting)`), nên contract `JobBackend.cancel` không bị vi phạm.
- Workflow: `WorkflowManager.cancel` lưu run `canceled` rồi gọi `runner.cancel(jobId)` (`workflow-manager.ts:397-406`), lỗi bị nuốt. Sau đó `startStep` không lưu được run và gọi `runner.cancel(lease.jobId)` sau khi start resolve (`:597`). Lúc này record đã tồn tại, nên job bị cancel và abort. Hậu quả còn lại: CLI có thể đã bắt đầu gọi provider trước lần cancel backstop, nên có thể phát sinh một phần chi phí.
- Caller trực tiếp (MCP job tools) chỉ biết `jobId` sau khi `start` resolve, nên không chạm tới cửa sổ này.
- Kết luận: Low, giữ non-fix được với lý do "giống DO backend, workflow có backstop tại `workflow-manager.ts:597`". Cách sửa rẻ nếu muốn: trong `cancel`, khi `!record && running.has(jobId)` thì `running.get(jobId).abort.abort()`. `job-runner.mjs:130` sẽ trả `canceled` trước khi tải input hoặc gọi CLI, và `finishWithRetry` ghi `canceled`.

## Các điểm đã kiểm tra, không thấy lỗi

- **Contender cùng host:** marker exclusive + probe lần hai đảm bảo không xóa socket vừa được bind. Sau khi xóa, chỉ một `listen` thắng, các contender còn lại probe ra `live`. Test 4 process × 5 vòng ổn định, kể cả khi CPU bị tải.
- **FS không hỗ trợ socket hoặc lỗi khác:** `listen` ném lỗi gốc (không phải EADDRINUSE) ngay ở `:191`. `probeSocket` ném mọi lỗi khác ECONNREFUSED/ENOENT. Không có đường nào treo, vì connect Unix socket hoàn tất ngay. Path là file thường hoặc thư mục: probe ra ECONNREFUSED; `rm` thư mục ném lỗi, marker được dọn trong `finally`.
- **Process còn sống nhưng không gọi `close()`:** handle server vẫn nằm trong loop libuv (không bị GC), nên lock được giữ tới khi process thoát. Đây là đúng ngữ nghĩa. Thoát mà không close thì file socket còn lại, nhưng lần sau probe ra dead và thay thế được (trừ H1). Nếu người khác xóa file socket trong khi process còn sống, lần start sau sẽ bind được và có hai holder. Không có cơ chế phát hiện, chấp nhận được (lỗi vận hành).
- **`server.unref()`:** không giữ process sống, nên CLI hoặc test quên `close()` vẫn thoát được. Connection được accept rồi destroy ngay. Thử EMFILE với `ulimit -n 64`: không có `uncaughtException` (libuv xử lý bằng emfile trick).
- **Error path sau khi lấy lock:** `sweep` ném lỗi thì `lock.server.close` được gọi (`:352-354`). Ngoài `sweep` không còn `await` nào có thể ném trước khi trả executor. `listenOn` thất bại không để lại handle đang listen.
- **`close()`:** cùng một promise; `closed` được đặt đồng bộ; chờ `inflight` trước khi chụp `running`; `server.close(r)` resolve kể cả khi có lỗi.

## Recommended actions
1. H1: kiểm tra độ dài socket path (≤ 107 byte) với lỗi rõ ràng, kèm test cho `stateDir` dài, cả trường hợp restart sau crash.
2. M1: sửa header và doc vận hành theo hướng "cùng host / một replica"; hoặc bổ sung owner hostname nếu cần phát hiện cross-node.
3. L3: chạy fallback `unsaved` trong `serialized` và thêm test cho trường hợp `finishWithRetry` hết lượt.
4. L1, L4, L2: tùy chọn.

## Metrics
- Tests: 16/16 pass (ổn định 8/8 lần chạy). Biome: 0 issue. Coverage: không đo. Nhánh `unsaved` và nhánh marker stale chưa có test.

Status: DONE_WITH_CONCERNS
Summary: Mọi finding vòng 2 đã được sửa hoặc trở nên obsolete, T1 được xác nhận bằng mutation, không có regression vòng 1. Có 1 High tái hiện được: libuv cắt âm thầm socket path > 107 byte, khiến socket nằm ngoài stateDir và server bị khóa vĩnh viễn sau crash. Có 1 Medium: header hứa phát hiện replica trên shared volume, nhưng điều này sai với cross-node.
Concerns/Blockers: M1 không repro được trong sandbox một host; kết luận dựa trên ngữ nghĩa Unix socket của Linux.
