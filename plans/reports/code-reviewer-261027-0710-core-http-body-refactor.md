# Code review: move HTTP body and audio helpers to src/core (issue #358)

- Branch: `claude/gracious-heisenberg-7ljaxd`, commit `e7ffeb4` on top of `origin/dev`
- Reviewer: isolated code-reviewer (did not write the code)
- Date: 2026-10-27 07:10 UTC
- Scope: `src/core/http-body.ts` (new), `src/core/audio-kind.ts`, `src/providers/openrouter/speech-client.ts`, `src/providers/openrouter/speech-audio.ts`, `tests/unit/core/http-body.test.ts` (new), `tests/unit/core/worker-safe-http.test.ts` (+224 / -132 lines)

## Verdict

**APPROVE.** Không có lỗi Critical, High hay Medium. Hành vi không đổi, mọi export cũ vẫn còn, các module core vẫn runtime-neutral. Còn lại vài ghi chú Low, không chặn merge.

## Kết quả kiểm tra

| # | Kiểm tra | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | Code chuyển đi giống hệt code đã xoá | PASS | Đối chiếu máy móc: lấy các dòng `-` của `src/providers/openrouter` trong diff rồi tìm trong các dòng `+` của `src/core`. Chỉ 2 dòng không khớp: (a) comment `NOT_SENT_CODES` đổi "never reached OpenRouter" thành "never reached the server"; (b) `async function readAudio` thành `export async function readAudio`. Phần thân hàm `readAudio`, `readCappedText`, `concat`, `errorCodes`, `parseAudioContentType`, `looksLikeMp3`, interface `AudioContentType` và hai hằng số đều giống từng ký tự. |
| 2 | Mọi export cũ vẫn được export (kể cả type) | PASS | `speech-client.ts`: 4 symbol đã chuyển được re-export ở dòng 33 (`NOT_SENT_CODES, UNKNOWN_REMOTE_STATE, errorCodes, readCappedText`). `readAudio` trước đây là private nên không cần re-export. `speech-audio.ts:17` re-export `type AudioContentType, looksLikeMp3, parseAudioContentType`. Đã so sánh với `git show origin/dev:<file>`: không thiếu export nào. Re-export giữ nguyên cùng một instance `Set` của `NOT_SENT_CODES`. Các caller hiện có (`transcription-client.ts:19-28`, `commands/tts.ts`, các test openrouter) không phải sửa và vẫn typecheck. |
| 3 | Không có import cycle hay rò rỉ `node:*` | PASS | `http-body.ts` chỉ import `./errors.js` (mà `errors.ts` chỉ import `./redact.js`). `audio-kind.ts` không có import nào. Hướng phụ thuộc là provider -> core, nên không tạo cycle. Cả hai file đã được thêm vào `WORKER_SAFE_MODULES` (`worker-safe-http.test.ts:31-32`), và test đó pass. `worker/src` hiện không import các module này nên không bắt buộc chạy `check:mcp`. |
| 4 | Test mới có ý nghĩa và không flaky | PASS (có ghi chú) | Chạy 15 lần liên tiếp `tests/unit/core/http-body.test.ts`: 15/15 pass. Test idle 20 ms không thể flaky theo hướng pass sai: `streamOf(..., {hang:true})` không bao giờ close nên lần `read()` thứ hai treo vĩnh viễn và timer chắc chắn fire; máy chậm chỉ làm nó fire muộn hơn. Các test còn lại dùng idle 1000 ms với các read resolve ngay lập tức. |
| 5 | Quy ước AGENTS.md | PASS | Tên file kebab-case, conventional commit `refactor(core): …`, có `Closes #358`, không có ID plan hay finding trong code hoặc commit, không có `node:*` trong client. Repo không có REVIEW.md. |

Các lệnh đã chạy:
- `npm run lint`: 559 file, không có lỗi
- `npm run typecheck`: sạch
- `npx vitest run tests/unit/core tests/unit/providers/openrouter`: 23 file pass (2 file live bị skip), 469 test pass, 8 skip

## Phát hiện (theo mức độ)

### Critical / High / Medium
Không có.

### Low

**L1. `looksLikeMp3` và `sniffAudioKind` giờ nằm cùng file nhưng khác ngữ nghĩa**, `src/core/audio-kind.ts:105-110` và `:26-44`.
`looksLikeMp3` trả `true` cho mọi frame sync `0xFF Ex`, kể cả ADTS AAC (`0xFF 0xF1`). Với cùng dữ liệu đó, `sniffAudioKind` trả `"aac"`. Đây không phải thay đổi hành vi (code cũ đã như vậy), nhưng giờ đây là core API dùng chung. Người viết client Fish Audio sắp tới có thể chọn nhầm hàm và lưu AAC thành `.mp3`. Đề xuất cho một PR sau, không phải PR này vì acceptance yêu cầu không đổi hành vi: thêm vào doc comment câu "also true for ADTS AAC frame sync; use `sniffAudioKind` to tell them apart", hoặc đổi `looksLikeMp3` thành gọi `sniffAudioKind(bytes) === "mp3"` kèm test riêng.

**L2. Doc comment nhắc đến provider chưa tồn tại**, `src/core/http-body.ts:2-4`.
Comment liệt kê "Fish Audio" là caller, nhưng chưa có client Fish Audio trong repo. Đây là doc mang tính dự đoán: nếu client đó bị huỷ hoặc đổi tên, comment sẽ sai. Mức độ thấp. Có thể viết "provider clients that send paid, non-idempotent POSTs" mà không liệt kê tên.

**L3. Test mới chưa phủ một số nhánh**, `tests/unit/core/http-body.test.ts`.
Phần đã có kiểm tra hành vi thật: cap theo Content-Length, cap theo luồng byte, idle timeout, cắt giới hạn text, gom error code qua `cause` và `errors`. Phần chưa phủ:
- nhánh lỗi `"(could not read body)"` của `readCappedText` (`http-body.ts:50-52`)
- giới hạn độ sâu 4 của `errorCodes`
- `body == null` (trả về rỗng)
- việc `reader.cancel()` được gọi khi timeout hoặc vượt cap

Test idle cũng không kiểm tra reader đã được cancel. Vì đây là refactor và `speech-client.test.ts` đã phủ các luồng end-to-end, đây chỉ là ghi chú, không chặn merge.

**L4. Commit type `refactor` sẽ tạo bản npm mới khi merge vào `main`.**
Theo AGENTS.md, `refactor` có mục changelog hiển thị nên sẽ kích hoạt release. Việc này hợp lệ, nhưng nhóm cần biết trước rằng một refactor nội bộ sẽ tạo ra một release.

### Thông tin (có từ trước, không do PR này gây ra)
- `NOT_SENT_CODES` là một `Set` mutable được export. Giờ nhiều provider dùng chung một instance, nên một caller gọi `.add()` sẽ ảnh hưởng đến tất cả các caller khác. Hành vi này đã có trước PR. Nếu muốn có thể đổi kiểu thành `ReadonlySet<string>` trong một PR riêng.

## Edge case đã soát
- Instance identity của `NOT_SENT_CODES` và các re-export: được giữ nguyên (ES re-export là live binding).
- `ResponseTooLargeError` vẫn được import và dùng trong `speech-client.ts:17,191` (cho `instanceof`). Lớp này cùng nguồn `core/errors.js` với lớp mà `http-body.ts` throw, nên phép kiểm tra vẫn đúng.
- Timer của `readAudio` luôn được `clearTimeout` trong `finally`, và reader được cancel khi timeout, nên test hang không làm rò stream hay timer.

## Đánh giá kế hoạch
Issue #358 đã đạt cả ba acceptance criteria: không đổi hành vi, runtime-neutral, OpenRouter re-export cho caller cũ. Không có việc bắt buộc nào còn lại. L1 và L2 nên làm trong PR Fish Audio hoặc mở issue riêng.

## Câu hỏi còn mở
- Có muốn mở issue riêng cho L1 (ngữ nghĩa `looksLikeMp3` với AAC) trước khi bắt đầu client Fish Audio không?
