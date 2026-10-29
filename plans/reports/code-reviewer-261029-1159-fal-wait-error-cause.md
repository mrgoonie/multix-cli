# Code review: giữ `cause` khi `waitForFalResult` bọc lỗi (issue #495)

Ngày: 2026-10-29 (UTC). Reviewer độc lập (không viết code này).
Nhánh `claude/relaxed-clarke-ns73sh`, base `origin/dev`, phạm vi: diff chưa commit trong working tree.

## Phạm vi

- `src/core/error-classify.ts`: thêm nhánh `else if (error instanceof Error && error.cause instanceof MultixError)` (dòng 303-307).
- `src/providers/fal/run-helpers.ts`: hai lần `throw new Error(..., { cause: e })` (dòng 165-167, 180-182).
- `tests/unit/core/error-classify.test.ts`: 2 test mới (dòng 91, 109).
- `tests/unit/providers/fal/run-helpers.test.ts`: helper `mockQueue`, `waitError`, 2 test mới (dòng 312, 335).

## Đã chạy để kiểm chứng

- `npx vitest run tests/unit/core/error-classify.test.ts tests/unit/providers/fal/run-helpers.test.ts`: 2 file, 55 test đều pass.
- `npx biome check` trên 4 file: không có lỗi.
- Script thử (tsx, đặt trong scratchpad và đã xóa):
  - `classifyMessage` trên thông điệp cũ của nhánh poll 401 trả `INVALID_KEY`, `http_status: 401`. Nghĩa là test ở run-helpers.test.ts:335 vẫn pass cả trên code trước khi sửa.
  - Một `Error` thường bọc `ProviderJobFailedError({ terminal: false })` có message "job abc1 failed..." bị phân loại `JOB_FAILED`, còn bản thân lỗi bên trong thì là `UNKNOWN`. Xem M2.
- Không chạy typecheck, build hay toàn bộ suite, theo đúng yêu cầu.

## Kiểm tra theo checklist

- **Đúng đắn:** với cause là `HttpError`, `codeFromHttp(status, snippet)` cho cùng `code` và `http_status` như việc parse text trước đây, và nay giữ thêm `retry_after_s`. Với `ConfigError` hoặc `ResponseTooLargeError` (từ `toFetchError`, hoặc khi vượt giới hạn kích thước), kết quả chính xác hơn text. HttpError status 0 vẫn ra `NETWORK_ERROR`/`TIMEOUT`, `http_status` là undefined, giống trước.
- **Các chỗ throw khác:** grep đa dòng `new (Error|TypeError|RangeError)(...cause` trong `src/` và `worker/src` chỉ ra đúng 2 chỗ mới ở fal. Mọi chỗ khác bọc lỗi kèm `{ cause }` (gemini/omni-flow, fal/speech-output, sume/node-catalog, sume/commands/cancel, topview/errors, gemini/client, fetch-error, runway/replicate/sume mapper, openrouter, fish, cloudflare) đều dùng lớp con của `MultixError`, nên rơi vào nhánh `if (error instanceof MultixError)` và không chạm nhánh mới. Lỗi `TypeError("fetch failed")` của undici có cause không phải MultixError nên cũng không bị ảnh hưởng. Hiện không có thay đổi phân loại nào ngoài 2 chỗ của fal.
- **Lỗi commander:** kiểm tra `commander.*` đứng trước và return sớm; `CommanderError` cũng không có `cause`. Không bị ảnh hưởng.
- **An toàn đệ quy:** đệ quy chỉ khi cause là `MultixError`. Ở lần gọi đệ quy, lỗi rơi vào nhánh `MultixError` (nhánh mới là `else` của nhánh đó), nên độ sâu tối đa là 1 và không thể lặp vô hạn kể cả với chu trình cause.
- **Redact:** message ngoài được `redactUrlsInText` (test dòng 91 kiểm chứng `?[redacted]`). `HttpError.message` vốn đã redact URL và snippet. `cause` là thuộc tính không enumerable, `rawUrl` cũng không enumerable, nên `JSON.stringify` không làm lộ gì.
- **Trường `env`:** lấy từ message của cause (qua `build`), không lấy từ message ngoài. Trong fal, message ngoài chứa nguyên message của cause cộng với request id và resume hint (không có tên biến môi trường), nên kết quả tương đương. Xem L1.
- **Worker:** `worker/src/mcp-server.ts` chỉ import `classifyMessage` và không import `run-helpers`. `worker/container/` là `.mjs` và không dùng `error-classify`. Không ảnh hưởng, không cần `check:mcp`.
- **Concurrency, authz, N+1:** không áp dụng.

## Critical

Không có.

## High

Không có.

## Medium

**M1. Test ở run-helpers.test.ts:335 ("keeps a rejected status poll classified by its HTTP status") không chứng minh được bản sửa.** Trên code cũ, `classifyMessage` vẫn parse được "HTTP 401" trong message, nên ra `INVALID_KEY` và `http_status: 401`; test pass cả khi chưa sửa (đã kiểm bằng script). Nhánh poll status hiện không có test nào thất bại nếu thiếu `{ cause: e }`.
- Cách sửa: đổi sang 429 (không transient) có `retry-after` trên `STATUS_URL` và assert `retry_after_s`, hoặc thêm `expect((err as Error).cause).toBeInstanceOf(HttpError)`.
- Test 429 của nhánh result (dòng 312) thì đạt: assert `cause` và `retry_after_s: 30`, hai điều không đúng trên code cũ.

**M2. Nhánh fallback có thể vô hiệu hóa chốt chặn `ProviderJobFailedError.terminal === false` (tiềm ẩn).** Tại `src/core/error-classify.ts:306-307`, khi cause được phân loại `UNKNOWN` thì code rơi xuống `classifyMessage(message)` trên message ngoài. `classifyError` trả `UNKNOWN` có chủ đích cho một `ProviderJobFailedError` không terminal (job bị hủy hoặc tạm dừng, "never reported as a failed job, whatever the text says", dòng 284-286). Khi một `Error` thường bọc lỗi đó, text của message ngoài lại ra `JOB_FAILED` (đã tái hiện). Hiện chưa có chỗ throw nào gây ra trường hợp này, vì `getAbsolute` của fal không ném lỗi đó, nên chưa phải bug thực. Tuy vậy, nhánh mới là quy tắc chung cho mọi wrapper sau này.
- Cách sửa tối thiểu: chỉ fallback khi cause không phải `ProviderJobFailedError`, ví dụ `if (info.code !== "UNKNOWN" || error.cause instanceof ProviderJobFailedError) return {...}`.
- Hoặc thêm một test khóa hành vi mong muốn.

## Low

**L1. `env` lấy từ cause.** Nếu sau này một wrapper thêm tên biến (ví dụ "set FAL_KEY") vào message ngoài, `env` sẽ không phản ánh tên đó. Với fal hiện tại thì không sao. Có thể tính lại `env` từ message ngoài nếu muốn nhất quán với `build`.

**L2. Comment chỉ có ở một chỗ.** Comment "The cause keeps the error's class..." có ở dòng 179 nhưng không có ở nhánh poll (dòng 165). Đây là vấn đề nhỏ về tính nhất quán, không bắt buộc sửa.

**L3. Test dòng 109 dùng `ProviderError("something odd")`.** Test này kiểm được fallback, nhưng không có test cho trường hợp cause không phải `MultixError` (ví dụ `new Error("x", { cause: new TypeError("fetch failed") })`) để khóa việc nhánh mới không kích hoạt. Không bắt buộc.

## Ngoài phạm vi (nên mở issue riêng, không mở rộng PR này)

- **Hint `RATE_LIMITED` và `PROVIDER_UNAVAILABLE` sai ngữ nghĩa sau khi fal đã nhận job.** Lỗi ở bước poll status hoặc fetch result xảy ra sau khi submit đã được chấp nhận (job đã tính tiền). Envelope trả `retryable: true` và exit 4, kèm hint "retry the same command", nhưng chạy lại `multix fal run/image/video` sẽ submit lại và có thể trả tiền hai lần. Hướng đúng là resume bằng `multix fal status/result`, như message đã ghi.
  - Đây là hành vi có từ trước, vì text "HTTP 429" vốn đã được phân loại `RATE_LIMITED`.
  - Bản sửa này thêm `retry_after_s`, khiến agent tự động retry càng dễ tin tưởng hơn.
  - Hướng xử lý: dùng hint hoặc code riêng cho lỗi sau submit (tương tự cơ chế `inFlight` của signal exit trong `src/agent/agent-runtime.ts`).
- **Nhánh timeout vẫn là `new Error` thường, không có code.** Ở `src/providers/fal/run-helpers.ts:148`, lỗi timeout vẫn dựa vào text "Timed out" để ra `TIMEOUT`. Hiện vẫn đúng, nhưng dễ vỡ, và có thể chuyển sang `MultixError` với code `POLL_TIMEOUT`.

## Câu hỏi mở

1. Có muốn khóa M2 ngay trong PR này (một dòng điều kiện cộng một test), hay ghi nhận là rủi ro tiềm ẩn?
2. Mục "hint retry sau submit" có được mở thành issue riêng không? Theo AGENTS.md thì nên mở.
