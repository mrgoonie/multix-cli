# Code review: commit 868bac7 (fix-494-local), issue #494

Phạm vi: 12 file, +289/-96. Worktree `/workspace/multix-cli/.claude/worktrees/agent-a914276477905f313`.

## Kiểm chứng đã chạy
- `npx vitest run tests/unit/providers/poll-job-errors.test.ts`: 8/8 pass.
- `npm run lint` (biome): sạch, 701 file. `npm run typecheck`: sạch.
- Probe tạm (đã xóa, `git status` sạch): cho `toTaskWaitError`/`toPollJobError` chạy qua `classifyError` với payload thực tế.

## Luồng phân loại (đã trace)
`src/cli.ts:30` → `exitWithError` (`src/agent/agent-runtime.ts:469`) → `finalizeRun({exitCode:1, error})` → `classifyError(error)`.
- Status failed: `ProviderJobFailedError` có terminal=true → JOB_FAILED, exit 5 với --json, 1 ở chế độ thường. Đúng.
- Hết giờ chờ: core `PollTimeoutError` (code POLL_TIMEOUT) → TIMEOUT, exit 6 với --json. Đúng.
- Lỗi khác (HttpError, download): trả lại nguyên vẹn. Đúng.
- Output cho người dùng: thay `✗ Task failed: …` bằng `Error: <message>` + các dòng `code:`/`hint:` (`agent-runtime.ts:392-403`). Không có `process.exit` trong catch nữa. Exit code ở chế độ thường vẫn là 1. Không thấy regression.

## Critical
Không có.

## High
1. **Task bị huỷ (non-terminal) vẫn được phân loại theo text của payload. Đây đúng là lỗi #494 cần sửa.**
   `src/providers/leonardo/poll.ts:76-81`: với BytePlus `cancelled`, message là `Task <id> failed: <full JSON>`. `classifyError` gọi `classifyMessage(message)` cho nhánh non-terminal (`error-classify.ts:283-285`), nên code phụ thuộc vào chữ trong JSON. Kết quả probe:
   - `{"status":"cancelled"}` → UNKNOWN (1). OK.
   - `{"status":"cancelled","error":{"message":"…cancelled by … timeout"}}` → **TIMEOUT (exit 6)**, kèm hint "job may still be running … do not resubmit". Sai: task đã huỷ thì không bao giờ xong.
   - `{"status":"cancelled","error":{"message":"invalid parameter required"}}` → **INVALID_INPUT (exit 2)**.
   Ngoài ra chữ "failed" đánh lừa người đọc (task bị huỷ chứ không thất bại).
   Sửa: dùng chính status word giống `ReplicatePredictionError` (`src/providers/replicate/client.ts:49-53`), ví dụ `Task <id> cancelled`. Với case non-terminal thì bỏ JSON đầy đủ, hoặc chỉ đưa `error.code`. Nếu được thì để PollJob trả một reason ngắn thay cho JSON. Test `poll-job-errors.test.ts` (case "does not report a cancelled task") chỉ assert `not.toBe("JOB_FAILED")`. Nên assert code cụ thể và thêm một payload có `error.message` chứa "timeout"/"invalid".

2. **Còn sót hai site cùng pattern, cùng nguyên nhân.** `src/providers/leonardo/commands/generate.ts:153` và `src/providers/leonardo/commands/image-to-image.ts:123` gọi `poll()` mà không bọc gì. `PollFailedError("Operation failed.")` lan lên top-level → `classifyMessage("Operation failed.")` → **UNKNOWN**, không có generation id và không có lý do. Timeout cho ra "Polling timed out before the operation completed." (TIMEOUT nhờ khớp text) nhưng không có id lẫn lệnh resume. Hai site này không có trong danh sách của issue (chúng không log+exit), nhưng vẫn là cùng lỗi "provider-failed → UNKNOWN". Sửa mỗi site bằng 2 dòng `try { … } catch (e) { throw toPollJobError(e, {provider:"leonardo", noun:"Generation", id: generationId, resumeCommand:`multix leonardo status ${generationId} --wait --download`}) }`, hoặc mở issue riêng theo AGENTS.md.

## Medium
3. **Lệnh resume trong hint chưa nhất quán và làm mất ý định tải file.** Các lệnh tạo video (byteplus `video`/`image-to-video`/`reference-to-video` → `multix byteplus status <id>`, leonardo `video` → `status <id> --wait`, openrouter `image-to-video` → `video-status <id> --wait`) đều là lệnh có tải MP4, nhưng hint resume không có `--download`. Chỉ `generate-3d` có `--wait --download`. `byteplus status` thì in `--wait` kể cả khi người dùng đã chạy `--download`. Tất cả cờ đều có thật (`status.ts:24-26`, leonardo `status.ts:44-46`, openrouter `video-status.ts:72-74`; `--download` implies `--wait`). Đề xuất dùng `… --download` cho các lệnh tạo. Lý do: lệnh resume phải cho ra cùng kết quả với lệnh gốc.
4. **Test còn thiếu.** Chỉ cover `byteplus status`, `byteplus video`, `openrouter video-status`, `leonardo status`. Chưa có test cho `image-to-video`, `reference-to-video`, `generate-3d` (3D dùng `waitForThreeDTask`, đường khác), `leonardo video` (`pollAndDownload`), `openrouter image-to-video`. Test timeout chỉ kiểm `toContain("multix byteplus status task-1")` nên không phát hiện sai cờ. Test failed của leonardo không kiểm redaction.
5. **Prompt vẫn lọt vào message/history.** Payload `generations_by_pk` của Leonardo (và có thể của OpenRouter) chứa `prompt`. Message `Generation <id> failed: <JSON>` đi vào stderr, envelope JSON và history ledger (`agent-runtime.ts:333`, 500 ký tự). Rủi ro này có từ trước, vì log line cũ cũng chứa nó. AGENTS.md cấm log full prompt ở mức info. Đề xuất chỉ trích `status`, `error`/`failure_reason` thay vì `JSON.stringify` toàn bộ value.

## Low
6. Tên dễ nhầm: `leonardo/poll.ts` có `PollTimeoutError` cục bộ và cả alias `JobPollTimeoutError` của core. Chấp nhận được, nhưng một comment ngắn sẽ giúp phân biệt.
7. OpenRouter `failed` chỉ nhận `"failed"`. Nếu job có status `cancelled`/`expired` thì sẽ poll đến hết giờ rồi báo TIMEOUT. Lỗi có từ trước, ngoài phạm vi.
8. `byteplus video.ts:94-96` còn một `logger.error(... JSON.stringify(final)); process.exit(1)` (succeeded nhưng không có video_url), cùng họ catch-log-exit nhưng không phải lỗi poll. Ngoài phạm vi, có thể mở issue.

## Redaction / runtime-neutral / worker
- `redactUrlsInText` được áp lên JSON và một lần nữa trong `build()`. Probe xác nhận `?X-Signature=…`/`?Signature=…` → `?[redacted]`. API key không nằm trong payload status. OK.
- `leonardo/poll.ts` chỉ import thêm `core/async-poll`, `core/errors`, `core/redact`. Cả ba đều runtime-neutral, không có `node:*`. `worker/` không import `leonardo/poll` hay `byteplus/generators` (đã grep), nên worker không bị ảnh hưởng và không bắt buộc chạy `check:mcp`.
- `terminal` khớp với comment của class `ProviderJobFailedError` (`src/core/errors.ts:52-58`): mặc định true; BytePlus `cancelled` → false. Leonardo/OpenRouter chỉ map `FAILED`/`failed` nên terminal mặc định là đúng.

## Quy trình (không chặn code)
- Issue #494 đã có claim lúc 11:57Z: "Claimed by routine session workspace-46, branch `claude/relaxed-clarke-va1705`". Commit này nằm trên `fix-494-local`. Theo AGENTS.md, claim đầu tiên thắng. Cần xác nhận đây chính là session đó trước khi mở PR, tránh làm trùng.

## Việc nên làm (theo ưu tiên)
1. Message cho task non-terminal: dùng status word, bỏ JSON đầy đủ; siết test cancelled.
2. Bọc `poll()` ở leonardo `generate`/`image-to-image`, hoặc mở issue riêng.
3. Thêm `--download` vào resume hint của các lệnh tạo.
4. Thêm test cho 3D, i2v/r2v, leonardo video, openrouter i2v.
5. Chỉ trích các trường lý do thay cho cả payload (tránh lọt prompt).

Status: DONE_WITH_CONCERNS
Summary: Phân loại JOB_FAILED/TIMEOUT và exit code đúng cho 9 lệnh; lint, typecheck và test đều pass; redaction và runtime-neutral OK. Còn lại: task bị huỷ vẫn được phân loại theo text payload (ra TIMEOUT/INVALID_INPUT), và leonardo generate/image-to-image vẫn ra UNKNOWN.
Concerns: src/providers/leonardo/poll.ts:76-81 (non-terminal cancelled: message "failed" + full JSON → classifyMessage có thể ra TIMEOUT exit 6 hoặc INVALID_INPUT exit 2); src/providers/leonardo/commands/generate.ts:153 và src/providers/leonardo/commands/image-to-image.ts:123 (PollFailedError không bọc → UNKNOWN, không có id).
