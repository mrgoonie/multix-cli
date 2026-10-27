# Review: CANCELLED cho exit 129/130/143 (issue #375)

Commit 30f9f32 trên claude/gracious-heisenberg-13hxw2, diff `origin/dev...HEAD` (8 file, +93/-13).

## Kiểm chứng
- `npm run typecheck`: pass. `npm run lint`: sạch. `npm run build`: pass.
- `npx vitest run tests/unit/core/error-classify.test.ts tests/smoke/media-quality.test.ts tests/smoke/agent-mode.test.ts`: 29/29 pass (có ffmpeg, nên các test tín hiệu thực sự chạy).
- `npm test` đầy đủ: 2249 pass, 22 skip, 0 fail.

## Tính đúng của exitCode trong finalizeRun (agent-runtime.ts:230-231)
Cũ: `!failed ? 0 : (!json || UNKNOWN) ? input.exitCode||1 : info.exit_code ?? 1`.
Mới: `!failed ? 0 : json ? (UNKNOWN ? input.exitCode||1 : info.exit_code ?? 1) : input.exitCode||1`.
Hai biểu thức tương đương trên mọi nhánh (plain, json+UNKNOWN, json+đã phân loại, đường error). Với CANCELLED, exit_code = chính mã signal nên json giữ 129/130/143. Không có hồi quy.
Thay đổi hành vi duy nhất ngoài CANCELLED: dòng text `code: UNKNOWN (exit N with --json)` giờ in đúng N = input.exitCode||1 thay vì luôn 1 (vd leonardo `process.exit(2)` không có dòng lỗi nhận dạng được). Đây là sửa lỗi, khớp với exit thật ở --json.

## Exit 129/130/143 không do signal?
Đã grep mọi `process.exit(`/`process.exitCode =` trong src: chỉ `cancellable` (media-quality-commands.ts:47-82) và `handleInterrupt` (atlascloud output-claims.ts:207-217) phát ra 129/130/143, đều do signal. `multix rerun` (history-command.ts:261) truyền status của tiến trình con nhưng đặt `run.finalized = true` nên finalizeRun trả về ngay, không phân loại lại. Không tìm thấy đường hợp lệ nào bị phân loại sai.
stdin-file.ts re-raise signal (`process.kill(pid, signal)`) nên tiến trình chết bởi signal, không có envelope; không bị diff ảnh hưởng (và cũng không được phủ).

## worker/
Không có gì trong worker/ liệt kê `ErrorCode` của CLI (worker có `ApiErrorCode` riêng). `ErrorCode` là union thuần TS; `HINTS`/`EXIT_BY_CODE` là `Record<ErrorCode,...>` nên tsc buộc phải thêm đủ, đã thêm.

## Findings

1. [nên sửa, không chặn] Hint "nothing was left behind. Rerun the command." sai trong đường atlascloud và có thể gây trả tiền hai lần.
   - src/core/error-classify.ts:97; docs for-ai-agents.md:112 (EN+VI); skill/SKILL.md ("cleaned up; rerun").
   - Kịch bản: `multix atlascloud <video> --json`, prediction trả phí đã `succeeded`, đang tải output thì agent giám sát gửi SIGTERM (hoặc user Ctrl-C). `tryLock` đã cài `handleInterrupt` -> dọn file tạm -> exit 143 -> envelope `CANCELLED`, hint "Rerun the command", `next[]` rỗng (nextForError rơi vào default). Agent làm theo -> submit lại job trả phí, trong khi chỉ cần resume/tải lại theo prediction id. Với job nhiều output, file đã tải xong trước đó vẫn còn trên đĩa (lock đã release), mâu thuẫn với "nothing was left behind" và với `outputs[]` không rỗng trong cùng envelope.
   - Trước đây là UNKNOWN cũng gợi ý rerun, nên không phải hồi quy, nhưng diff biến khẳng định thành mạnh và chính thức hơn. Văn bản hint do issue chỉ định nguyên văn, nên đây là quyết định của người viết issue: hoặc làm mềm hint/docs ("local temp files were removed; if a paid job was already submitted, resume it instead of resubmitting"), hoặc khi `run.ids` không rỗng thì đẩy lệnh status/resume vào `next[]`. Nếu giữ nguyên, nên mở issue riêng.

2. [nit] `multix guide` (src/commands/agent/guide-command.ts:26-29) — tài liệu giao thức cho agent mà SKILL.md trỏ tới — không nhắc CANCELLED/129/130/143. Agent đọc guide sẽ không biết lớp exit này.

3. [nit] `EXIT_CODES.cancelled: 130` (error-classify.ts:50) là giá trị giả: CANCELLED chỉ được tạo qua `classifySignalExit`, luôn ghi đè `exit_code`. Nếu sau này có ai `build("CANCELLED", ...)` từ một error (vd AbortError) sẽ nhận 130 kể cả khi signal là SIGTERM. Chấp nhận được, nhưng comment nên nói rõ đây là mặc định.

4. [nit] `retryable: false` hợp lý (hủy là chủ ý của người dùng/supervisor; tránh agent tự động retry vòng lặp khi chính nó kill tiến trình do timeout). Tuy nhiên hint "Rerun the command" hơi ngược với `retryable: false`; chấp nhận được vì hint là lời khuyên cho người, không phải tín hiệu tự động.

5. [nit, có từ trước] README/docs nói "plain runs keep exit 1", thực tế plain giữ `input.exitCode||1` (vd 2 từ leonardo). Diff thêm ngoại lệ cho cancelled nhưng câu gốc vẫn chưa chính xác hoàn toàn; ngoài phạm vi.

## Docs
EN và VI khớp nhau và khớp code (129/130/143, CANCELLED, giữ exit ở cả hai mode). README câu "(`CANCELLED`, also in plain runs)" đúng: plain mode trước đây cũng đã exit 130, nay in thêm `code: CANCELLED (exit 130 with --json)`. Ngoài finding 1 (khẳng định "nothing was left behind"), không thấy sai lệch.

## Test
Test unit bao phủ cả mã âm (0,1,2,6,128,131,137). Smoke SIGTERM kiểm tra envelope, exit, và dọn thư mục staging: test thật, không phải phantom. Thiếu test cho SIGHUP qua finalizeRun và cho dòng text UNKNOWN mới (exit N != 1); không chặn.

## Re-review: commit fa78500

Phạm vi: `run.requestsStarted` (run-state.ts, fetch-telemetry.ts), `classifySignalExit(exitCode, providerContacted)`, wiring trong `finalizeRun`, dòng guide, docs EN/VI, SKILL.md, test mới `tests/unit/agent/finalize-run-cancel.test.ts`.

Kiểm chứng: typecheck pass, lint sạch (595 file), build pass, 8 file test liên quan 58/58 pass, `npm test` đầy đủ 2251 pass / 22 skip / 0 fail.

- Finding 1 đã xử lý. `requestsStarted++` đặt sau nhánh dry-run (dry-run không bị đếm) và trước `await original(...)`, nên tính cả request đang bay hoặc thất bại. Đây là hướng an toàn cho một POST bị ngắt giữa chừng. `run.externalRuns` phủ Codex driver. Không có client nào gọi HTTP qua `node:http(s)` hay giữ `fetch` từ lúc import, nên không có đường bỏ sót bộ đếm (đã grep).
- Finding 2 đã xử lý: guide có dòng `exit 129/130/143 CANCELLED ...`.
- Finding 3 đã xử lý: comment `Default only` trên `EXIT_CODES.cancelled`.
- Docs EN/VI và SKILL.md khớp với code và khớp nhau.
- Test mới là test thật: nạp lại module, chặn `fs.writeSync` trên fd 1 và kiểm tra cả hai nhánh hint qua `finalizeRun`.

Nit (không chặn):
- Bộ đếm tính mọi fetch, kể cả GET không tính phí (vd đọc catalog model trước khi submit), nên có thể hiện hint "pay twice" thừa. Thừa theo hướng an toàn thì chấp nhận được.
- Hint bảo "check provider_ids", nhưng nếu signal đến khi POST submit còn đang bay thì `provider_ids` rỗng. Hint đã có vế "or the provider's request list" nên vẫn dùng được.
- Commit fa78500 đã đưa file report này vào git; phần Re-review này sẽ là thay đổi chưa commit.

Kết luận re-review: không có finding chặn.
