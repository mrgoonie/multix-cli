# Re-review PR #320: feat(scene) voice profiles, scene manifests, selective take rendering

Reviewer độc lập, read-only. Ngày 2026-10-26. Head `355ad4c`. `origin/main` = `c06e0b6` (release 1.20.0) là ancestor của head. Report trước: `code-reviewer-261026-1750-pr-320.md`.

## Kiểm chứng đã chạy (worktree tạm, đã xoá)
- `npm ci`, `npm ci --prefix worker`: OK.
- `lint`: 545 file, sạch. `typecheck` 0 lỗi. `build` OK.
- `npm test` lần 1: 1 fail. Test `scene render > re-renders only the edited line…` timeout 5000ms (import 52s, máy đang tải nặng). Lần 2: 1839 pass / 18 skip, 0 fail. Chạy riêng 3 lần scene + capabilities: 58/58 pass. Riêng test đó mất ~1.6s → flaky khi máy tải nặng, không phải lỗi logic.
- `check:mcp`: worker 380 pass, bundle sạch.
- `npm run catalog --prefix worker`: `cli-catalog.json` không đổi.
- Chưa chạy `verify:docs`: docs-site chưa `npm ci`.
- Chạy `dist/cli.js` với key giả và fake fetch, không gọi API thật:
  - `voice add --provider elevenlabs --model eleven_multilingual_v2 --language vi` → bị từ chối, "nothing was billed".
  - `scene render --max-cost 1` → `BUDGET_UNPROVEN`. Spend guard #327 không bị bypass.
  - `models --task speech` → có row `scene render`, `ready:true`, `keys:["GEMINI_API_KEY|OPENAI_API_KEY|ELEVENLABS_API_KEY"]`.
- Đã chạy probe `chunkText`/`partErrors`/`unclosedMarkup` qua esbuild với các case: tiếng Việt, CJK, "Mr.", "e.g.", "3.5", `x < y`, `a<b`, `<john@x.com>`, `[1, 2]`, `[laughs][sighs]`.

## (a) Hai finding chặn cũ

### 1. Language trên ElevenLabs: ĐÃ SỬA
- `speech-adapters.ts:207` dùng `language: caps?.languageCode ?? false`, đã bỏ list hardcode.
- `:234-239` từ chối language trên model có caps mà `languageCode=false` (multilingual_v2). Thông báo lỗi liệt kê các model có enforce.
- `requestParams` (`:268`) đưa `language_code` vào cache key. Commit message có ghi rằng take cũ bị invalidate một lần.
- Regression test: `scene.test.ts:539-548` (v4 + `vi-VN` → `language_code: "vi"` trong params và payload), `:551` (multilingual_v2 bị từ chối).
- Gemini/OpenAI không có tham số language. Docs EN ghi rõ "keep the language for reference only" (`docs/commands/scene.md:196-201`) → chấp nhận.

### 2. chunkText cắt vỡ markup: ĐÃ SỬA
- `script-parser.ts:99` TOKEN coi `<…>` và `[…]` là token không bị cắt. Dấu `.!?…` chỉ kết thúc câu khi đứng trước khoảng trắng hoặc ở cuối line (`:120-125`), nên "3.5" và `time="1.5s"` còn nguyên. `。！？` vẫn ngắt câu.
- `scene-manifest.ts:267-289` `partErrors` kiểm tra từng part:
  - tag không đóng
  - part vượt limit (tag dài hơn limit)
  - tập tag sau khi chia khác tập tag ban đầu
- `scene-manifest.ts:365-366` gọi `partErrors` trong `planScenes`.
- Giới hạn ký tự: `add()` không bao giờ vượt `maxChars`. Chỉ một tag đơn lẻ dài hơn limit mới vượt, và trường hợp đó bị `partErrors` báo lỗi. Probe: mọi part ≤ limit, không mất ký tự.
- Regression test: `scene.test.ts:443-505`, gồm "never cuts a tag or a decimal", "rejects split parts…", "keeps a v3 audio tag whole".
- Từ chối nhầm văn bản hợp lệ: `unclosedMarkup` nay chạy cả trên line không bị chia. Kết quả probe:

  | Văn bản | Kết quả |
  |---|---|
  | `a<b`, `[Note` (không đóng) | bị từ chối |
  | `I <3 you`, `a<b và c>d`, `[1, 2]`, `[sic]`, `x < y` | qua |

  Hai case bị từ chối hiếm gặp trong lời thoại, và provider vốn sẽ đọc to chúng → chấp nhận được.

## (b) Diff so với main
- `origin/main` là ancestor của head. 3-dot diff chỉ chạm các file của PR. Số dòng bị xoá:

  | File | Dòng xoá |
  |---|---|
  | `llms.txt.ts` | 1 (thêm entry) |
  | `SKILL.md` | 1 (description) |
  | `capability-registry.test.ts` | 1 (import `vi`) |
  | `gemini/generators/speech.ts` | 40 (refactor) |

- Refactor `gemini/generators/speech.ts` tách `synthesizeGeminiSpeech` (throw) khỏi `generateGeminiSpeech` (bắt lỗi rồi trả `{status:"error"}`). Hành vi của `gemini generate-speech` giữ nguyên.
- Không đảo code của main:
  - registry #317: `command-capabilities.ts` chỉ thêm dòng.
  - openrouter transcribe #328: không bị chạm.
  - budget #327: không bị chạm, và đã xác nhận `BUDGET_UNPROVEN` ở trên.
- SKILL.md vẫn `version: 1.20.0 # x-release-please-version`, khớp main.
- Commit a027e3d (session khác) chỉ là merge main, không thấy mất gì.

## (c) Phân loại scene và ready
- `scene render` = `fixed(["speech"], ["audio"])`. 8 subcommand còn lại nằm trong `UTILITY_COMMANDS`. Đủ 9 leaf, test "mọi leaf đã phân loại" pass.
- Worker: cả 9 lệnh nằm trong `EXCLUDED_COMMANDS`. `catalog-view.runnable()` lọc trước khi xét capability, nên MCP không quảng cáo `scene render`.
- `GROUP_KEY_ROWS.scene` gồm một row với 3 lựa chọn (OR):
  - Trước đây group `scene` không có row → `groupReady` luôn true, sai.
  - Nay ready khi có ít nhất một trong 3 key. Đúng với ngữ nghĩa row, khớp cách viết `gemini: [["GEMINI_API_KEY"]]`.
  - Đánh đổi: ready=true không bảo đảm có đúng key của profile, comment đã nói rõ, và `render` tự preflight key. Hợp lý.
- Có test: `capability-registry.test.ts:68-82` (không có key → false; có OpenAI → true).

## Blocking
none

## Non-blocking
1. **Part chỉ chứa tag, tag tách khỏi phần text nó điều khiển** (`script-parser.ts:146-155` `wordsOf`, `:186-200`).
   - Probe:
     - `max 30`: `"[sighs heavily and slowly] Fine. …"` → part 1 = `"[sighs heavily and slowly]"`.
     - `max 20`: `'Đi <break time="1s"/> thôi…'` → `["Đi", '<break time="1s"/>', …]`.
     - `"[laughs][sighs]"` tự thành một part riêng.
   - Hậu quả: thành một request trả phí không có text đọc được, và tag mất ngữ cảnh. Test `scene.test.ts:497` còn khẳng định hành vi này.
   - Chỉ xảy ra khi line vượt limit. Limit của model là 4k–40k, `max_chars` là opt-in → xác suất thấp.
   - Fix đề xuất:
     - Trong `wordsOf`, gắn tag đứng đầu vào word kế tiếp (và gắn `<break/>` vào word trước).
     - Thêm vào `partErrors` lỗi "part has no speakable text" khi `part.replace(tags,"").trim()===""`.
     - Sửa expectation ở test `:497`.
2. **Test flaky dưới tải**: `scene.test.ts:145` mất ~1.6s, timeout 5s khi suite chạy song song trên máy bận. Nên đặt timeout riêng (`it(…, 20_000)`) hoặc giảm số render trong test.
3. `profile.language.split("-")[0]`: tag như `zh-Hans` → `zh` là ổn. Tag 3 ký tự (`fil`) phụ thuộc API (API trả 400, không bị tính tiền). Không cần sửa.
4. Các mục non-blocking của report trước chưa xử lý và vẫn còn hiệu lực. Nên mở issue follow-up:
   - `--max-cost`/`--estimate` vô nghĩa trên các subcommand local
   - receipt `provider:"scene"`
   - retry line `failed` có thể đã bị tính tiền
   - `scene.script` trỏ ra ngoài project
   - scene id phân biệt hoa/thường
   - `EMPTY_OUTPUT` bị push 2 lần
   - `JSON.parse` không có try trong `voice add --force`
   - `index.ts` 581 dòng
5. Message `cost of scene  is unknown` có hai dấu cách (text của #327 trên main, không thuộc PR).
6. Chưa chạy `verify:docs` trong review này. Docs EN/VI đã đổi, CI cần chạy.

## Câu hỏi mở
- Có muốn chặn part chỉ chứa tag ngay trong PR này không (rẻ, 10–20 dòng), hay để follow-up?
