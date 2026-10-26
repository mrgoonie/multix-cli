# Code review: b2eaf1a feat(elevenlabs): support v4 and v4 Turbo TTS with model-specific controls

- Branch: claude/gracious-heisenberg-97u9gl, diff `HEAD~1..HEAD` (21 file, +882/-63)
- Issue: #292
- Reviewer: code-reviewer (độc lập, không viết code này)
- Ngày: 2026-10-26 (UTC)

## Kết luận

Không có lỗi Critical/High. Payload legacy của `eleven_multilingual_v2` giữ nguyên
(cùng key, cùng thứ tự, `style: 0`, `use_speaker_boost: true`). Logic
`getOptionValueSource("speakerBoost") === "cli"` đúng. Worker remote truyền
`--no-speaker-boost` đúng cách. Catalog đồng bộ. Không có import `node:*` lọt vào
bundle worker. Còn vài lỗ hổng Medium/Low về UX, độ phủ test và docs.

## Kiểm chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `npm run lint` | sạch (488 file) |
| `npm run typecheck` | sạch |
| `npm run build` + `vitest run` | 91 file pass / 5 skip; 1544 test pass / 14 skip |
| `npm run check:mcp` | worker typecheck OK, 375/375 test pass, `check-bundle: 1 file(s) clean` |
| Catalog đồng bộ | build lại catalog trong bộ nhớ từ `registerCommands`, so với `worker/src/cli-catalog.json`: **IN SYNC** (không ghi file) |
| `GET /v1/models` (miễn phí, không tốn credit) | bảng `ELEVENLABS_TTS_MODEL_CAPS` khớp live cho cả 9 model (style/boost/max chars). Flash/Turbo v2.x: `can_use_style=false`, `can_use_speaker_boost=false`; `eleven_v3_conversational`: boost=true, style=false, 5000 |

Sau khi kiểm chứng, đã loại bỏ nghi vấn ban đầu: việc payload Flash/Turbo thôi gửi `style`/`use_speaker_boost` không phải regression, vì API báo các model này không hỗ trợ hai control đó.

## Các điểm đã xác minh là đúng

- `src/providers/elevenlabs/tts-request.ts:81-93`: default model vẫn ra
  `{stability:0.5, similarity_boost:0.75, style:0, use_speaker_boost:true}`, có test
  `tts-command.test.ts` khóa body này.
- `src/providers/elevenlabs/commands/tts.ts:85-86`: trong CLI không có `.env()`,
  `setOptionValueWithSource` hay lớp config nào (đã grep `src/`), nên source chỉ có thể
  là `default` hoặc `cli`. `multix rerun` phát lại argv nên vẫn ra `cli`.
- Worker: `optionName()` = `long` bỏ dấu gạch (`worker/src/jobs/cli-catalog.ts:39`),
  nên MCP gửi `{"no-speaker-boost": true}` thì argv có `--no-speaker-boost` và source là `cli`.
  Gửi `false` thì option bị bỏ (hành vi mặc định). Gửi `{"speaker-boost": false}` thì bị lỗi
  "Unknown option", không bị bỏ qua âm thầm. `prepareRun` không bao giờ tự chèn
  `default` của catalog, nên bỏ `default` của `--stability/--similarity-boost/--style` không làm đổi argv.
- `--timestamps` remote: file `<dest>.timestamps.json` nằm trong `MULTIX_OUTPUT_DIR=out/`,
  và `collectOutputs` (`worker/container/job-outputs.mjs`) có upload nó.
- Telemetry: response `/with-timestamps` lớn hơn `MAX_JSON_BYTES` thì body bị bỏ qua, nhưng
  header `character-cost` vẫn được đọc. Prefix host được gắn trong `fetch-telemetry.ts:193-197`.
- `tts-request.ts` chỉ import `core/errors.js` (file này chỉ import `redact.js`) và `models.ts` (không import gì),
  nên đúng là runtime-neutral. `fs` chỉ dùng ở `commands/tts.ts` (command layer), đúng AGENTS.md.

## Phát hiện

### Critical
Không có.

### High
Không có.

### Medium

**M1. `--timestamps` cùng `--output`: file timings không nằm cạnh bản copy của người dùng**
- `src/providers/elevenlabs/commands/tts.ts:125-135` (dùng `dest` từ `saveBytes`).
- Kịch bản: `multix elevenlabs tts --text ... --timestamps --output ./voice.mp3` tạo
  `./voice.mp3`, nhưng timings lại được ghi ở `multix-output/elevenlabs_tts_<stamp>.mp3.timestamps.json`.
  Docs (README, `docs-site/.../elevenlabs.md` và bản vi) ghi "saves character timings next to the audio as
  `<audio>.timestamps.json`". Người dùng hoặc agent tìm `./voice.mp3.timestamps.json` sẽ không thấy.
- Sửa: khi có `opts.output`, ghi thêm (hoặc chỉ ghi) `${opts.output}.timestamps.json`. Nếu không,
  sửa docs thành "next to the file in the multix output dir" và nêu rõ dòng `Timestamps:` ở stdout.

**M2. Thiếu test cho các nhánh lỗi và validation mới**
- `tests/unit/providers/elevenlabs/tts-request.test.ts` và `tts-command.test.ts` chưa có test cho:
  - `unitInterval` từ chối `--stability abc`, `-0.1`, `1.5`, chuỗi rỗng (`tts-request.ts:42-49`);
  - `--seed` âm, không phải số nguyên, hoặc lớn hơn 4294967295 (`tts-request.ts:97-105`);
  - `/with-timestamps` trả body không phải JSON, hoặc thiếu `audio_base64` (`commands/tts.ts:306-313`);
  - `recordUsage` gắn prefix host vào `sources` (`fetch-telemetry.ts:193-197`). Test hiện tại
    tự dựng `sources` đã có host, nên đây là phantom coverage cho phần prefix;
  - `prepareRun` của worker với `elevenlabs tts` + `no-speaker-boost: true` + `timestamps: true`
    (chưa có regression test cho đường remote mà task yêu cầu giữ).
- Đây là các đường "reject, không bỏ qua" chính của issue, nên cần khóa bằng test.

**M3. Live test không phát hiện drift của bảng capability**
- `tests/unit/providers/elevenlabs/live.test.ts` chỉ synth thử v4/v4 Turbo. Bảng
  `ELEVENLABS_TTS_MODEL_CAPS` (`models.ts:38-101`) được hard-code. Nếu ElevenLabs bật
  `can_use_style` cho một model, CLI sẽ từ chối sai.
- Sửa: thêm một case live (vẫn gate bằng `MULTIX_LIVE_TESTS=1`) gọi `GET /v1/models` (miễn phí)
  và so `can_use_style`, `can_use_speaker_boost`, `maximum_text_length_per_request` với bảng.

### Low

**L1. Thông báo vượt giới hạn ký tự gợi ý chính model đang dùng**
- `tts-request.ts:61-63`: với `eleven_v4`, `eleven_v4_turbo` hoặc `eleven_multilingual_v2`, thông báo nói "use a model
  with a higher limit: eleven_v4 (10000)". Gợi ý này vô nghĩa vì giới hạn bằng nhau. Nên tạo danh sách
  từ bảng caps với `maxChars > caps.maxChars`.

**L2. Đếm ký tự theo UTF-16 code unit**
- `text.length` (`tts-request.ts:60`) đếm emoji/ký tự ngoài BMP là 2. Văn bản sát ngưỡng có emoji
  có thể bị chặn sớm. Nếu muốn khớp cách API đếm, dùng `[...text].length` (cần xác nhận
  API đếm theo code point).

**L3. Cảnh báo ở chế độ `--json` chỉ nằm trong `log[]`**
- `logger.warn` ghi ra stderr (`core/logger.ts:48-49`), nên với `--json` các cảnh báo kiểu "--style 0 was not
  sent" hay audio tag chỉ xuất hiện trong `log[]`, không có trong `warnings[]` (`warnings[]` hiện chỉ dành cho kiểm tra output).
  Như vậy vẫn là "reported", nhưng agent đọc theo SKILL.md ("no `warnings`" = thành công) sẽ không thấy.
  Có thể chấp nhận. Ghi lại để lead quyết định.

**L4. `multix guide` chưa nhắc `usage.sources`**
- `src/commands/agent/guide-command.ts:19` vẫn ghi `usage{tokens,cost_usd,credits,metrics}`, trong khi README,
  SKILL.md và for-ai-agents đã thêm `sources`. Đây là docs drift nhỏ trong protocol in ra lúc chạy.

**L5. Định dạng mới và MIME/kiểm tra output**
- `.alaw` không có trong `MIME` (`src/agent/output-file-inspect.ts:31-60`) nên ra `application/octet-stream`.
  Container `CONTENT_TYPES` (`worker/container/job-outputs.mjs:17-36`) thiếu `.opus`, `.pcm`, `.alaw`, nên R2
  phục vụ `application/octet-stream`. File `.pcm` (raw) khiến ffprobe báo `UNREADABLE_MEDIA`. Lỗi này đã có từ trước với
  `pcm_*`, nay xuất hiện thêm với `pcm_32000/48000`. Không chặn merge. Nếu muốn sửa thì mở issue riêng.

**L6. `account.ts` in "nullx credits/char" nếu API trả `null`**
- `commands/account.ts:72-74` chỉ kiểm tra `!== undefined`. Nên dùng `typeof === "number"`.

**L7. Docs: "nothing is billed" khi API trả 400 `unsupported_language`**
- README và `docs-site/.../elevenlabs.md` (+ vi) khẳng định không tính phí. Fact đã xác minh chỉ nói API trả 400,
  chưa có bằng chứng về billing. Nhiều khả năng đúng (request lỗi 4xx), nhưng nên bỏ vế này hoặc dẫn nguồn.
  Ngoài ra, mã 400 mới chỉ được xác minh cho multilingual_v2, flash_v2, v3 và v4. Turbo v2/v2.5, Flash v2.5, v4 Turbo và v3_conversational
  được suy ra, chưa đo.

## Đối chiếu docs với code

- Bảng model trong `docs-site/.../commands/elevenlabs.md` và bản vi: khớp `ELEVENLABS_TTS_MODEL_CAPS` và live `/v1/models`
  (94 ngôn ngữ cho v4, tức "90+"; 32 cho Flash/Turbo v2.5; 29 cho multilingual v2; multiplier 0.5 cho v4 Turbo).
- Danh sách format: khớp `ELEVENLABS_TTS_OUTPUT_FORMATS`.
- Mô tả "`--style 0` / `--no-speaker-boost` ... warning and not sent", "non-zero `--style` rejected",
  "v3 rejects previous/next", "unknown model passes through with warning": khớp `tts-request.ts`.
- "next to the audio": xem M1.
- `usage.sources.credits` = `api.elevenlabs.io header.character-cost`: khớp `fetch-telemetry.ts`.

## Phạm vi

Commit có thêm `eleven_v3_conversational`, 16 output format, `--timestamps` và output mở rộng của `elevenlabs models`.
Các phần này nằm ngoài phạm vi tối thiểu "thêm v4/v4 Turbo", nhưng có liên quan và đã được lead xác minh (timestamps, wav/opus).
Capability của `v3_conversational` khớp `/v1/models`. Không thấy file không liên quan.

## Khuyến nghị theo thứ tự

1. M1: ghi timings cạnh `--output`, hoặc sửa docs.
2. M2: bổ sung test cho validation, các nhánh lỗi timestamps, prefix host và `prepareRun` của worker.
3. M3: thêm live check (gate bằng env) so bảng caps với `GET /v1/models`.
4. L1, L4, L6, L7: chỉnh nhỏ. L5: mở issue riêng.

## Câu hỏi chưa giải quyết

- Lỗi 400 `unsupported_language` có thật sự không tính credit không?
- Có muốn đưa cảnh báo capability vào `warnings[]` của envelope (L3) không, hay chấp nhận để trong `log[]`?
