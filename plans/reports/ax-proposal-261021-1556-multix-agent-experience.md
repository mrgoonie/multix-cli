# Đề xuất AX (Agent Experience) cho multix CLI + MCP

Ngày: 2026-10-21 · Base: `726f5a7` (v1.12.4) · Loại: đề xuất, chưa triển khai.

## Kết luận

multix đã có nền tốt (109 lệnh, catalog JSON tự sinh, `MultixError.code`, Runway in sẵn lệnh status/resume/cancel, MCP 4 tool gọn). Điểm nghẽn AX nằm ở **hợp đồng đầu ra**: mỗi provider in theo kiểu riêng, lỗi mất `code` và gợi ý, không có lịch sử cục bộ, việc chọn model phải đọc SKILL.md 562 dòng. Agent phải "đọc văn xuôi rồi đoán". Đề xuất xoay quanh một nguyên tắc: **mọi lệnh trả cùng một envelope JSON máy đọc được, luôn kèm `next`**.

## Bằng chứng (gap hiện tại)

| # | Gap | Bằng chứng |
|---|---|---|
| G1 | Không có `--json` toàn cục; chỉ HeyGen có | `src/providers/heygen/**` (8 chỗ), các provider khác không có |
| G2 | Lỗi top-level mất `code`, không có hint | `src/cli.ts:29` chỉ in `Error: ${msg}` |
| G3 | Exit code không phân loại | 56× `process.exit(1)`, 4× `exit(2)` |
| G4 | Envelope không thống nhất | `Result` = `{status, error}` (`src/core/result.ts`), Gemini dùng `AnalysisResult[]`, nhiều lệnh in text |
| G5 | Không có lịch sử/ledger job cục bộ | không có `history`/manifest trong `src/` |
| G6 | Khám phá model rời rạc | `models` chỉ có ở leonardo/runway/heygen; Gemini có `models.ts` nhưng không có lệnh; cây quyết định nằm trong SKILL.md |
| G7 | Không có dry-run/ước tính chi phí | không có `--dry-run`, không có trường cost |
| G8 | MCP lỗi chỉ là chuỗi text | `toolError()` trong `worker/src/mcp-server.ts` không có `code`/`retryable`/`next` |
| G9 | Không tự kiểm tra output | đã có issue #253 (media inspect/verify) — đề xuất này **dựa vào**, không làm trùng |

## Đề xuất theo 8 mục tiêu của bạn

### 1. Thành thạo nhanh (onboarding ≤ 1 lệnh)
- **`multix guide [task]`**: in ra ≤ 40 dòng: task → lệnh khuyến nghị + ví dụ chạy được. `multix guide` không đối số in bản đồ task (image / i2i / video / tts / stt / music / 3d / doc / media).
- **SKILL.md tách tầng**: phần đầu ≤ 80 dòng (quy tắc vàng + bảng task→lệnh + "khi lỗi làm gì"), chi tiết provider chuyển sang `skill/references/<provider>.md` load khi cần. Giảm token mỗi lần nạp skill khoảng 80%.
- **`--help` có ví dụ**: mỗi lệnh thêm `addHelpText('after', Examples)` 1–2 dòng copy-paste được.

### 2. Không thử-sai (fail trước khi tốn tiền)
- **`--dry-run` toàn cục**: validate flag, key, file input, model id, aspect/size hợp lệ, in request đã resolve (đã redact) + exit 0. Không gọi API trả phí.
- **Validate sớm theo capability**: mỗi model khai báo `supports` (aspect, duration, refs tối đa, format); sai thì lỗi `VALIDATION_ERROR` kèm danh sách giá trị hợp lệ.
- **"Did you mean"** cho flag và model id sai (Levenshtein trên catalog).

### 3. Tiết kiệm token
- **`--json` toàn cục + envelope duy nhất** (xem phụ lục). Không spinner, không màu khi `--json` hoặc `!isTTY`; log tiến độ ra stderr, kết quả ra stdout.
- **`--quiet` / `--fields path,url`**: chỉ in trường cần.
- **MCP `multix_catalog`**: thêm `detail: "brief" | "full"` và `command` để lấy đúng một lệnh thay vì cả group; trả `structuredContent` gọn, bỏ mô tả lặp.
- **Env `MULTIX_OUTPUT=json`** để agent đặt một lần cho cả session.

### 4. Tìm và chọn model/provider dễ
- **`multix models [--task t2i|i2i|t2v|i2v|tts|stt|music|3d] [--provider p] [--ready] --json`**: một registry thống nhất (tĩnh, sinh lúc build, có thể bổ sung live list). Mỗi dòng: `id, provider, task, quality tier, speed, price hint, max duration/res, refs, async?, key_ready`.
- **`multix recommend --task t2v --prefer cheap|fast|quality [--has-image]`**: trả top-3 kèm lý do và lệnh chạy sẵn. Thay thế cây quyết định văn xuôi trong SKILL.md bằng dữ liệu kiểm thử được.
- `--ready` lọc theo key đã cấu hình (tái dụng `provider-keys.ts`, `hasGroupKeys`).
- MCP: tool `multix_models` (read-only) dùng cùng registry.

### 5. Tự phát hiện sai sót
- Mỗi kết quả thành công kèm `outputs[]` có `path, bytes, mime, sha256, width/height/duration` (đọc bằng `image-header.ts`, ffprobe khi có) và `checks[]` nhẹ: file không rỗng, mime khớp đuôi, duration/size khớp yêu cầu ± dung sai. Lệch → `warnings[]` với `code`.
- Kiểm tra sâu (black frame, loudness...) giao cho `multix media verify` của #253; envelope chỉ chừa chỗ `verify` gợi ý trong `next`.
- Gemini analyze: `status: "error"` trên từng file phải làm exit code ≠ 0 (partial failure → exit riêng).

### 6. Kiểm tra tiến độ
- Thống nhất lệnh async: mọi provider có `status <id>`, `cancel <id>`, `--async`, `--wait-timeout`. Hiện lệch tên (`video-status`, `video-cancel`, `status`, `result`).
- **`multix jobs status <job-ref>`**: một lệnh chung, tự route theo provider được lưu trong ledger (mục 7). Trả `state: queued|running|succeeded|failed|canceled|timed_out`, `progress` (nếu provider có), `eta_s`, `poll_after_s`.
- MCP `multix_job_status` thêm `poll_after_s` và `next`.

### 7. Xem lại lịch sử
- **Ledger cục bộ** `~/.multix/history.jsonl` (append-only, có thể tắt bằng `MULTIX_HISTORY=0`): `ts, command, provider, model, job_id, state, outputs, duration_ms, error_code`. **Không** lưu prompt đầy đủ (chỉ hash + 80 ký tự đầu, có thể tắt), không lưu key/URL ký.
- `multix history [--last 20] [--failed] [--provider p] --json`, `multix history show <id>`, `multix rerun <id> [--override k=v]`.
- `multix jobs resume` dùng ledger để hoàn tất job async bị ngắt (đã có resume ở atlas/replicate/runway, chỉ cần gom lại).

### 8. Biết làm gì tiếp khi gặp vấn đề
- **Error taxonomy ổn định** (mở rộng `MultixError`): `MISSING_KEY, INVALID_KEY, QUOTA_EXCEEDED, RATE_LIMITED, CONTENT_BLOCKED, INVALID_INPUT, MODEL_NOT_FOUND, UNSUPPORTED_OPTION, TIMEOUT, PROVIDER_DOWN, BINARY_MISSING, OUTPUT_INVALID`. Map từ HTTP status + body của từng provider.
- Mỗi lỗi kèm `retryable`, `retry_after_s`, `hint` (1 câu) và `next[]` là lệnh chạy được (ví dụ `MISSING_KEY` → `multix check`; `QUOTA_EXCEEDED` → provider thay thế từ registry; `CONTENT_BLOCKED` → gợi ý chỉnh prompt, không retry).
- **Exit code theo lớp**: 0 ok · 2 usage/validation · 3 config/key · 4 provider lỗi tạm (retryable) · 5 provider từ chối (không retry) · 6 timeout (job vẫn chạy, có job_id) · 7 partial success.
- `multix check --json` trả trạng thái từng provider + `next` để sửa.
- MCP: lỗi trả `structuredContent: {code, retryable, hint, next}` thay vì chỉ text.

## Phụ lục: envelope đề xuất (v1)

```json
{
  "schema": "multix.result/v1",
  "ok": true,
  "command": "gemini generate",
  "provider": "gemini",
  "model": { "requested": null, "resolved": "gemini-3-pro-image" },
  "job": { "id": "…", "state": "succeeded", "async": false },
  "outputs": [{ "path": "out/a.webp", "mime": "image/webp", "bytes": 182311, "sha256": "…", "width": 1344, "height": 768 }],
  "warnings": [],
  "error": null,
  "usage": { "cost_usd": null, "duration_ms": 8123 },
  "history_id": "h_01J…",
  "next": [{ "why": "kiểm tra output", "cmd": "multix media verify out/a.webp --json" }]
}
```

Lỗi: `ok:false`, `error: {code, message, retryable, retry_after_s, hint}`, `next` vẫn có. Cùng shape dùng cho CLI `--json`, MCP `structuredContent` và receipts của #253 (để khớp epic QGP).

## Lộ trình (mỗi dòng một issue theo AGENTS.md)

| Ưu tiên | Hạng mục | Phụ thuộc |
|---|---|---|
| P1 | Envelope v1 + `--json`/`MULTIX_OUTPUT` toàn cục + stdout/stderr discipline | — |
| P1 | Error taxonomy + exit code theo lớp + `hint/next` (CLI + MCP) | envelope |
| P1 | `--dry-run` toàn cục | envelope |
| P2 | Model registry + `multix models` + `recommend` + MCP `multix_models` | — |
| P2 | Ledger + `history`/`rerun` + `jobs status/resume` chung | envelope |
| P2 | Chuẩn hóa tên lệnh async (alias cũ giữ lại, deprecate dần) | ledger |
| P2 | Output checks nhẹ trong envelope | envelope; nối #253 |
| P3 | `guide`, ví dụ trong `--help`, tách SKILL.md theo tầng | registry |
| P3 | `multix_catalog` brief/full + per-command | — |

Tương thích: không đổi output mặc định (text) trong P1; JSON chỉ khi opt-in. Đổi exit code là thay đổi hành vi → cần quyết định có coi là breaking hay không.

## Đo lường thành công

Bộ eval agent (task cố định, ví dụ "tạo video 5s 9:16 rẻ nhất có key"): đo số tool call tới kết quả đúng, số lần gọi API trả phí thất bại, token tiêu thụ, tỉ lệ tự hồi phục sau lỗi tiêm vào (key sai, quota, model id sai). Mục tiêu: ≤ 3 call, 0 lần trả phí hỏng do flag sai, giảm ≥ 50% token so với baseline hiện tại.

## Câu hỏi chưa giải quyết

1. Đổi exit code (1 → 2..7) có chấp nhận như minor không, hay cần major / chỉ bật khi `--json`?
2. Ledger mặc định bật hay tắt? Có lưu prefix prompt không?
3. Registry model tĩnh (build-time) có đủ, hay cần gọi live list mỗi provider (tốn thời gian, cần key)?
4. Price hint: dữ liệu giá do ai cập nhật, chấp nhận lỗi thời đến mức nào?
5. Envelope có nên hợp nhất với schema receipt của epic QGP (#253) ngay từ v1?
