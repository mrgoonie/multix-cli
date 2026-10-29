# Code review vòng 2: eaf67f5 (fix-494-local), issue #494

Phạm vi: `git diff origin/dev...eaf67f5`, 14 file, +448/-99. Trọng tâm là eaf67f5 (13 file, +307/-151).
Worktree: `/workspace/multix-cli/.claude/worktrees/agent-a914276477905f313`. Review chỉ đọc, `git status` sạch.

## Kiểm chứng đã chạy
- `npx vitest run tests/unit/providers/poll-job-errors.test.ts`: 33/33 pass (vòng trước là 8).
- `npm run lint`: sạch, 701 file. `npm run typecheck`: sạch.
- Đã đọc `classifyError`/`classifyMessage`/`TEXT_RULES` (`src/core/error-classify.ts:143-305`) và trace từng loại message mới.
- Đã grep mọi importer của `leonardo/poll.js` và mọi caller của `waitForVideoTask`/`waitForThreeDTask`: tất cả đều đã bọc.

## Kiểm tra 5 điểm của review trước

| # | Điểm | Kết quả |
|---|---|---|
| 1 | Task bị huỷ bị phân loại theo text | **Đã sửa.** `toPollJobError` (`src/providers/leonardo/poll.ts:108-118`) chỉ thêm reason khi `terminal`. Task huỷ ra message `Task <id> cancelled`, không khớp rule nào nên `classifyMessage` trả UNKNOWN (exit 1). Nếu `statusWord` rơi về "failed" thì regex JOB_FAILED khớp, nhưng `classifyError:286` hạ xuống UNKNOWN. Test có 3 payload (không reason, reason chứa "timeout", reason chứa "invalid … required") và assert đúng code UNKNOWN cùng message chính xác. |
| 2 | leonardo generate / image-to-image chưa bọc | **Đã sửa.** `generate.ts:163-169` và `image-to-image.ts:133-139` dùng `.catch(toGenerationError)`. HttpError vẫn đi qua nguyên vẹn. Có test failed và timeout cho cả hai. |
| 3 | Hint resume thiếu `--wait --download` | **Đã sửa, cờ khớp thật.** byteplus video/i2v/r2v/3d → `status <id> --wait --download` (`byteplus status` có `--download`, và nó xử lý cả `file_url` của 3D: `status.ts:58-79`). byteplus status → thêm `--download` khi có `opts.download`. leonardo generate/i2i → `--download` trừ khi `--no-download` (`opts.download === false`, khớp với commander `--no-download`). leonardo video/status và openrouter i2v/video-status → `--download` theo `opts.download`. Tất cả cờ đều có trong lệnh đích (`leonardo status.ts:44-46`, `openrouter video-status.ts:89-91`). |
| 4 | Full payload (kèm prompt) trong message | **Đã sửa.** Message chỉ gồm noun, id, status word, và (khi terminal) `failureReason(error field)` đã `redactUrlsInText`. Leonardo không lấy reason. `cause` (PollFailedError còn giữ value) không được in ở đâu (grep `.cause` trong agent-runtime/cli/logger: không có). Test so sánh message chính xác với payload có `prompt`, nên prompt không thể lọt mà test vẫn pass. |
| 5 | Thiếu test | **Đã sửa.** Đủ 12 đường: byteplus video, i2v, r2v, generate-3d, status --wait/--download; openrouter i2v --wait/--download, video-status; leonardo generate (±--no-download), i2i, video --wait/--download, status. Mỗi đường có test failed và test timeout, assert message chính xác (bắt được sai cờ), và assert không gọi `process.exit`. |

## Phân loại và exit code (trace lại)
- Terminal (`failed`/`FAILED`) → `ProviderJobFailedError(terminal=true)` → JOB_FAILED, exit 5 với `--json` (1 ở chế độ người đọc). Reason của provider (vd. "sensitive content", "timeout") không đổi được code, đúng như ý đồ.
- Huỷ → terminal=false → UNKNOWN. Reason bị bỏ nên text không thể đẩy sang TIMEOUT/INVALID_INPUT.
- Hết giờ → core `PollTimeoutError` (POLL_TIMEOUT) → TIMEOUT, exit 6, hint "resume, do not resubmit", kèm lệnh resume trong message.
- Lỗi khác (HttpError, lỗi download) → trả nguyên.
- Whitelist status word `^[A-Za-z_-]{1,32}$` rồi lowercase: chặn injection/text dài vào message. Status số, rỗng hay object → "failed". Hợp lý.

## Runtime-neutral / worker
`src/providers/leonardo/poll.ts` chỉ import `core/async-poll`, `core/errors`, `core/redact`, không có `node:*`. `worker/src` không import `leonardo/poll`, `toPollJobError` hay `failureReason` (đã grep), nên không cần `check:mcp`.

## Critical / High
Không có.

## Medium
Không có.

## Low (không chặn)
1. **Task huỷ mất hẳn lý do.** `poll.ts:110-111` bỏ cả reason khi non-terminal, nên người dùng không biết vì sao task bị huỷ. Đây là trade-off có chủ ý và an toàn cho việc phân loại. Nếu muốn giữ chút thông tin, có thể chỉ đưa `error.code` khi nó qua cùng whitelist dạng token (vd. `Task X cancelled (code: QueueTimeout)`). Cần kiểm lại rằng chữ "timeout" trong code đó không làm `classifyMessage` ra TIMEOUT. Hiện tại thì nó sẽ khớp, nên cách hiện tại là đúng. Giữ nguyên.
2. **Hint resume không mang theo `--output`, `--wait-timeout`, `--no-thumb`.** Tên file khi resume cũng khác lệnh gốc: leonardo status đặt tên `leonardo-<id8>-<n>.<ext>`, byteplus status đặt `byteplus-video-<id8>.mp4`. Lệnh vẫn hoàn thành job, chỉ khác đường dẫn. Chấp nhận được, có thể ghi chú trong PR.
3. **Reason terminal không giới hạn độ dài.** `failureReason` trả JSON của cả error field khi field đó không có `code`/`message`. Field này chỉ là error field, không phải cả payload, và ledger đã cắt ở 500 ký tự. Rủi ro thấp.
4. **Test chưa cover nhánh fallback**: `statusWord` với status lạ, và `failureReason` với object không có code/message. Không bắt buộc.
5. Style: leonardo generate/i2i dùng `.catch(...)`, các site khác dùng `try/catch`. Kết quả tương đương.
6. Các mục Low cũ (#6-#8 vòng trước: tên `PollTimeoutError` trùng, OpenRouter chỉ map `failed`, `byteplus video.ts` còn `process.exit` khi thiếu `video_url`) vẫn còn, nằm ngoài phạm vi. Nên mở issue riêng theo AGENTS.md.

## Quy trình (không chặn code, nhưng phải xử lý trước khi mở PR)
- Issue #494 có claim sớm nhất lúc 2026-10-29T11:57:32Z: "routine session workspace-46, branch `claude/relaxed-clarke-va1705`". Branch đang review là `fix-494-local`. Đến lúc review chưa có PR mở nào cho #494 (đã check `gh api .../pulls?state=open`). Theo AGENTS.md, claim đầu tiên thắng: cần xác nhận đây chính là session đó, hoặc đẩy lên đúng branch đã claim, trước khi mở PR.
- PR body cần có mục `Documentation impact`. Message lỗi và exit code của các lệnh này thay đổi, nhưng docs-site/skill/README không nhắc chuỗi cũ (grep "Task failed", "Polling timed out", "keep the task and check later": không có). Nhiều khả năng ghi `N/A` kèm lý do.

## Đề xuất
1. Xử lý claim/branch rồi mở PR (`Closes #494`, kèm output test).
2. Tuỳ chọn: thêm 2 unit test nhỏ cho nhánh fallback của `statusWord`/`failureReason`.
3. Mở issue riêng cho các mục Low ngoài phạm vi (OpenRouter `cancelled`/`expired`, `byteplus video` thiếu `video_url`).

Status: DONE
Summary: Cả 5 điểm của review trước đã được sửa đúng và có test chặt (33/33 pass, so sánh message chính xác). Phân loại JOB_FAILED/TIMEOUT/UNKNOWN và exit code đúng, cờ trong hint resume khớp với lệnh thật, không lọt prompt, redaction và runtime-neutral OK. Lint và typecheck sạch. Không thấy regression.
Concerns: none trong code. Về quy trình: claim sớm nhất trên #494 thuộc branch `claude/relaxed-clarke-va1705`, không phải `fix-494-local`. Cần đối chiếu trước khi mở PR.
