# Code review: commit 149c466 (issue #158, timeout cho smoke test spawn CLI)

## Phạm vi
- File: `tests/smoke/spawn-timeout.ts` (mới), `tests/smoke/parse-args.test.ts`, `tests/smoke/cli.test.ts`, `tests/smoke/library-entry.test.ts`
- LOC: +21 / -9
- Trọng tâm: commit gần nhất, chỉ đụng tới test
- Scout: đã grep mọi chỗ spawn `node`/`dist/cli.js` trong `tests/`. Chỉ 3 file smoke thực sự spawn. Hai file unit có nhắc `dist/cli.js` (`tests/unit/providers/env-file-model-defaults.test.ts`, `tests/unit/core/package-manager.test.ts`) nhưng chỉ dùng nó làm chuỗi hoặc comment, không spawn, nên giữ timeout mặc định là đúng. Hằng `15_000` còn lại ở `tests/unit/providers/atlascloud/client.test.ts:366` không liên quan (timeout HTTP của client).

## Đánh giá chung
Thay đổi nhỏ, đúng phạm vi issue, không đụng `vitest.config.ts` nên unit test vẫn chạy với timeout 5 s mặc định. Không có lỗi chặn merge.

## Tính đúng đắn
1. **Timeout theo describe có áp dụng cho mọi test spawn không:** có. Trong `parse-args.test.ts` chỉ có 2 lời gọi `it(` và cả hai nằm trong describe đã gắn `{ timeout: SPAWN_TIMEOUT }` (dòng 73, 82). Không có hook (`beforeAll`/`beforeEach`) nào spawn process, nên `hookTimeout` (10 s) không bị ảnh hưởng. Vitest 4.1.11 hỗ trợ cú pháp `describe(name, { timeout }, fn)`, và repo vốn đã dùng cú pháp này ở `cli.test.ts`.
2. **Child bị kill trước khi test hết giờ:** `run()` mới trong parse-args truyền `timeout: CHILD_TIMEOUT` (29 s). Trước commit này child không có timeout nào, nên đây là một cải thiện (một CLI bị treo giờ sẽ không sống lâu hơn test). Khi timeout, `reject: false` trả về `exitCode` là undefined, và `expect(...).toBe(0)` sẽ báo lỗi rõ ràng.
3. **`6 * SPAWN_TIMEOUT` (`cli.test.ts:205`):** ngân sách test tăng từ 90 s lên 180 s, gồm 6 lần spawn tuần tự, mỗi child bị kill ở 29 s. Trường hợp xấu nhất là 6 × 29 = 174 s < 180 s, nên tính chất "child bị kill trước khi test timeout" vẫn giữ. Ở happy path thời gian chạy không đổi. Hệ quả duy nhất: khi CLI thật sự bị treo, test này cần tới khoảng 3 phút mới fail (trước đây khoảng 1,5 phút). Chấp nhận được.
4. **Deadline poll stdin `SPAWN_TIMEOUT / 2` (`cli.test.ts:263`):** deadline tăng từ 7,5 s lên 15 s. Child bị kill ở 29 s tính từ lúc spawn, nên sau deadline còn khoảng 14 s cho child đọc EOF và thoát (trước đây chỉ còn 14 − 7,5 = 6,5 s). Tổng thời gian vẫn nhỏ hơn timeout của test (30 s). Tỉ lệ thời gian dư thực ra tốt hơn trước. Vòng poll thoát sớm ngay khi thư mục tạm xuất hiện hoặc child thoát, nên happy path không chậm thêm. Nếu đã hết deadline mà thư mục vẫn chưa xuất hiện, `expect(dirsWhileReading).toHaveLength(1)` sẽ fail với thông báo rõ ràng.
5. **`library-entry.test.ts`:** chỉ thay hằng, logic không đổi.

## Vấn đề riêng trên Windows
- `execa("node", ...)` trên Windows tìm `node` qua PATH, giống cách các smoke test hiện có đang chạy trên CI Windows.
- Khi timeout, execa kill child. Trên Windows việc này tương đương TerminateProcess. CLI chạy `--help` không sinh process con, nên không lo sót process cháu.
- Mức 30 s nằm trong khoảng 20 đến 30 s mà issue đề xuất.

## Quy ước repo (AGENTS.md)
- Commit `test(smoke): ...` theo đúng conventional commit, có `Closes #158`, và không kích hoạt release (type `test` không có mục changelog). Phù hợp.
- File mới đặt tên kebab-case. Nó không có hậu tố `.test.ts` nên không bị `include` của vitest nhặt nhầm thành test.
- Comment giải thích mục đích (cold start trên Windows, tránh tăng `testTimeout` toàn cục) và không chứa mã plan hay audit. Phù hợp với rule "stable code artifacts".
- `npx biome check tests/smoke`: 5 file, sạch.
- Issue đang ở nhãn `in review`, đúng với giai đoạn hiện tại.

## Critical / High
Không có.

## Medium
Không có.

## Low / thông tin (không chặn merge)
- `tests/smoke/cli.test.ts:11` import `beforeAll` nhưng không dùng. Lỗi này **đã có từ trước** commit này (có ở `400f6b4`), Biome 1.9 không bắt. Nằm ngoài phạm vi, có thể dọn trong một PR chore riêng.
- Nhánh hiện tại là `claude/inspiring-wright-qc3nw5`, không theo mẫu `fix/<scope>-<slug>` / `chore/<slug>` của AGENTS.md. Có thể là tên do harness đặt. Nếu được thì nên đổi tên trước khi mở PR, không ảnh hưởng tới code.
- Thông điệp commit nói "kill each child just before its test times out". Điều này đúng với mọi test, kể cả test 180 s, vì test đó cũng gọi `run()` với 29 s cho mỗi child.

## Kiểm chứng đã chạy
- `npx vitest run tests/smoke`: 3 file, 96 test pass (14,5 s).
- `npx biome check tests/smoke`: không có lỗi.
- Dựa vào kết quả tác giả báo cáo cho lint, typecheck, build và toàn bộ `npm test` (1156 pass). Tôi không chạy lại các bước này.

## Câu hỏi còn mở
Không có.

Status: DONE
Summary: Commit 149c466 áp timeout 30 s cho mọi test spawn trong parse-args và kill child ở 29 s. Phép tính deadline trong cli.test.ts (6×30 s, poll 15 s) vẫn giữ được bất biến "child chết trước khi test timeout". Unit test giữ timeout mặc định. Smoke test và Biome đều sạch.
Concerns/Blockers: Không có blocker. Hai lưu ý nhỏ: `tests/smoke/cli.test.ts:11` có import `beforeAll` thừa (đã có từ trước, ngoài phạm vi), và tên nhánh không theo quy ước AGENTS.md.
