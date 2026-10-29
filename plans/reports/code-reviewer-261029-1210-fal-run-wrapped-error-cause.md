# Code review: commit 2aa0553, fix(fal) giữ class lỗi và Retry-After khi fal run chờ kết quả (#495)

## Phạm vi
- Các file: `src/core/error-classify.ts` (+8), `src/providers/fal/run-helpers.ts` (+6/-2), `tests/unit/core/error-classify.test.ts` (+12), `tests/unit/providers/fal/commands.test.ts` (+21)
- Đã kiểm chứng: `npx vitest run tests/unit/core/error-classify.test.ts tests/unit/providers/fal` -> 7 file pass, 165 test pass, 2 skipped. `tsc --noEmit` sạch. `biome check` trên 4 file sạch.

## Đánh giá chung
Thay đổi nhỏ, đúng nguyên nhân và an toàn. Không có lỗi chặn merge.

## Trả lời các câu hỏi kiểm tra
1. **An toàn với các caller khác.** Branch mới chỉ chạy khi lỗi KHÔNG phải MultixError, là `Error`, và có `cause instanceof MultixError`. Đã grep `cause:` / `{ cause }` / `.cause` trong `src/` và `worker/src`: mọi chỗ wrap khác đều tạo `MultixError`/`ProviderError`/`HttpError`/`TopviewApiError`/`SumeApiError`/`ReplicateApiError` (đều là MultixError, nên bị guard loại ra). Chỉ có hai chỗ `new Error(..., { cause })` là `run-helpers.ts:165` và `:179` trong commit này. Lỗi native (fetch TypeError, lỗi hệ thống Node) có cause là lỗi plain/undici, không phải MultixError, nên không bị ảnh hưởng. Đệ quy dừng sau một bước, vì cause là MultixError nên không vào lại branch: không có vòng lặp vô hạn kể cả khi chuỗi cause tự tham chiếu.
2. **Thứ tự branch.** Đặt branch trước nhánh commander và ProviderJobFailedError là đúng. Wrapper là plain Error, không thể là ProviderJobFailedError. Lỗi commander không mang cause là MultixError. Nếu đặt sau nhánh commander thì cũng không đổi kết quả, nên không có rủi ro.
3. **Các trường `env`, `exit_code`, `hint`, `http_status`, `retry_after_s`.** Tất cả lấy từ cause, chỉ `message` lấy từ wrapper và đã qua `redactUrlsInText`. Message của wrapper = `prefix + cause.message + resumeHint`, tức là bao trọn message của cause. Prefix và resumeHint chỉ chứa request id và model id viết thường, không khớp `ENV_NAME`, nên `env` không bị lệch. `exit_code` theo code của cause, khớp với hành vi trước đây: wrapper chứa "HTTP 4xx", và trước đây `classifyMessage` đã dựng lại cùng code/http_status. Điểm thực sự thay đổi là `retry_after_s` và các code không suy ra được từ text (ví dụ `ResponseTooLargeError` -> RESPONSE_TOO_LARGE). Có một chỗ không nhất quán: nếu một MultixError khác về sau được wrap bằng plain Error, `env` lấy theo message của cause, còn `message` lấy theo wrapper. Hiện tại không có trường hợp nào như vậy.
4. **Worker.** `worker/src/mcp-server.ts:17` chỉ import `classifyMessage` (type `ErrorInfo`), không import `classifyError`. `error-classify.ts` không thêm import mới (`redactUrlsInText` đã có sẵn), nên vẫn không có `node:*`. `run-helpers.ts` không đổi import. Không cần chạy `check:mcp`. `run-helpers` không thuộc client mà worker dùng; nếu muốn chắc chắn thì CI sẽ chạy.
5. **Chất lượng test.** Unit test kiểm tra code, http_status, retry_after_s (2500ms -> 3s, làm tròn lên) và message của wrapper. Case âm (TypeError có cause là plain Error) có giá trị thật: nếu branch đi theo mọi cause thì kết quả sẽ là UNKNOWN ("bad request body") thay vì NETWORK_ERROR, nên test phân biệt được. Test tích hợp chạy đúng luồng CLI thật qua mock fetch (429 + `retry-after: 30` ở bước result fetch) và kiểm tra resume hint. Thiếu: không có test cho nhánh status poll (`run-helpers.ts:165`). Status 429 khi poll không được coi là transient (`isRetryableServerStatus` chỉ nhận 0/5xx), nên nhánh này có chạy trong thực tế.

## Critical
Không có.

## High
Không có.

## Medium (không chặn; nên mở issue riêng theo AGENTS.md)
- `src/core/error-classify.ts:84` cộng với `run-helpers.ts:179`: hint RATE_LIMITED là "Wait retry_after_s ... and retry the same command". Khi lỗi xảy ra ở bước result fetch, hoặc ở status poll sau khi submit, job đã được submit/tính tiền. "Retry the same command" (`multix fal run`) sẽ submit lại và có thể trả tiền hai lần, trong khi message lại đúng là "Resume with: multix fal result ...". Lỗi này đã có từ trước, vì code đã là RATE_LIMITED qua text "HTTP 429". Nhưng giờ có thêm `retry_after_s` nên agent càng dễ làm theo hint. Đề xuất: khi wrapper có resume hint, ghi đè `hint` (ví dụ wrapper mang một hint/code riêng), hoặc wrap bằng MultixError có ngữ nghĩa resume. Ngoài phạm vi #495.
- `run-helpers.ts:156-167`: status poll gặp 429 thì dừng ngay thay vì chờ Retry-After rồi poll tiếp. Đây là cải tiến ngoài phạm vi.

## Low
- Thiếu test cho nhánh status poll (`run-helpers.ts:165`). Đề xuất thêm một case trả 429 hoặc 404 ở route `/status`.

## Tác động tài liệu
N/A. Code/exit code không đổi, chỉ thêm `retry_after_s`/`http_status` ở trường hợp vốn đã khai báo trong `ErrorInfo`.

## Theo dõi plan
Không có plan file. Issue #495 có vẻ đã được giải quyết đầy đủ theo mô tả.

## Câu hỏi còn mở
- Có muốn mở issue cho hint RATE_LIMITED/PROVIDER_UNAVAILABLE gây hiểu nhầm "retry the same command" sau khi job đã submit không?
