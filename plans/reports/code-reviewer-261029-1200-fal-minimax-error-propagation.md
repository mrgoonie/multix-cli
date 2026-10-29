# Code review: fal result / minimax image-to-image error propagation (#492)

Ngày: 2026-10-29 (UTC). Reviewer: code-reviewer (độc lập, không viết code).

## Phạm vi
- `src/providers/fal/commands/result.ts` (bỏ try/catch + `process.exit(1)` quanh `client.get`)
- `src/providers/minimax/commands/image-to-image.ts` (bỏ try/catch + `process.exit(1)` quanh `apiPost`)
- `tests/unit/providers/fal/commands.test.ts` (+2 test "fal result failures")
- `tests/unit/providers/minimax/image-to-image-errors.test.ts` (mới, 3 test)
- Khoảng 110 LOC thay đổi. Không có REVIEW.md trong repo.

## Kiểm chứng đã chạy
- `npx vitest run tests/unit/providers/fal/commands.test.ts tests/unit/providers/minimax/`: 4 file, 47 test pass.
- `npx biome check` trên 4 file: sạch.
- `npm run typecheck`: sạch.

## Đánh giá tổng thể
Đúng hướng, nhỏ gọn, giống hệt cách làm của `gemini generate` trong acbbbd3 (PR #491). Không có lỗi blocking.

## Request id có còn trong mọi đường lỗi của `fal result` không
Đã đối chiếu từng đường lỗi của `FalClient.get` -> `httpJson` -> `fetchJson`:
- non-2xx: `HttpError` message `HTTP <s> from <redactUrl(url)>: ...`; `redactUrl` chỉ bỏ query/fragment, path `/<app>/requests/<id>` vẫn còn -> có request id (test 429 kiểm điều này).
- network/timeout/abort: `toFetchError(cause, current)` -> `HttpError(0, ..., url)` -> có id trong URL.
- invalid URL/header: `ConfigError` có `target = redactUrl(url)` -> có id. TLS/request: `ProviderError` "Request to <target> failed" -> có id.
- đọc body lỗi, JSON hỏng: `HttpError(0|status, ..., url)` -> có id. `ResponseTooLargeError`: không dùng ở đây (không đặt maxBytes) nhưng message cũng chứa URL.
- Ngoại lệ duy nhất: sau một redirect cùng origin, `current` là URL đích, có thể không còn chứa id (`src/core/redirect-fetch.ts:90,115-122`). Hiếm với queue.fal.run; vẫn được bù bằng `nameJob(requestId)` (job id trong run state/history). Không cần sửa.
- `appIdFromModel` ném `ValidationError` trước khi có request; lỗi đó không liên quan đến id.
Kết luận: yêu cầu "giữ request id" của issue được thoả, không cần bọc lại message.

## Hành vi stderr / exit code
- Trước: logger in `✗ Failed to fetch result for fal request <id>: <msg>` rồi `process.exit(1)` -> `finalizeRun` phân loại bằng `classifyMessage(lastErrorLine)`: mất `retry_after_s`, mất lớp lỗi.
- Sau: lỗi bubble tới `program.parseAsync(...).catch(exitWithError)` (`src/cli.ts:30`) -> `finalizeRun({exitCode:1, error})` -> `classifyError(error)`. Ở chế độ thường, vì không còn `lastErrorLine`, `agent-runtime.ts:400` in `Error: <message>` + dòng `code: ... retryable after Ns` + `hint`. Exit code chế độ thường vẫn là 1; với `--json` là exit class theo code (đúng như mọi lệnh đã migrate).
- Thay đổi văn bản stderr duy nhất: mất tiền tố "Failed to fetch result for fal request <id>:"; id vẫn có trong URL. Không có doc nào trích dẫn chuỗi này (grep `Failed to fetch result` chỉ ra `run-helpers.ts` và test).
- minimax: trước đó in `✗ <msg>`; nay in `Error: <msg>`. Lưu ý `logger.warn` ở đầu lệnh không đặt `lastErrorLine` (regex chỉ bắt `✗|Error:|error:`), nên dòng `Error:` vẫn được in.

## Critical / High
Không có.

## Medium
Không có.

## Low
1. `tests/unit/providers/minimax/image-to-image-errors.test.ts:6,26-31`: mảng `logged` được thu thập nhưng không bao giờ được assert. Nên assert không có dòng `✗` (tương đương test fal `not.toMatch(/Failed to fetch result/)`), hoặc bỏ biến.
2. Cùng file, fetch stub trả 429/throw cho mọi URL mà không kiểm tra URL gọi tới là `.../image_generation`. Hiện tại đúng vì `resolveImageInput` trả URL http nguyên trạng (`src/core/image-input.ts:91`), nhưng test sẽ vẫn xanh nếu sau này lệnh fetch ref trước và lỗi ở đó. Nên assert URL/method trong stub.
3. Test chưa chạy qua `installAgentRuntime`/`finalizeRun`, nên không kiểm dòng stderr `Error: ...` cuối cùng hay exit code. Chấp nhận được vì `classifyError` là đúng hàm finalizeRun dùng và các test hiện có của agent-runtime đã phủ đường `exitWithError`.

Cả hai test mới đều có ý nghĩa: với code cũ, `process.exit` bị mock để ném `process.exit(1)` nên `expect(String(error)).not.toMatch(/process\.exit/)` và `classifyError(...)` sẽ fail. `stderr` trong test fal bắt `console.error`, chính là nơi logger (`stderr: true`) ghi, nên assertion phủ định không vô nghĩa.

## Ngoài phạm vi (nên mở issue riêng theo AGENTS.md, không mở rộng PR này)
- `src/providers/fal/run-helpers.ts:165` và `:177`: `waitForFalResult` (đường `fal run` chờ kết quả) bọc lỗi poll/result thành `new Error(...)` không có `cause`, nên cùng lớp lỗi: mất lớp `HttpError` và `retry_after_s` (ví dụ 429 không tạm thời khi fetch result). Nên giữ lỗi gốc làm `cause` hoặc dùng `MultixError`/`HttpError` để `classifyError` thấy được, và vẫn giữ `resumeHint`.
- Các `process.exit(1)` sau log còn lại trong hai file ("none downloaded successfully", "No images in response") không phải lỗi provider bị nuốt, ngoài phạm vi #492.

## Quy tắc repo
- Client provider không bị đổi; không có `node:*` mới; không cần `check:mcp`.
- Comment trong code giải thích invariant, không chứa mã issue/plan: đạt.
- Documentation impact: N/A (không đổi flag/lệnh/code lỗi được ghi tài liệu; chỉ đổi phân loại nội bộ và tiền tố dòng lỗi). PR body vẫn phải có mục `Documentation impact` ghi N/A kèm lý do.
- Commit nên là `fix(fal): ...`/`fix(errors): ...` với `Closes #492`.

## Các hạng mục đã hoàn tất của issue
- fal result: lỗi bubble, `retry_after_s` và lớp lỗi được giữ, request id còn trong message: xong.
- minimax image-to-image: lỗi bubble, phân loại RATE_LIMITED / NETWORK_ERROR / QUOTA_EXCEEDED: xong.

## Câu hỏi còn mở
- Có muốn xử lý `run-helpers.ts:165,177` trong một issue tiếp theo không?
