# Code review: eb5909e feat(runway): offline models listing and JSON-only status stdout (#242)

## Phạm vi
- 13 file, +274/-22. Nguồn: src/core/logger.ts, src/providers/runway/{models.ts,commands/{models,status,index}.ts}; test; worker/src/cli-catalog.json; docs (README, skill/SKILL.md, docs-site EN/VI).
- Đã chạy: `npx vitest run tests/unit/providers/runway tests/unit/core/logger.test.ts` (81 pass, 1 skip), `worker: vitest run test/cli-catalog.test.ts` (6 pass, bao gồm kiểm tra catalog == buildCliCatalog(program), tức là catalog đã sinh lại đúng), `npm run lint` (sạch), `npm run typecheck` (sạch).

## Đánh giá chung
Đúng phạm vi, nhỏ gọn, không có lỗi blocking. Các acceptance criteria đều đạt. Các lớp hardening vẫn còn nguyên: `summarizeTask` → `redactUrl`, `assertTaskId`, download (node-outputs) và image preflight không bị đụng tới. `createLogger({ stderr: true })` là thay đổi additive; mặc định vẫn ghi stdout như cũ.

## Phát hiện

### 1. SKILL.md khẳng định quá mức "always parses" (non-blocking, docs)
skill/SKILL.md: "`status` stdout is only the JSON summary (or the saved file list with `--download`) ... so `multix runway status <id> | jq` always parses."
Thực tế:
- `--download` in ra văn bản `\nSaved N file(s) from task ...:` (task-flow.ts `reportOutputs`), không phải JSON.
- `--wait` gặp FAILED/CANCELLED/timeout thì `completeTask` throw trước khi in gì, nên stdout rỗng.
Kịch bản lỗi: một agent đọc SKILL.md chạy `multix runway status <id> --wait --download | jq .` và gặp lỗi parse. Chỉ SKILL.md dùng chữ "always"; README và docs-site nói "parses even for a running task", vẫn đúng.
Sửa: "...so `multix runway status <id> | jq` parses without `--download`, including for a running task."

### 2. Contract của `--wait` khi task thất bại khác với one-shot (non-blocking, có từ trước)
One-shot `status` với FAILED in summary JSON (có `failure`, `failureCode`) rồi exit khác 0. `status --wait` kết thúc ở FAILED thì không in JSON, chỉ có lỗi trên stderr. Issue yêu cầu "stdout valid JSON ... including --wait": nhánh SUCCEEDED đạt. Nhánh failure thì stdout rỗng chứ không có JSON không hợp lệ, nên không vi phạm, nhưng script mất `failureCode`. Đây không phải regression của commit này. Có thể mở issue riêng nếu muốn đồng nhất: in `summarizeTask(final)` trước `assertSucceeded`.

### 3. Logger: warn/error vẫn chọn màu theo TTY của stdout (non-blocking)
`c()` đã nhận tham số `stream`, nhưng `warn` (console.warn) và `error` (console.error) vẫn gọi `c(...)` với stream mặc định là `process.stdout`. Kịch bản: `multix runway status <id> --wait 2>log.txt` trên terminal. stdout là TTY nên mã ANSI của warn/error bị ghi vào log.txt. Ngược lại, khi `| jq` thì warn/error trên terminal mất màu. Lỗi này có từ trước và ảnh hưởng mọi command, nhưng sửa một dòng là xong vì helper đã có sẵn: `c(ANSI.yellow, ..., process.stderr)`. Không chặn merge.

### 4. `runway models` chạy được từ xa qua Worker (non-blocking, chấp nhận được)
Lệnh không có trong `EXCLUDED_COMMANDS` và không có policy riêng, nên remote caller chạy được. Lệnh offline và chỉ đọc registry tĩnh, nên không tốn phí provider, không có đường dẫn file hay mạng, và không lộ dữ liệu. Có hai bất tiện nhỏ. Thứ nhất, `hasGroupKeys("runway")` buộc caller đã lưu RUNWAYML_API_SECRET mới chạy được. Thứ hai, mỗi lần chạy tốn một container job và quota cho dữ liệu tĩnh, và key vẫn được inject vào job dù lệnh không dùng. Cách làm này nhất quán với `leonardo models` / `elevenlabs models`. Không cần sửa. Nếu muốn tiết kiệm quota thì có thể thêm vào EXCLUDED_COMMANDS, nhưng đó là quyết định sản phẩm.

### 5. Hình dạng JSON của `models --json` (non-blocking, ghi chú contract)
Với `gen4_turbo`, key `textRatios` bị bỏ hẳn (spread một giá trị undefined), không phải `null`/`[]`. Consumer phải dựa vào `textToVideo: false`. Hành vi chấp nhận được và đã có test. Nên nói rõ trong docs nếu coi đây là contract ổn định. Ngoài ra JSON còn có `creditsPerSecond`/`credits`/`creditsVary` (giá niêm yết mang tính tham khảo). Commit message có nhắc tới, docs cũng nói "list price", khớp nhau.

### 6. Độ phủ test (non-blocking)
- Test giả định stdout là `console.log`. Hiện chưa có lời gọi `process.stdout.write` nào bị bỏ sót (đã grep node-outputs/client: chỉ dùng logger), nên vẫn chấp nhận được.
- Chưa có test cho `status --download` (SUCCEEDED) để khẳng định stdout chỉ có danh sách file, và "Saved <dest>" (logger.success) nằm trên stderr.
- logger.test chưa kiểm tra việc chọn TTY theo `stream`.

## Đối chiếu acceptance criteria
- `runway models [--json]` offline, lấy từ VIDEO_MODELS/IMAGE_MODELS: đạt. Có test xác nhận 0 request khi `RUNWAYML_API_SECRET=""`, JSON == `listRunwayModels()`, và id khớp đúng thứ tự registry.
- Hiển thị id, T2V/I2V, ratios, duration, giới hạn reference: đạt (prompt và giá là phần thêm, vô hại).
- stdout của `status` là JSON hợp lệ khi task chưa kết thúc và khi `--wait` thành công; progress/hint ra stderr: đạt (status.ts dùng `stderr: true`; `completeTask`/`reportOutputs` dùng logger được truyền vào).
- Không lộ signed URL hay secret: đạt (test đã kiểm tra cả SECRET lẫn SIGNED_TOKEN).
- `createLogger({ stderr: true })` opt-in, additive: đạt.
- Catalog đã sinh lại: đạt (test freshness pass).
- Docs EN/VI/README/SKILL: đạt, chỉ còn chỗ nói quá ở mục 1.

## Đề xuất
1. (Nên làm) Sửa câu "always parses" trong skill/SKILL.md.
2. (Tùy chọn) Truyền `process.stderr` cho warn/error trong logger.
3. (Tùy chọn, issue riêng) In summary JSON khi `--wait` kết thúc ở trạng thái thất bại.
