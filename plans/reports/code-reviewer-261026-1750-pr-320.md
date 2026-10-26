# Review PR #320 — feat(scene): voice profiles, scene manifests, selective take rendering (Closes #297)

Reviewer: code-reviewer độc lập (không viết code). Ngày 2026-10-26. Head `9e8672a`, merge-base với main `f9a84c7`.

## Phạm vi
- 22 file, +3986/-43. Lõi: `src/commands/scene/{index,scene-manifest,scene-render,script-parser,speech-adapters,voice-profile}.ts`, refactor `src/providers/gemini/generators/speech.ts`, docs EN/VI, `skill/SKILL.md`, worker catalog + `EXCLUDED_COMMANDS`.
- Main sau merge-base: #319 (clone-strength, `languageCode`/`ssmlBreak`/`ssmlPhoneme` caps, `checkVoiceId`), #276, #326, #327 (budget/spend guard), #331.

## Kiểm chứng đã chạy (trial merge `pr-320` vào `origin/main` trong worktree tạm, đã xoá)
- Conflict duy nhất: `skill/SKILL.md` (frontmatter: description + version).
- Sau khi resolve: `tsc --noEmit` 0 lỗi; biome sạch; build OK; `vitest run` 103 file pass / 7 skip, 1757 test pass; `check:mcp` 378 pass, bundle sạch; regenerate `worker/src/cli-catalog.json` không đổi.
- Chạy tay `dist/cli.js` với fake fetch (`tests/smoke/fixtures/fake-speech-fetch.mjs`):
  - `scene render --dry-run`: dừng ở request đầu, exit 0, manifest không ghi lỗi.
  - `scene render --estimate`: "unknown (unsupported)", 0 fetch.
  - `scene render --max-cost 5 --cost-policy estimate`: BUDGET_UNPROVEN, 0 fetch → spend guard #327 **không bị bypass** (fail-closed).
  - render thật: 2 fetch cho 2 line; history không chứa script text hay key.
  - Profile `eleven_v4 --language vi` → manifest `params` không có `language_code` (xác nhận finding 1).
- `chunkText` với `max_chars` 40 cắt đôi `<break time="1.5s" />` và `[sighs heavily and slowly]` (xác nhận finding 2).

## Semantic conflict với main
- PR không gọi `buildTtsRequest`/`checkVoiceId`, nó tự dựng payload ElevenLabs → không gãy compile, nhưng **lệch capability**: `ELEVENLABS_LANGUAGE_MODELS` hardcode 3 model, trong khi `ttsModelCaps().languageCode` trên main (#319) = true cho v4, v4_turbo, v3, v3_conversational, flash_v2(_5), turbo_v2(_5).
- `ssmlBreaks = !caps.audioTags` trùng với `caps.ssmlBreak` của main ở mọi model → OK, nhưng nên dùng trực tiếp field.
- `<phoneme>` luôn bị chặn → an toàn so với #331.
- `clone_strength` (#319) bị từ chối là "unknown setting" → thiếu tính năng cho PVC v4, không phải bug.
- Voice id regex `^[A-Za-z0-9]{20}$` chặt hơn `checkVoiceId` trên main → có thể từ chối ID hợp lệ khác format; nên dùng chung.
- #327: nhóm `scene` không thuộc `LOCAL_GROUPS`/`NON_PROVIDER_GROUPS`, nên mọi subcommand (kể cả `plan`, `status`, `approve`, `voice add` vốn local) nhận thêm `--estimate/--max-cost/--cost-policy`. `--max-cost` luôn refuse (không có estimator). Receipt ghi `provider: "scene"` cho run trộn nhiều provider.

## Blocking

1. **Language bị bỏ âm thầm trên model đã hỗ trợ** — `src/commands/scene/speech-adapters.ts:178,207`. Profile `--language vi` với `eleven_v4`/`v4_turbo`/`v3_conversational` được nhận nhưng không gửi `language_code`, nó cũng không vào cache key. Điều này trái với chính policy của PR ("settings a model ignores would be paid for without effect" bị reject). Bảng docs cột "Language sent" cũng lỗi thời so với main.
   Fix: `language: caps?.languageCode ?? false` và xoá `ELEVENLABS_LANGUAGE_MODELS`. Với model `languageCode=false` (multilingual_v2), đưa vào `profileErrors` một lỗi (hoặc cảnh báo rõ) khi `profile.language` được set. Sửa bảng docs EN `docs-site/src/content/docs/commands/scene.md:169-195` và VI `vi/commands/scene.md:168-193`. Thêm unit test: v4 + language → `params.language_code === "vi"`. Lưu ý: cache key đổi với profile v4 có language, nên take cũ bị invalidate một lần (ghi vào PR body).

2. **Chia line làm vỡ markup sau khi đã validate → request trả phí đọc to rác** — validate ở `src/commands/scene/scene-manifest.ts:332` chạy trên cả line trước `chunkText` (`:338`). Nhưng `src/commands/scene/script-parser.ts:97` cắt câu ở dấu `.` bên trong `time="1.5s"`, và `:115` cắt từ ở khoảng trắng bên trong `<break ... />` / `[audio tag nhiều từ]`. Đã tái hiện: `['… <break', 'time="1.', '5s" /> …']`. Trường hợp này xảy ra khi line vượt limit (model limit, hoặc `max_chars` ≥ 20 do user đặt), và vô hiệu hoá cam kết "markup validated before paid request". Cùng regex cũng cắt giữa số thập phân ("3.5").
   Fix: tokenize `<…>` và `[…]` thành đơn vị không chia được trước khi tách câu/từ. Chỉ coi `.` là ranh giới khi theo sau là khoảng trắng hoặc hết chuỗi. Sau khi chunk, chạy lại `markupIn`/`lineErrors` trên từng part, và reject part nào có `<` hoặc `[` không đóng. Test: line có `<break time="1.5s" />` và `[sighs heavily]` vượt `max_chars`, assert mọi tag còn nguyên trong đúng một part.

## Non-blocking
- Docs/plan lỗi thời sau #327: `estimated_cost_usd: null` và câu "multix has no price table for these models yet" (`commands/scene.md:207-208`, VI `:204`) không còn đúng, vì main đã có estimator cho `elevenlabs tts` và `gemini generate-speech`. Follow-up: estimator cho `scene render`/`plan` cộng `estimateCost` theo từng target, để `--max-cost` dùng được. Tối thiểu docs phải nói `--max-cost` luôn refuse và `--estimate` trả unknown cho `scene`.
- Các subcommand local của scene (`plan`, `status`, `approve`, `reject`, `voice *`, `export`) nhận `--estimate/--max-cost` vô nghĩa, và `scene plan --max-cost 1` bị refuse. Cân nhắc đánh dấu chúng là local (cơ chế giống `LOCAL_GROUPS` ở cấp subcommand).
- Receipt/history `provider: "scene"` gộp OpenAI + ElevenLabs + Gemini → dashboard #294 theo provider sẽ lệch. Per-take usage trong manifest thì đúng.
- `render` mặc định gửi lại line `failed`, kể cả lỗi `UNKNOWN_REMOTE_STATE`/timeout (có thể đã bị tính tiền) và `VERIFICATION_FAILED` (đã trả tiền). Có ghi trong docs, nhưng nên yêu cầu `--retry-failed` hoặc `--line` cho các mã có thể đã billed.
- Crash giữa `writeFileSync(take)` và `writeManifest` → file take đã trả tiền nhưng mồ côi, lần sau render lại. Cửa sổ nhỏ; có thể ghi take "pending" vào manifest trước khi ghi file.
- `scene.script` trong manifest không được kiểm tra: một manifest chia sẻ có `script: "../../x"` khiến `render`/`plan` đọc file ngoài project và có thể gửi nội dung của nó (nếu parse được thành `NAME: text`) tới provider. Thực tế khó xảy ra, nhưng nên cảnh báo khi script nằm ngoài project, hoặc yêu cầu `plan` chạy lại.
- Scene id phân biệt hoa/thường (`S01` và `s01`): kiểm tra trùng scene là case-sensitive. Trên FS không phân biệt hoa/thường (macOS/Windows), `export` ghi đè stem âm thầm. Nên so trùng bằng `toLowerCase()`.
- `EMPTY_OUTPUT` bị push 2 lần (`inspectOutput` + `scene-render.ts`). `voice add --force` gọi `JSON.parse` trên file cũ không có try nên lỗi ra raw SyntaxError. `index.ts` dài 581 dòng.
- ElevenLabs trong scene không gửi `voice_settings` mặc định như `elevenlabs tts` (`TTS_VOICE_DEFAULTS`), nên âm sắc có thể khác giữa hai lệnh. Nên ghi vào docs.
- PR commit kèm report review cũ `plans/reports/code-reviewer-261026-0530-…` → hợp lệ theo AGENTS.md.

## Test / docs
- Unit test mock `globalThis.fetch`, key giả `sk-test-not-real`. Smoke test preload fake fetch → không gọi API thật. Tốt.
- Docs EN + VI có đủ, sidebar, `commands.md`, `llms.txt`, README, SKILL.md đã cập nhật. Cần sửa bảng language và câu về price table (xem trên).

## Conflict resolution guidance
- `skill/SKILL.md`: lấy `description` của PR (có thêm "multi-character dialogue … (multix scene)"), giữ `version: 1.18.1 # x-release-please-version` của main. Không còn conflict nào khác.
- Sau merge main: sửa blocking 1 bằng caps của main; cập nhật docs EN/VI về `--estimate/--max-cost` và price table. Chạy lại `npm run lint && npm run typecheck && npm run build && npm test && npm run check:mcp && npm run verify:docs`, rồi regenerate `worker/src/cli-catalog.json` (hiện không đổi).

## Câu hỏi mở
- Có muốn scene dùng chung `buildTtsRequest` của ElevenLabs (để tự hưởng các thay đổi caps/validation sau này) thay vì tự dựng payload không?
- Có cần ước tính chi phí cho `scene` trong PR này không, hay để follow-up issue?
