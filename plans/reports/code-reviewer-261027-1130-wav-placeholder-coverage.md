# Code review: c1afc5b — WAV placeholder threshold + truncated-WAV coverage (issue #384)

Scope: `git diff origin/dev...HEAD` (7 files, +47/-17): src/commands/media/media-wav.ts, media-verify.ts, tests (media-wav.test.ts, media-quality-ffmpeg.test.ts), README.md, docs-site EN/VI.
Checks: `npm run build` OK, `npm run typecheck` OK, biome clean, `npx vitest run tests/unit/commands/media` 120/120 pass. ffmpeg 6.1.1 experiments in /tmp/claude-0/review-384 (deleted).

## Verdict
Goal (1) và (3) đạt cho case GStreamer. Goal (2) SAI cho mọi WAV có `fact` chunk (ADPCM, mp3-in-WAV, IEEE float): coverage bị scale hai lần. Ngoài ra threshold 0x7FFF0000 tạo false negative cho WAV RIFF thật 2–4 GiB (ffmpeg mặc định `-rf64 never`).

## High
### H1. Coverage double-scaled khi ffprobe đã lấy duration từ `fact` chunk — media-verify.ts:707-713
ffprobe chỉ size WAV theo bytes còn lại khi KHÔNG có `fact` sample count. Với WAV có `fact` (bắt buộc cho non-PCM, ffmpeg cũng ghi cho pcm_f32le), `format.duration` đã là độ dài declared; nhân thêm `declared/present` -> gấp đôi.
Thực nghiệm (4 s sine, cắt còn 1/2 file, `media verify --profile audio`):
| codec | ffprobe cut duration | coverage.media_duration_s | ratio |
|---|---|---|---|
| pcm_s16le (không fact) | 1.9996 | 4.000 (đúng) | 0.475 |
| adpcm_ms | 4.000 | 8.011 | 0.250 |
| adpcm_ima_wav | 4.000 | 8.008 | 0.250 |
| mp3 in WAV | 4.025 | 8.076 | 0.248 |
| pcm_f32le (có fact) | 4.000 | 8.001 | 0.237 |
Receipt còn tự mâu thuẫn: `decode.measured.declared_duration_s = 4` nhưng `coverage.media_duration_s = 8`. Gating theo `codec_name.startsWith("pcm_")` không đủ (f32le vẫn sai).
Fix: tính declared duration từ header thay vì scale ffprobe: trong `readWavDataLength` đọc `fmt ` (nAvgBytesPerSec / nBlockAlign, sampleRate) và `fact` (sample count); expose `declared_duration_s` = fact_samples/sampleRate nếu có fact, else declared_bytes/nAvgBytesPerSec cho PCM; null -> dùng `probed`. Hoặc tối thiểu: chỉ scale khi không có `fact` chunk. Thêm test ffmpeg cho adpcm_ms và pcm_f32le cắt cụt.

## Medium
### M1. Threshold `>= 0x7FFF0000` nuốt size thật của WAV RIFF 2–4 GiB — media-wav.ts:21-26, 60
Size 32-bit unsigned hợp lệ tới ~4 GiB; ffmpeg wav muxer mặc định `-rf64 never` nên ghi RIFF thường cho file 2–4 GiB. Comment "A real WAV this large is written as RF64" và docs là không đúng.
Repro: PCM WAV với data=0xC0000000, RIFF=data+62, file 200000 bytes -> engine /3 `pass` (coverage 2.27 s, decode pass). Engine /2 sẽ `fail` (truncated). Đây là đánh đổi có chủ ý của goal (1) (user decision), nên không đảo ngược tự ý; options:
  a) giữ nguyên, sửa comment + docs/SKILL.md ghi rõ blind spot "WAV RIFF khai báo >= 0x7FFF0000 bytes không được kiểm truncation";
  b) chỉ coi là placeholder các giá trị cụ thể {0, 0x7FFF0000, 0x7FFFF000, 0xFFFFFFFF} và RIFF size GStreamer (0x7FFF0000 + header-8) — GStreamer wavenc ghi đúng hằng 0x7FFF0000, nên đủ cho #384 mà không mất phát hiện 2–4 GiB.
Khuyến nghị (b), hoặc tối thiểu (a).

### M2. Docs mô tả sai phạm vi — README.md:900, docs-site EN:133-135, VI:130-132
"0x7FFF0000 and up: GStreamer, SoX and ffmpeg placeholders" ngụ ý mọi giá trị đó là placeholder; thực tế đó là size thật hợp lệ của RIFF 2–4 GiB, và tool im lặng bỏ qua truncation check. skill/SKILL.md:549 chưa cảnh báo agent rằng `pass` của WAV lớn không chứng minh file đủ (tương tự cảnh báo đã có cho `declared_duration_estimated`). Coverage scaling (goal 2) không được nêu trong docs nào — chấp nhận được nếu coi là internal, nhưng `coverage.media_duration_s` là field public của receipt.

## Low
### L1. Receipt inconsistency cho PCM truncated — media-verify.ts:265-270 vs 707-713
PCM cắt: `decode.measured.declared_duration_s: null, declared_duration_estimated: true` (ffprobe flag estimate) nhưng `coverage.media_duration_s: 4.0`. Hai field cùng tên "declared" khác nguồn. Nên dùng chung một giá trị declared-from-header, hoặc doc rõ.
### L2. `wav_data.present_bytes` đổi ngữ nghĩa (capped) trong JSON public của `media inspect` / `measured.present_data_bytes`
Không breaking về shape, chỉ giá trị với file có trailing chunk; interface comment đã cập nhật. OK, chỉ ghi nhận.
### L3. RF64 với data chunkSize 32-bit thật trong [0x7FFF0000, 0xFFFFFFFE] (không phải 0xFFFFFFFF) — media-wav.ts:82
Rơi vào `known()` -> null. Hiếm; cùng gốc với M1.

## Checked, no issue
- RIFX: `u32` đọc BE trước khi so threshold — nhất quán; ds64 chỉ cho RF64 (LE). OK.
- RF64 0xFFFFFFFF: data size lấy từ ds64 qua `known64`; không có ds64 -> null; ds64 = 0/0xFFFFFFFF/>MAX_SAFE -> null. ds64 0x80000000 giữ là real (test có). OK.
- Rule "data và RIFF đều vượt file": RIFF placeholder giờ -> null -> chỉ dựa vào data; nhưng với file < 2 GiB, RIFF >= 0x7FFF0000 trước đây cũng luôn `> size`, nên hành vi không đổi.
- Ratio: present đã cap <= declared và chỉ scale khi truncated -> factor >= 1; `present_bytes > 0` guard; `probed === null` -> null; `Math.min(1, …)` giữ ratio <= 1.
- Cache key chứa `VERIFY_ENGINE` (media-verify.ts:609-617); bump /3 invalid cache cũ. OK.
- `truncated` dùng `present` chưa cap — đúng.

## Recommended actions
1. (H1) Lấy declared duration từ `fmt `/`fact` trong media-wav.ts; không scale khi có `fact`. Thêm test adpcm_ms + pcm_f32le truncated.
2. (M1) Quyết định với user: thu hẹp placeholder về tập giá trị cụ thể (khuyến nghị) hoặc document blind spot 2–4 GiB.
3. (M2) Sửa comment media-wav.ts:24 và README/docs EN+VI/SKILL.md cho khớp.

Status: DONE_WITH_CONCERNS

## Resolution

Fixed in f7f509c: exact placeholder list (M1), `declared_duration_s` read from `fact`/`fmt` and used by both coverage and the decode check (H1, L1), docs wording (M2), RF64 32-bit sizes (L3). Tests cover each case and fail on the earlier code.
