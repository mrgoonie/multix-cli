# Code review: fix(fal) chờ hết 429 của status poll trong fal run (#500)

Commit: `5e26971` (HEAD). Reviewer độc lập, không sửa code.

## Phạm vi
- `src/providers/fal/run-helpers.ts` (+19/-12), `tests/unit/providers/fal/run-helpers.test.ts` (+37/-9)
- Người gọi: `src/providers/fal/commands/run.ts:121`, `tts.ts:121`, `image.ts:63`, `video.ts:60` (qua `submitAndWait`)

## Kiểm chứng
- `npx vitest run tests/unit/providers/fal tests/unit/core`: 23 file pass, 1 skipped; 547 test pass, 8 skipped (2.66s)
- `npx biome check` hai file thay đổi: sạch. `npx tsc --noEmit`: sạch.
- Test "waits out a 429..." chạy 1003ms thời gian thật.

## Đánh giá tổng quan
Logic đúng và khớp `pollUntil` trong core. Không có lỗi chặn merge. Còn thiếu cập nhật docs (AGENTS.md yêu cầu) và vài test nhỏ.

## Critical
Không có.

## High
Không có.

## Medium
1. **Docs đã lỗi thời (AGENTS.md "Documentation impact")**:
   `docs-site/src/content/docs/commands/fal.md:218-219` và `docs-site/src/content/docs/vi/commands/fal.md:218-219` vẫn ghi polling "retries transient network errors and 5xx responses other than 501 and 505". Giờ code còn retry 408 và 429, theo Retry-After, không chờ quá deadline. Cần sửa cả trang EN và VI rồi chạy `npm run verify:docs`. PR body cần có mục `Documentation impact`. Đã kiểm tra `skill/SKILL.md:110,129` và `README.md:681-682`: không mô tả lớp lỗi được retry, nên không cần sửa.

## Low
2. **Test chờ 1 giây thật** (`run-helpers.test.ts:335-353`): chấp nhận được, nhưng mỗi lần chạy suite mất thêm ~1s, và ngưỡng `>= 950ms` có thể flaky trên CI chậm (rủi ro thấp). Có thể dùng `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(1000)`, hoặc kiểm tra số lần poll trước/sau mốc thời gian.
3. **Thiếu test cho các nhánh mới**:
   - 408 trên status poll được retry
   - 429 không có Retry-After thì chờ `intervalMs`
   - Reset `lastError`: 429 → IN_PROGRESS → timeout thì message không được ghi "Last error"
   - Timeout thông thường (`run-helpers.test.ts:247`) giờ là `PollTimeoutError`: chưa có test nào assert `classifyError(...).code === "TIMEOUT"` khi không có lỗi trước đó
4. **Retry-After vượt deadline thì không còn poll cuối** (`run-helpers.ts:170` → `146-152`): sleep bị cắt đúng tại deadline, vòng lặp sau ném timeout luôn. Job xong trong lúc chờ vẫn bị báo TIMEOUT. `pollUntil` cũng làm vậy, và message có resume hint. Chấp nhận được, chỉ ghi lại.

## Ngoài phạm vi (đề xuất mở issue riêng, không mở rộng PR này)
- **429 khi lấy kết quả** (`run-helpers.ts:184-191`): job đã COMPLETED và đã trả tiền, nhưng lấy `response_url` mà gặp 429/5xx thì fail ngay. Có resume hint, nhưng cùng loại lỗi với #500. Hiện chưa có issue mở nào cho việc này.
- **Request poll không bị giới hạn bởi deadline**: `client.ts:132` dùng timeout cố định 120s cho mỗi request, nên một poll treo có thể vượt `--wait-timeout` tới 120s. `pollUntil` truyền `remainingMs` vào để tránh việc này. Lỗi này có từ trước commit.
- Sleep sau một poll không lỗi (`run-helpers.ts:180`, `sleep(intervalMs)`) cũng không bị cắt theo deadline. Có từ trước, tác động nhỏ.

## Các câu hỏi đã kiểm tra
- **Retry-After 0, không có, hoặc rất lớn**: `parseRetryAfter` (`src/core/fetch-json.ts:48`) trả số ms ≥ 0 hoặc undefined. `max(retryAfter ?? 0, intervalMs)` nên giá trị 0 hoặc không có header đều chờ đúng interval. Giá trị lớn bị cắt bởi `min(..., max(1, deadline-now))`.
- **Vòng lặp bận**: không có. Thời gian sleep nhỏ nhất là 1ms và chỉ xảy ra khi còn dưới 1ms tới deadline; vòng lặp kế tiếp ném lỗi ngay.
- **Tính deadline**: `remaining <= 0` được kiểm tra trước mỗi lần poll, nên đúng.
- **Reset `lastError`**: được reset sau mỗi poll thành công (`run-helpers.ts:160`), giống `pollUntil`.
- **Retry 408**: hợp lý. Poll là GET idempotent, 408 là lỗi phía server/proxy, và khớp mặc định của core `isTransientHttpError`.
- **Thay đổi cách phân loại lỗi**: trước đây timeout là `Error` thường, được phân loại theo text bằng regex `timed out` → TIMEOUT. Giờ là `code === "POLL_TIMEOUT"` → TIMEOUT (`error-classify.ts:300`), exit code 6 như cũ. Nếu vẫn phân loại theo text, message mới chứa "HTTP 429" có thể bị nhận nhầm, nên đổi sang `PollTimeoutError` là cần thiết.
- **Người gọi phụ thuộc message hoặc `Error` thường**: đã grep `"Timed out waiting for fal"` và `"Failed to poll status"` trong `src/` và `src/agent`. Chỉ có `run-helpers.ts` và chính file test dùng. Không có người gọi nào bắt theo kiểu lỗi hay theo text. `speech --fallback` chọn route trước khi chạy, không fallback khi chạy, nên không có đường nào trả tiền hai lần do đổi lớp lỗi.
- **Import**: `isRetryableServerStatus` vẫn được dùng ở `run-helpers.ts:61`, không thừa. Không có import `node:*` mới trong client (`run-helpers.ts` thuộc lớp command và đã dùng `node:fs` từ trước).
- **Test bị thay**: test cũ "keeps Retry-After and the HTTP class of a 429" assert hành vi lỗi mà #500 sửa, nên thay nó là đúng chứ không phải làm yếu test.
- **Commit**: `fix(fal):` đúng conventional commit, có `Closes #500`, không lẫn phần của #501.

## Việc nên làm
1. Sửa `docs-site/.../commands/fal.md` và `vi/commands/fal.md` dòng 218-219 (thêm 408/429, theo Retry-After, giới hạn bởi deadline), chạy `npm run verify:docs`, thêm `Documentation impact` vào PR.
2. (Tùy chọn) Dùng fake timers cho test 1s, thêm test 408 / không có Retry-After / reset lastError / phân loại timeout thông thường.
3. Mở issue riêng cho 429/5xx khi lấy kết quả và cho request poll không bị giới hạn bởi deadline.
