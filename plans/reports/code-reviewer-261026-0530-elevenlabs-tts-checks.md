# Code review: ElevenLabs TTS checks (#314), commit 1f853e3

Branch `claude/gracious-heisenberg-akemad`, base `main`. Reviewed 2026-10-26 (UTC).

## Phạm vi
- Source: `src/providers/elevenlabs/{models.ts,tts-request.ts,commands/tts.ts}` (client.ts không đổi, đã đọc `saveBytes`/`apiPostBinaryWithHeaders`)
- Tests: `tests/unit/providers/elevenlabs/{tts-request,tts-command,live}.test.ts`
- Docs: README.md, docs-site EN + VI `commands/elevenlabs.md`, `skill/SKILL.md`, `worker/src/cli-catalog.json`
- ~370 dòng thêm / 67 dòng xoá

## Kiểm chứng đã chạy
- `npm run lint`: sạch (503 file)
- `npm run typecheck`: sạch
- `npx vitest run tests/unit/providers/elevenlabs`: 83 pass, 4 skip (live)
- `worker: npx vitest run test/cli-catalog.test.ts`: 6 pass (catalog khớp CLI)
- Không chạy live test.

## Đánh giá chung
Không có lỗi blocker. Bảng capability khớp đúng các fact live đã đo (clone_strength chỉ v4/v4 Turbo; `<break>` bị bỏ qua trên v4, v4 Turbo, v3, v3_conversational; `<phoneme>` mất từ trên multilingual_v2, flash_v2_5, turbo_v2_5). Body mặc định (eleven_multilingual_v2) không đổi vì `clone_strength` chỉ được thêm khi người dùng truyền; model lạ vẫn đi qua không kiểm tra. `tts-request.ts` không import `node:*`, không log key. Các phát hiện dưới đây chủ yếu là docs chưa chính xác và vài edge case.

## Critical
Không có.

## High
Không có.

## Medium

### M1. Docs nói "emoji ... chỉ tính một", sai với cách code đếm và vượt quá fact đã đo
- `docs-site/src/content/docs/commands/elevenlabs.md:57-58` ("so an emoji or other astral character counts once"), `docs-site/src/content/docs/vi/commands/elevenlabs.md:56-57` ("nên emoji hay ký tự astral khác chỉ tính một").
- Code đếm code point (`[...text].length`, `tts-request.ts:73`). Nhiều emoji là nhiều code point: `👍🏽` = 2, `🇻🇳` = 2, `👨‍👩‍👧` = 5 (đã kiểm bằng node). Fact live chỉ xác nhận một ký tự CJK astral được tính một lần; chưa ai đo emoji.
- Kịch bản: người dùng đọc docs, ước tính 10.000 emoji cờ vừa giới hạn v4, CLI báo 20.000 ký tự và từ chối; hoặc ước tính credit sai.
- Sửa: viết "counts in code points, so an astral character such as 𠀀 counts once (an emoji built from several code points, e.g. a flag or skin-tone emoji, counts each one)" và dịch tương ứng sang VI. Hoặc bỏ chữ "emoji".

### M2. Câu mới về Flash/Turbo và `--style` không có bằng chứng
- `docs-site/src/content/docs/commands/elevenlabs.md:54-55` "(Flash/Turbo accept it and bill for audio that ignores it)", VI `:53-54` "(Flash/Turbo vẫn nhận và tính phí cho audio bỏ qua nó)".
- Comment trong `models.ts:41-53` chỉ ghi v4/v4 Turbo nhận style mà bỏ qua, và v3 trả 400. Không có fact nào (trong commit, comment hay task context) về hành vi của Flash/Turbo v2.x với `style`. Đây là khẳng định hành vi API mới đưa vào docs mà không có nguồn — đúng kiểu câu "nghe chắc chắn" cần kiểm.
- Kịch bản: nếu thực tế Flash/Turbo trả 400 (như v3), docs giải thích sai lý do từ chối; nếu là v4 thì bị bỏ sót.
- Sửa: hoặc ghi nguồn đo vào comment `models.ts` (ngày, model, kết quả), hoặc đổi thành lý do đã kiểm chứng: "(v4 and v4 Turbo accept it and ignore it; v3 answers 400)".

### M3. Lỗi `--timestamps` không báo credit đã bị tính
- `src/providers/elevenlabs/commands/tts.ts:114-121` ném `ProviderError` trước khi đọc header `character-cost` (`:149-152`). Comment nói rõ "The request was billed", README dòng 538 nói "After each TTS run the CLI prints the credits".
- Kịch bản: response 200 không có `audio_base64`; người dùng chỉ thấy file `.bin`, không biết bị trừ bao nhiêu credit. Với `--json`, `usage.credits` cũng không có.
- Sửa: đọc `res.headers.get("character-cost")` trước và thêm vào thông báo lỗi, ví dụ `...; raw response saved to ${raw}; credits charged (character-cost): ${charged}` khi header có giá trị.

## Low

### L1. `audio_base64` không phải string làm vỡ đường lưu raw
- `tts.ts:114,123`: điều kiện chỉ là `!parsed?.audio_base64`. Nếu body là `{"audio_base64": 123}` hoặc object, `Buffer.from(123, "base64")` ném `TypeError` (đã kiểm), raw body không được lưu, thông báo lỗi khó hiểu — chính trường hợp mà tính năng này muốn che.
- Sửa: `if (typeof parsed?.audio_base64 !== "string" || parsed.audio_base64 === "")`.

### L2. Comment `VOICE_ID` không khớp regex
- `tts-request.ts:38-39`: comment "voice IDs are 20 letters and digits" nhưng regex là `/^[A-Za-z0-9_-]{1,64}$/`. Chọn regex rộng hơn để tránh từ chối nhầm là hợp lý (vẫn chặn `.`, `..`, `a b`, `/`, `%`), nhưng comment nên nói thẳng là cố ý rộng: "Live IDs are 20 alphanumerics; this deliberately also allows `_`/`-` and up to 64 so an ID format change is not rejected, while keeping `.`/`..`/`/` out of the URL path."

### L3. SKILL.md bỏ sót `eleven_turbo_v2_5` cho `<phoneme>`
- `skill/SKILL.md:416`: "<phoneme> drops the word on multilingual_v2/Flash v2.5". Bảng capability và README/docs ghi cả Turbo v2.5. Agent đọc SKILL.md sẽ chọn turbo_v2_5 để tránh vấn đề phoneme mà không có cảnh báo trong tài liệu (CLI vẫn cảnh báo khi chạy).
- Sửa: "on multilingual_v2 and Flash/Turbo v2.5".

### L4. File raw có đuôi `.bin` và log kiểu "success"
- `tts.ts:116`: `saveBytes` gọi `logger.success("Saved: ...")` ngay trước khi ném lỗi, nên người dùng thấy dòng thành công rồi lỗi. Trường hợp "carried no audio" là JSON hợp lệ nhưng vẫn lưu `.bin`.
- Sửa (tuỳ chọn): bỏ `logger` khi lưu raw (thông báo lỗi đã nêu đường dẫn), và dùng `ext: parsed === undefined ? "bin" : "json"`; cập nhật docs EN/VI/README tương ứng nếu đổi.

### L5. Thứ tự kiểm tra `--clone-strength`
- `tts-request.ts:116-121`: phạm vi được kiểm trước model. `--model eleven_v3 --clone-strength 5` báo "must be a number from 0 to 1", sửa xong lại bị "does not accept". Nhất quán với `--style` nên chỉ là UX; có thể kiểm model trước.

### L6. Echo nguyên giá trị `--voice` trong lỗi
- `tts-request.ts:62`: giá trị không hợp lệ (có thể chứa ký tự điều khiển/ANSI) được in nguyên. Rủi ro thấp (input do chính người dùng đưa vào), có thể dùng `JSON.stringify(voice)` thay cho `"${voice}"`.

## Thiếu test
- Không có test cho body `null`, `"audio_base64": ""`, hoặc `audio_base64` không phải string (liên quan L1).
- Không có test command-level cho cảnh báo `<phoneme>` (chỉ có ở unit `buildTtsRequest`); chấp nhận được.
- Live smoke v4/v4 Turbo nay luôn gửi `cloneStrength: "0"` (`live.test.ts:45`), nên đường body không có `clone_strength` của v4 không còn được kiểm live. Nên giữ một lượt không có `clone_strength` (vd v4 Turbo) và một lượt có (v4).
- `checkVoiceId` không có case `"%2e%2e"` hay ký tự Unicode; regex đã chặn, chỉ là thiếu test hồi quy.

## Edge case đã scout và kết luận không có lỗi
- Body mặc định `eleven_multilingual_v2`: không đổi (test `toEqual` hiện có vẫn pass).
- Model lạ: `clone_strength` được gửi không kiểm tra, có cảnh báo; không có cảnh báo SSML (đúng chính sách "không kiểm tra").
- `<breakfast>` không bị nhận nhầm (`\b`); `a < b > c` không cảnh báo (có test).
- Voice mặc định `kdmDKE6EkgrWrrykO9Qt` qua được `checkVoiceId`.
- `checkVoiceId` chỉ được dùng ở `tts`; các lệnh elevenlabs khác đưa voice ID vào URL (voice changer, voices get/delete...) không được kiểm. Ngoài phạm vi #314 — theo AGENTS.md nên mở issue riêng nếu muốn mở rộng.
- `worker/src/cli-catalog.json` khớp CLI (test catalog pass). Worker không import `tts-request.ts`, nên `check:mcp` không bắt buộc.
- EN và VI đồng nhất về nội dung (bảng, danh sách quy tắc, đoạn raw `.bin`), ngoại trừ cùng hai lỗi M1/M2 xuất hiện ở cả hai.

## Đối chiếu yêu cầu #314
| Yêu cầu | Trạng thái |
|---|---|
| `--clone-strength` cho v4/v4 Turbo | Xong, đúng fact (0..1, từ chối model khác) |
| Kiểm voice ID trước request | Xong (regex rộng hơn fact, xem L2) |
| Đếm độ dài theo code point | Xong; docs diễn giải emoji sai (M1) |
| Cảnh báo SSML | Xong, bảng khớp fact; SKILL.md thiếu turbo_v2_5 (L3) |
| Lưu raw body khi `--timestamps` không có audio | Xong; thiếu credit trong lỗi (M3), edge non-string (L1) |
| Chính sách `--style` (giữ reject) | Giữ reject; câu giải thích mới chưa có nguồn (M2) |

## Hành động đề xuất (theo thứ tự)
1. Sửa câu emoji ở docs EN + VI (M1).
2. Bỏ hoặc dẫn nguồn câu Flash/Turbo `--style` ở EN + VI (M2).
3. Thêm `character-cost` vào lỗi `--timestamps` (M3).
4. Kiểm `typeof audio_base64 === "string"` + test (L1).
5. Sửa SKILL.md thêm Turbo v2.5 (L3) và comment `VOICE_ID` (L2).

## Câu hỏi chưa giải quyết
- Câu "Flash/Turbo accept it and bill for audio that ignores it" có được đo live không? Nếu có, nên ghi vào comment `models.ts` như các fact khác.
