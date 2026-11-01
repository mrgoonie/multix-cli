# Code review vòng 2: local child-process job executor

Branch `claude/relaxed-clarke-yce0xf`, `git diff origin/dev...HEAD` (commit `bb66435` + `aebecfe`).
Files: `worker/container/local-executor.mjs` (507 LOC), `worker/test/local-executor.test.ts` (410 LOC), `worker/test/fixtures/lock-contender.mjs`.
Checks: `npx vitest run test/local-executor.test.ts` 18/18 pass (cũng pass 3/3 lần test contender khi CPU bị tải 2x nproc); `biome check` sạch. Module vẫn chưa có caller (grep `createLocalExecutor` chỉ thấy test).
Repro scripts (scratch, không commit): `/tmp/claude-0/r2/{spin,hb,hb2,c2,age,phantom}.mjs`.

## Tổng quan

Phần lớn finding vòng 1 đã được sửa đúng hướng: lock tạo bằng `link` từ tmp đầy đủ nội dung, bỏ hẳn phép so pid/hostname, heartbeat có kiểm tra `id`, `close()` có chờ `inflight` và kiểm tra lại sau khi ghi record, bọc `onFinal`, có pruner và close timeout. Tuy vậy, chính phần lock mới viết lại có ba lỗi tái hiện được. Lỗi nặng nhất là lock vừa được take over đã **stale ngay khi sinh ra**, nên đảo ngược bảo đảm "một holder" trong đúng kịch bản crash recovery mà lock sinh ra để xử lý.

## Đối chiếu finding vòng 1

| ID | Trạng thái | Ghi chú |
|---|---|---|
| H1 lock rỗng / TOCTOU | **Đã sửa phần lớn, còn sót** | `link(tmp, file)` (`:181`), đọc lỗi không còn bị coi là abandoned (`:194`, chỉ dựa vào mtime). Còn cửa sổ give-back (N3) và lock sinh ra đã stale (N1). |
| H2 cùng pid/host | **Đã sửa** | Không còn dùng pid/host, chỉ dựa vào mtime. Test `:243` khóa hành vi này. |
| M1 mất lock / close xóa lock người khác | **Đã sửa, nhưng có regression** | Heartbeat so `id` (`:264`), close so `id` (`:503`). Regression: mọi lỗi đọc tạm thời đều thành mất lock vĩnh viễn (N2). |
| M2 start đua close | **Đã sửa, test là phantom** | `inflight` + kiểm tra lại ở `:407`. Test không cover `:407` (xem T1). |
| M3 onFinal async | **Đã sửa** | `notifyFinal` `:277-282`, có test. |
| M4 final write lỗi | **Sửa một phần** | Đã có `finishWithRetry` (3 lần) và dọn tmp (`:126-128`, `:139`). Vẫn không giữ final view trong memory và không log. Hết 3 lần thì `status()` trả `running` cho tới khi restart, `onFinal` không chạy, slot đã nhả (`:429`). Chấp nhận được nếu ghi rõ, nhưng chưa có test. |
| M5 retention | **Đã sửa** | Pruner mỗi giờ, `unref` (`:365-368`), được clear trong close. |
| L1 capacity giả | **Đã sửa** | `existing` được kiểm tra trước khi lấy slot (`:380-381`). Có test `:344`. |
| L2 pid bị tái sử dụng | **Đã sửa** | Bỏ `pidAlive`. |
| L3 clock skew | Không sửa (chủ ý) | Lý do đứng vững với single-replica RWO PVC. Nên ghi vào doc vận hành khi wire vào. |
| L4 cancel trước khi có record | Không sửa (chủ ý). **Lý do sai về sự kiện, nhưng hậu quả hiện được che** | Xem N6. |
| L5 close không giới hạn | **Đã sửa** | `closeTimeoutMs` (`:494-501`). |
| L6 fsync thư mục | **Chỉ sửa cho lock** | `syncDir` chỉ chạy sau khi lấy lock (`:183`). `writeAtomic` và `createExclusive` cho job record không fsync thư mục, nên record `running` vẫn có thể mất khi mất điện. Low, như vòng 1. |
| L7 presigned URL | Không sửa (chủ ý) | Lý do đứng vững: đây là dữ liệu của chính owner, giống DO storage. Đã có `chmod 0700` (`:247`, lỗi được nuốt nếu mount root không thuộc quyền mình, chấp nhận được). |

Test gaps vòng 1: (1) đã có test contender nhiều process và test lock rỗng, nhưng nhánh stale-takeover/give-back vẫn không có test; (2) đã có test close race và onFinal async, nhưng chưa có test cho việc ghi final lỗi; (3) **vẫn chưa** assert `onFinal` được gọi đúng một lần khi cancel, close hay capacity refusal; (4) đã sửa (`afterEach` await `close()` thẳng); (5) đã sửa (test đổi tên thành "fixed message").

## Finding mới

### High

**N1. Lock vừa take over đã stale ngay lúc sinh ra, nên contender thứ hai lấy luôn: hai holder trong tối đa một chu kỳ heartbeat**
`local-executor.mjs:176`, `:181`, `:194`.
Tmp lock được ghi **một lần** trước vòng chờ (`:176`). `link` dùng chung inode, nên `executor.lock` mới mang mtime của lúc tmp được ghi, không phải lúc lấy được lock. Khi chờ một lock của process đã crash, thời gian chờ khoảng `LOCK_STALE_MS` + `pollMs`. Vì thế lock mới có tuổi lớn hơn 60s ngay từ đầu, và heartbeat đầu tiên chỉ chạy sau 15s.
- Repro (`age.mjs`, giá trị mặc định): `acquired after 60129 ms; new lock age 60130 ms ... already stale: true`.
- Kịch bản: holder crash, hai process (pod restart cùng một pod cũ đang terminating, hoặc 2 replica) cùng chờ. A take over ở t≈60s và chạy `sweep({recover:true})`, rồi nhận job. Ở lần poll tiếp theo, B thấy lock của A stale. `readLockId` ra id của A, trùng với tomb, nên B xóa lock của A và tự link (lock của B cũng stale ngay khi sinh ra). A chỉ phát hiện mất lock ở heartbeat kế tiếp (≤15s). Trong khoảng đó cap thực tế gấp đôi, và recover sweep của B đánh dấu `interrupted` các job A vừa start trong khi CLI của A vẫn đang gọi provider. Đây đúng là điều header (`:26-32`) hứa sẽ không xảy ra.
- Fix: ghi tmp mới (hoặc `utimes(tmp, now, now)`) ngay trước mỗi lần `link`, hoặc `utimes(file)` ngay sau khi `link` thành công. Thêm test: lock cũ có mtime gần stale, `lockWaitMs` dài, sau khi acquire thì assert tuổi của `stat(lock).mtimeMs` < `LOCK_HEARTBEAT_MS`.

### Medium

**N2. Heartbeat coi mọi lỗi đọc tạm thời là mất lock, vĩnh viễn: server single-replica từ chối mọi job tới khi restart**
`local-executor.mjs:158-164`, `:263-269`.
`readLockId` nuốt mọi lỗi và trả `undefined`, nên `undefined !== lock.id` dẫn tới `lockLost = true` và `clearInterval`. Không có đường quay lại. Các nguyên nhân thực tế: EMFILE, EIO/ESTALE trên NFS/CSI, và cửa sổ give-back của chính module (`:198` → `:204`, lock tạm thời vắng mặt). Hậu quả: mọi `start` trả `SERVER_AT_CAPACITY_ERROR` (gây hiểu nhầm, `:382`), `accepting()` false. Heartbeat ngừng touch, nhưng lock vẫn mang id của mình nên process restart cùng chỗ phải chờ 60s.
- Repro (`hb.mjs` case 1): đổi tên lock đi rồi trả lại sau 30ms (heartbeat 20ms). Lock vẫn đúng id của mình nhưng `accepting(): false`.
- Fix: chỉ đánh dấu mất lock khi đọc **thành công** và id khác. ENOENT hoặc lỗi I/O thì thử lại ở tick sau (hoặc cần N lần liên tiếp). Nếu đã xác định mất lock, nên log hoặc expose rõ để health probe restart process, thay vì âm thầm trả "at capacity".

**N3. Give-back thất bại khi contender thứ ba link vào trong cửa sổ, nên holder hợp lệ mất lock mà không biết (tối đa 15s)**
`local-executor.mjs:195-207`.
Y đọc `staleId` của lock cũ S. X thay S bằng lock mới. Y `rename` lock của X sang tomb, thấy id khác và `link(tomb, file)` để trả lại. Nếu giữa `rename` và `link` có Z thấy ENOENT (`:192`) và `link` vào, thì give-back gặp EEXIST và bị `.catch(() => {})` nuốt. Y `rm` tomb (xóa lock của X), nên X và Z cùng tin mình giữ lock tới heartbeat kế tiếp của X. Recover sweep của Z đánh dấu job của X là interrupted.
- Repro (`hb2.mjs` + `c2.mjs`, process riêng): `c2 acquired, accepting=true` / `give-back link: EEXIST` / `c1.accepting ...: true`.
- Cần 3 contender cùng lúc với lock stale, nên hiếm. Nhưng nó cộng dồn với N1 (N1 tạo ra lock stale một cách hệ thống). Fix khả thi: khi give-back thất bại thì không `rm` tomb (để lại bằng chứng) và ném lỗi. Tốt hơn là sau khi acquire, chờ ≥1 poll rồi đọc lại xác nhận id trước khi chạy recover sweep, đồng thời giảm độ trễ phát hiện bằng cách kiểm tra id ngay trước `createExclusive` trong `startJob`. Nếu không làm được atomic thì header phải ghi đúng mức bảo đảm.

**N4. `acquireLock` quay vòng không giới hạn, bỏ qua `lockWaitMs`, khi `stat` hoặc `rename` lỗi bền vững**
`local-executor.mjs:189-193`, `:197-201`.
Hai nhánh `continue` bỏ qua cả `sleep(pollMs)` lẫn kiểm tra `giveUpAt`. Ví dụ `executor.lock` là một symlink treo: `link` trả EEXIST, `stat` (đi theo symlink) trả ENOENT, nên `continue` lặp mãi. Tương tự, `rename` trả EPERM/EBUSY bền vững (thư mục sticky với lock thuộc uid khác, file immutable) cũng gây vòng lặp vô hạn.
- Repro (`spin.mjs`, `lockWaitMs: 100`): `STILL WAITING after 1999 ms ... cpu user ms 928`. Start-up treo với khoảng 50% CPU và không bao giờ ném `ExecutorLockedError`.
- Fix: dùng `lstat`, chỉ `continue` ngay với ENOENT, còn các lỗi khác thì ném. Kiểm tra `giveUpAt` và `sleep(pollMs)` ở mọi nhánh lặp.

### Low

**N5. Gọi `close()` lần hai trong khi lần đầu chưa xong sẽ resolve ngay** (`:484`). Một SIGTERM handler gọi lại (hoặc hai đường shutdown) sẽ tin rằng lock đã được nhả và job đã được ghi, rồi `process.exit` sớm. Lock lúc đó còn nằm đó, nên lần boot sau chờ 60s. Fix: lưu promise của lần close đầu và trả lại nó.

**N6. Lý do không sửa L4 sai về sự kiện.** `JobRunner.run` nhận `jobId` từ caller ("lets a caller record the id before the job starts", `worker/src/jobs/job-runner.ts:133-137`). `WorkflowManager.startStep` ghi `lease.jobId` trước khi gọi `runner.run` (`worker/src/skills/workflow-manager.ts:520-573`), và `WorkflowManager.cancel` hủy theo `run.lease?.jobId` (`:397-406`). Vì vậy có thể có cancel trong cửa sổ `store.create` → `createExclusive`: `cancel` trả `null`, rồi `JobNotFoundError` bị `.catch` nuốt. Hậu quả hiện được che: `startStep` không lưu được run đã bị cancel và gọi `runner.cancel(lease.jobId)` sau khi start resolve (`:597`). Kết luận: giữ non-fix được, nhưng phải đổi lý do thành "workflow có backstop ở `workflow-manager.ts:597`", và không được dựa vào giả định "id chỉ được trả về sau start". Cách sửa rẻ: trong `cancel`, nếu `running.has(jobId)` mà chưa có record thì abort slot.

**N7. Tmp lock và tomb `.stale` không bao giờ được dọn** (`:176`, `:196`; `sweep` cố ý bỏ qua chúng, `:339-342`). Process bị SIGKILL trong lúc chờ lock (tới 75s, ví dụ startup probe của k8s kill) để lại `executor.lock.<pid>.<uuid>.tmp`. Crash loop sẽ tích lũy các file này không giới hạn. Nên dọn các file lock tmp/tomb có mtime cũ hơn `LOCK_STALE_MS` trong recover sweep (chạy khi đã giữ lock).

**N8. Khi `finishWithRetry` hết lượt trong nhánh closed của `startJob`, caller nhận `running`** (`:410-413`, `?? view`) cho một job sẽ không bao giờ chạy. Nên trả view `failed/interrupted` dựng trong memory.

## Test gaps mới

- **T1 (phantom).** "does not start a job whose start raced with close()" (`test:308-318`) gọi `close()` đồng bộ ngay sau `start()`, nên `closed` đã là true trước khi `loadRecord` resolve và test đi vào nhánh `:382`. Xóa hẳn kiểm tra lại ở `:407-414` thì test **vẫn pass**. Đã kiểm chứng bằng bản copy bị mutate (`phantom.mjs`): kịch bản của test cho `failed calls 0` ở cả hai bản. Kịch bản "close sau 2 lần `setImmediate`" cho bản mutate `running calls 1` và bản gốc `failed calls 0`. Cần sửa test để `close()` chạy trong lúc `createExclusive` đang chờ.
- **T2.** Không có test cho N1, N2, N4, nhánh give-back, hoặc `finishWithRetry` hết lượt (M4).
- **T3.** `onFinal` cho cancel/close/capacity vẫn chưa được assert (gap 3 của vòng 1).

## Đã kiểm tra, không thấy lỗi

- Cap đồng bộ: không có `await` giữa `running.has` / `running.size` và `running.set` (`:384-395`). `createExclusive` chặn được hai start cùng job id ghi đè nhau.
- Error path của `startJob`: `createExclusive` ném lỗi thì `running.delete` được gọi (`:403-406`). `inflight` luôn được xóa (`:450-452`). Sweep lỗi lúc boot thì dọn heartbeat, `heldInProcess` và lock (`:359-363`).
- `close()`: chờ `inflight` trước khi chụp `running`, các slot luôn có `done` lúc chụp, timer được clear, `fileLocks` được chờ, chỉ xóa lock nếu id khớp.
- Sweep/prune: `JOB_TEMP_RE` không khớp với lock tmp hoặc tomb. Prune chỉ xóa record terminal quá hạn, nên không đụng record đang chạy.
- Heartbeat đang chạy dở khi `close()`: `utimes` lên file đã bị xóa hoặc thuộc người khác chỉ làm lock tươi hơn, vô hại.

## Recommended actions
1. N1: làm tươi mtime của lock lúc link (một dòng), kèm test.
2. N2: chỉ coi là mất lock khi đọc thành công và id khác, và expose/log trạng thái này.
3. N4: `lstat`, ném lỗi khi không phải ENOENT, áp `giveUpAt`/`sleep` cho mọi nhánh.
4. N3: xác nhận lại id sau khi acquire (trước recover sweep), không `rm` tomb khi give-back thất bại.
5. Sửa test T1 cho đúng race, và thêm test cho N1, N2, N4, M4, onFinal cancel/close/capacity.
6. N5, N7, N8 và lý do của L4 (N6).

## Metrics
- Tests: 18/18 pass. Biome: 0 issue. Coverage: không đo.

Status: DONE_WITH_CONCERNS
Summary: Phần lớn finding vòng 1 đã được sửa (H2, M1, M3, M5, L1, L2, L5; H1 và M2 cơ bản đúng). Phần lock viết lại có 1 High tái hiện được (lock vừa take over đã stale, nên contender thứ hai cướp được) và 3 Medium (heartbeat coi lỗi đọc tạm thời là mất lock vĩnh viễn, give-back race, vòng quay vô hạn khi stat/rename lỗi). Test cho race close là phantom.
Concerns/Blockers: Lý do không sửa L4 sai về sự kiện (workflow biết jobId trước khi start resolve), dù hậu quả hiện được che bởi workflow-manager.ts:597.
