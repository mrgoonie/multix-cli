# Code review: local child-process job executor (issue #550)

Branch `claude/relaxed-clarke-yce0xf`, commit `bb66435` on `origin/dev`.
Files: `worker/container/local-executor.mjs` (360 LOC, new), `worker/test/local-executor.test.ts` (302 LOC, new).
Checks: `npx vitest run test/local-executor.test.ts` 12/12 pass; `biome check` clean.
Repro script (scratch, not committed) ran each race listed below against the real module.

## Tổng quan

Thiết kế cap đồng bộ (sync check-and-take) đúng: không có `await` trước `running.set`, nên hai `start` đồng thời trong cùng process không thể cùng qua cap. State file không chứa spec/keys. Recovery không bao giờ chạy lại job. Điểm yếu tập trung ở **lock file** (bảo đảm "một process trên một state dir" bị phá bằng race tái hiện được), **lifecycle close/start**, và **`onFinal` async**. Module chưa được wire vào đâu (grep `createLocalExecutor` chỉ thấy test), nên các lỗi chưa ảnh hưởng production, nhưng phải sửa trước khi có caller.

## Critical / High

### H1. Lock acquisition race: lock file rỗng bị coi là abandoned, hai process cùng giữ lock
`local-executor.mjs:115`, `:123-133`.
`writeFile(file, mine, { flag: "wx" })` tạo file trước rồi mới ghi nội dung. Process Y gặp `EEXIST` trong khoảng đó đọc chuỗi rỗng, `JSON.parse` throw, nên `holder = undefined` và `abandoned = true` (`:132`). Y chạy `rm` lock của X (`:138`) rồi tự `wx` thành công. X vẫn ghi xong vào inode đã unlink và tin rằng mình giữ lock.
- Bằng chứng: lock file rỗng có sẵn dẫn tới `createLocalExecutor` take over ngay. Chạy 3 process cùng lúc trên một dir trống, 40 lần: **1/40 lần có >1 holder**.
- Hậu quả: hai replica (rolling update, hoặc 2 pod khởi động cùng lúc trên RWX volume) mỗi bên có cap riêng, nên cap thực tế gấp đôi. Mỗi bên `recover()` có thể đánh dấu job đang chạy của bên kia là `interrupted`. Đây chính là bảo đảm mà header (`:26-28`) và issue yêu cầu.
- Cùng loại TOCTOU: hai process cùng thấy một stale lock. X `rm` rồi `wx` xong, sau đó Y (đã đọc trước đó) `rm` lock mới của X rồi `wx`, và cả hai cùng giữ.
- Fix: ghi lock nguyên tử bằng tmp file đầy đủ nội dung rồi `link(tmp, lock)` (EEXIST nguyên tử, không bao giờ thấy file rỗng). Parse lỗi hoặc ENOENT thì retry/đợi, chỉ coi là abandoned khi mtime stale. Trước khi `rm` stale lock, đọc lại và so `id` với holder đã đánh giá. Sau khi acquire, đọc lại để xác nhận `id` là của mình. Nếu không đạt atomic hoàn toàn trên shared FS thì sửa câu chữ trong header cho đúng mức bảo đảm thật.

### H2. Same-host + same-pid luôn bị coi là abandoned: container khác (pid 1) cướp lock đang sống
`local-executor.mjs:129-135`.
`holder.pid === process.pid` với cùng `hostname()` được take over ngay, không xét heartbeat. Hai container khác pid namespace nhưng cùng hostname đều là pid 1 và có thể bị nhầm là nhau. Ví dụ: Docker `--network host` (container kế thừa hostname của host), compose với `hostname:` cố định và `scale: 2`, hoặc Kubernetes pod `hostNetwork: true`.
- Bằng chứng: lock `{pid: process.pid, host: hostname()}` với mtime fresh vẫn bị take over.
- Cùng nguyên nhân, `pidAlive(holder.pid)` ở `:135` kiểm tra pid trong namespace của chính mình, không phải của holder. Container B thấy pid 7 của A "dead" và take over.
- Fix: thêm vào lock một instance id ổn định cho mỗi lần boot (ví dụ inode của `/proc/self/ns/pid` cộng starttime trong `/proc/self/stat`). Chỉ take over khi chắc chắn là cùng namespace và holder đã chết, còn lại phải chờ mtime stale (`LOCK_STALE_MS`). Field `id` hiện được ghi (`:112`) nhưng không bao giờ dùng.

## Medium

### M1. Không bao giờ phát hiện mất lock; `close()` xóa lock của người khác
`local-executor.mjs:167-170`, `:356`.
Heartbeat `utimes` nuốt mọi lỗi và không kiểm tra nội dung lock còn là `mine`. Kịch bản: A bị stall hơn 60s (CPU throttle, SIGSTOP, NFS hang). Replica B trên host khác take over đúng luật. A tiếp tục chạy job, heartbeat làm "tươi" lock của B, và khi `close()` thì `rm(lockFile)` **xóa lock của B**, mở đường cho process thứ ba.
Fix: heartbeat đọc lock, nếu `id` khác thì coi là mất lock (từ chối `start` mới, log). `close()` chỉ `rm` khi `id` khớp.

### M2. `start` đang chạy dở có thể bypass `close()`: `runJob` được gọi sau khi shutdown xong và lock đã nhả
`local-executor.mjs:260`, `:271-296`, `:349-357`.
`closed` chỉ được kiểm tra ở đầu `start`. Sau đó có `await loadRecord` và `await writeAtomic`, rồi mới gán `slot.done`. `close()` snapshot `running` lúc `slot.done === undefined`. `finish` trả `undefined` vì record chưa tồn tại. `Promise.all` không chờ gì. Lock bị xóa. Sau đó `start` vẫn ghi record `running` và gọi `run(spec)`.
- Bằng chứng: `p = ex.start(...)`, `await ex.close()`, lúc đó lock đã mất. Sau đó `runJob` vẫn được gọi 1 lần (với signal đã aborted), `start` trả `running`, và record cuối được ghi **sau** khi close resolve.
- Với `runJob` thật: signal đã abort nên khả năng có provider call là thấp (execFile vẫn spawn rồi kill ở nextTick). Nhưng vẫn có tiến trình con và ghi file sau shutdown, ghi vào state dir mà process khác có thể đã lấy lock. Ngoài ra trạng thái cuối là `canceled`, không phải `interrupted`.
- Fix: kiểm tra lại `closed` (hoặc `slot.abort.signal.aborted`) sau các `await`, ngay trước khi ghi `running` và trước `run(...)`. Nếu đã closed thì giải phóng slot và trả view interrupted. Hoặc `close()` chờ cả các `start` đang pending (giữ một set promise).

### M3. `onFinal` async reject gây `unhandledRejection` (Node mặc định crash process)
`local-executor.mjs:209-213`, `:288-290`.
`try { options.onFinal?.(...) } catch {}` chỉ bắt lỗi sync. JSDoc nói `onFinal` dùng cho "slot accounting", tức release quota/event, việc vốn async (xem `releaseSlot` trong `job-controller.ts`). Nếu caller truyền hàm async và hàm đó reject thì có unhandled rejection. Node ≥15 sẽ terminate process, và mọi job đang chạy thành `interrupted`.
- Bằng chứng: `onFinal: async () => { throw ... }` kích hoạt event `unhandledRejection` với "quota release failed".
- Fix: `Promise.resolve().then(() => options.onFinal?.(...)).catch(() => {})`, dùng chung một helper cho cả hai chỗ (hiện đang lặp code).

### M4. Ghi final thất bại thì job kẹt `running` vĩnh viễn và `onFinal` không bao giờ được gọi
`local-executor.mjs:305-310`, `:97-107`.
Nếu `writeAtomic` trong `finish` lỗi (ENOSPC, EIO), chuỗi `.catch(() => undefined).finally(() => running.delete(jobId))` nuốt lỗi và nhả slot. Record vẫn là `running` cho tới khi restart, nên `status()` trả `running` mãi. JobRunner poll tới hết hạn rồi trả non-terminal. `onFinal` không chạy nên quota slot phía caller không được trả (chỉ hết theo lease). `writeAtomic` cũng không xóa `.tmp` khi ghi lỗi.
Fix: retry có giới hạn, hoặc giữ final view trong memory (map `finalViews`) để `status()` trả về và gọi `onFinal` dù persist lỗi. `writeAtomic` cần `rm(tmp)` trong nhánh lỗi. Ít nhất phải log một event (không chứa secret).

### M5. Retention chỉ chạy lúc khởi động
`local-executor.mjs:218-244`.
Server chạy lâu sẽ tích lũy một file cho mỗi job, kể cả các lần bị từ chối vì capacity (`:287`), không có giới hạn. DO có `expireJob` được lên lịch cho từng job. Fix: sweep định kỳ (interval `unref`) dùng lại nhánh retention của `recover()`.

## Low

- **L1. Từ chối capacity sai và vĩnh viễn** (`:269-276`): `start` của một job đã kết thúc vẫn tạm chiếm slot trong lúc `await loadRecord`. Với cap 1, nếu `start(ID_done)` và `start(ID2)` đến cùng lúc thì ID2 bị ghi `failed / server at capacity` vĩnh viễn, dù server đang rảnh. Fix: kiểm tra `existing` trước (đường đó không cần slot), sau đó mới check-and-take đồng bộ một lần nữa.
- **L2. Same-host pid bị tái sử dụng làm khóa boot vĩnh viễn** (`:135`): trên VM/bare-metal, process crash rồi pid cũ được cấp cho process khác, nên `pidAlive` trả true và mỗi lần khởi động đều `ExecutorLockedError` (systemd crash loop) dù lock đã 1 giờ không được touch. Repro: lock `{pid: ppid, host}` với mtime 1h trước vẫn bị REFUSED. Fix: với same-host cũng coi mtime stale là abandoned.
- **L3. Clock skew giữa các host** (`:136`, `:168-169`): mtime do holder đặt bằng đồng hồ của nó (`utimes`), còn reader so với đồng hồ của mình. Lệch hơn 60s thì lock sống bị coi là stale. Nên ghi chú yêu cầu NTP, hoặc so sánh mtime thay đổi qua hai lần đọc cách nhau.
- **L4. `cancel` trong cửa sổ trước khi record `running` được ghi** (`:271-294`): `cancel` trả `null` (not found) trong khi job sắp chạy. JobRunner gọi `store.create` rồi mới `backend.start`, nên một caller có jobId trước (workflow steps) có thể gặp lỗi này. DO ghi `starting` trước. Fix: ghi record trước khi thả cho cancel nhìn thấy, hoặc `cancel` kiểm tra `running.has(jobId)` rồi abort và ghi canceled.
- **L5. `close()` không có giới hạn thời gian** (`:354`): CLI hoặc grandchild (ffmpeg) bỏ qua SIGTERM thì close treo tới khi bị SIGKILL. Record đã được ghi `interrupted` trước nên không mất dữ liệu, chỉ nên có timeout.
- **L6. Không fsync thư mục sau `rename`** (`:106`): khi mất điện, record `running` có thể biến mất trong khi provider đã bị gọi. Container restart thường thì không ảnh hưởng.
- **L7. Presigned R2 URL (7 ngày) lưu plaintext trong state file** (`view.result.outputs`): tương đương DO storage và file có mode 0600. Nhưng `mkdir(..., 0o700)` không sửa quyền của thư mục đã tồn tại. Nên ghi chú cho operator.

## Test gaps (các test sẽ vẫn pass khi code hỏng)

1. Không có test cho concurrent lock acquisition (H1) hoặc lock rỗng. Không có test cho nhánh `holder.pid === process.pid` (`:135`): trong test "same process cannot open it twice" thì `heldInProcess` chặn trước, nên xóa hẳn điều kiện pid đó thì test vẫn pass.
2. Không có test cho `start` đua với `close` (M2), `onFinal` async/throw (M3), hoặc `writeAtomic` lỗi (M4).
3. `onFinal` chỉ được assert cho job succeeded và recovery. Không test rằng nó được gọi đúng một lần khi cancel, close hay capacity refusal.
4. `afterEach` dùng `Promise.race([executor.close(), tick()])`, nên close treo vẫn được bỏ qua lặng lẽ, kèm theo interval và entry trong `heldInProcess` bị rò.
5. "records a crashed runner ... without leaking the key": thông báo lỗi luôn bị thay bằng hằng số (`:303`), nên assertion về KEY không chứng minh việc redact.

## Edge cases từ scout
- Module chưa có caller nào (chưa có server tự host nào dùng). Việc tích hợp `onFinal` với quota release và `ownerOf` với kiểm tra quyền sở hữu nằm ở PR sau. `start` trả view của record có sẵn mà không so `userId` (`:273-276`), nên caller phải luôn kiểm tra `ownerOf` hoặc `JobStore.ownedBy` trước.
- Path traversal: `JOB_ID_RE` chặt ở mọi entry point, và `validateSpec` cũng kiểm tra. Không có vấn đề.
- Secrets: record chỉ chứa `{owner, view}`. stdout/stderr đã được `runJob` redact (chỉ các key có độ dài ≥8, giống hành vi hiện có).

## Recommended actions
1. Sửa H1 và H2: lock ghi nguyên tử bằng `link`, parse lỗi không được coi là abandoned, instance id thay cho phép so pid/hostname, xác minh `id` trước khi `rm` và sau khi acquire.
2. M1: heartbeat xác minh quyền sở hữu, `close()` chỉ xóa lock của chính mình.
3. M2: kiểm tra lại `closed` sau các `await` trong `start`.
4. M3: bọc `onFinal` bằng promise rồi `.catch`.
5. M4 và M5: final view trong memory hoặc retry, dọn tmp, sweep retention định kỳ.
6. Thêm test cho từng mục trên.

## Metrics
- Tests: 12/12 pass. Lint (biome): 0 issue. Coverage: không đo.
