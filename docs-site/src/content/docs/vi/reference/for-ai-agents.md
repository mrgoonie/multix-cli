---
title: Dành cho AI agent
description: Cách ngắn gọn, ổn định để agent khám phá multix và tạo lệnh có thể lặp lại.
---

## Ưu tiên Markdown route

Mỗi route tài liệu có cùng path cộng thêm `.md`. Hãy dùng route này khi agent
cần context gọn, gần source hơn HTML đã render.

```text
https://multix.zuey.me/commands/gemini.md
https://multix.zuey.me/commands/minimax.md
https://multix.zuey.me/reference/environment.md
https://multix.zuey.me/llms.txt
```

## Giao thức cho agent

`multix guide` in giao thức này trên một màn hình, đúng với version đang cài.

1. **Khám phá.** `multix models --task <task> --ready` liệt kê các lệnh phục vụ
   một task, model mặc định, key đã đặt hay chưa và lệnh có chạy async không.
   Task: `image`, `image-edit`, `video`, `image-to-video`, `video-edit`,
   `speech`, `transcription`, `music`, `sfx`, `voice`, `3d`, `analysis`,
   `document`, `avatar-video`, `any`. Thêm `--provider <group>` để lọc,
   `--json` để nhận mảng JSON.
2. **Kiểm tra miễn phí.** Thêm `--dry-run` vào bất kỳ lệnh nào: các bước kiểm
   tra cục bộ vẫn chạy (flag, file đầu vào, key), rồi request đầu tiên tới
   provider được in ra (method, URL không có query string, body với giá trị dài
   đã rút gọn, chỉ tên header) thay vì gửi đi. Lệnh `media` cục bộ dừng trước
   khi chạy.
3. **Chạy với `--json`** (hoặc `MULTIX_OUTPUT=json`). stdout đúng một dòng, là
   envelope `multix.result/v1`; output cho người đọc được giữ lại.
4. **Tự kiểm tra kết quả.** Thành công nghĩa là `ok: true`, `outputs` không rỗng
   và không có `warnings` (`EMPTY_OUTPUT`, `CONTENT_MISMATCH`, `UNREADABLE_MEDIA`).
5. **Khi lỗi** làm theo `error.hint` và `next[]`; đừng gửi lại job tính phí một
   cách mù quáng.
6. **Job dài.** Dùng `--async` khi lệnh hỗ trợ, giữ job id và chạy lệnh status
   trong `next[]`.
7. **Lịch sử.** Mọi lần chạy được ghi cục bộ; xem [Lịch sử chạy](#lịch-sử-chạy).

## Envelope kết quả

```json
{
  "schema": "multix.result/v1",
  "ok": true,
  "command": "gemini generate",
  "provider": "gemini",
  "model": "gemini-2.5-flash-image",
  "duration_ms": 8120,
  "outputs": [
    { "path": "gemini-image-1.webp", "bytes": 184220, "mime": "image/webp",
      "sha256": "…", "width": 1024, "height": 1024 }
  ],
  "usage": { "tokens": { "input": 12, "output": 1290, "total": 1302 } },
  "http": { "requests": 1, "errors": 0, "ms": 7900 },
  "history_id": "h_mfz3k2ab1c9d",
  "exit_code": 0,
  "next": []
}
```

| Trường | Ý nghĩa |
| --- | --- |
| `outputs[]` | File lần chạy đã ghi: path tương đối, kích thước, MIME đoán từ nội dung, SHA-256, `width`/`height` của ảnh, `duration_s` của media (cần ffprobe). |
| `warnings[]` | Vấn đề tìm thấy trong output, ví dụ file rỗng hoặc nội dung không khớp phần mở rộng. |
| `data` / `text` | stdout của lệnh: JSON đã parse, hoặc text tối đa 32 KB. |
| `error` | `code`, `message`, `retryable`, `retry_after_s`, `hint`, `http_status`, `env` (tên key khi thiếu key). |
| `usage` | Số liệu provider trả về: `tokens` (`input`, `output`, `total`, `thinking`), `cost_usd`, `credits` và các `metrics` dạng số khác theo key path. `sources.cost_usd` / `sources.credits` ghi nguồn của từng số (ví dụ `api.elevenlabs.io header.character-cost`). Không ước tính: số ước tính hoặc báo giá của provider (như `estimatedCost` của Runway) chỉ nằm trong `metrics`, không bao giờ được báo là `cost_usd` hay `credits`. |
| `http` | Số request tới provider, số request lỗi và tổng thời gian. |
| `provider_ids` | Request id, job id hoặc prediction id provider trả về. |
| `request` | Với `--dry-run`: request lẽ ra đã được gửi. |
| `next[]` | Lệnh nên chạy tiếp: lệnh status của job async, `multix check` khi lỗi key, `multix rerun <id>` khi lỗi tạm thời. |

## Exit code và mã lỗi

| Exit | Nhóm | Mã lỗi | Cần làm |
| --- | --- | --- | --- |
| 0 | thành công | | |
| 2 | sai cú pháp hoặc input | `USAGE`, `INVALID_INPUT` | Sửa flag; chưa bị tính phí. |
| 3 | key hoặc cài đặt | `MISSING_KEY`, `INVALID_KEY`, `CONFIG_ERROR`, `BINARY_MISSING` | `multix check`, đặt key có tên trong `error.env`. |
| 4 | tạm thời | `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR` | Chờ `retry_after_s`, rồi `multix rerun <id>`. |
| 5 | bị từ chối | `QUOTA_EXCEEDED`, `CONTENT_BLOCKED`, `MODEL_NOT_FOUND`, `NOT_FOUND`, `PROVIDER_REJECTED`, `JOB_FAILED`, `RESPONSE_TOO_LARGE` | Đổi input, model hoặc provider. |
| 6 | hết thời gian hoặc không rõ | `TIMEOUT`, `UNKNOWN_REMOTE_STATE` | Job có thể vẫn đang chạy: dùng lệnh status trong `next[]`. `UNKNOWN_REMOTE_STATE`: lần submit thất bại mà không chứng minh được provider đã từ chối (bị cắt kết nối, lỗi gateway 5xx) nên job có thể đã vào hàng đợi; kiểm tra danh sách request của provider trước khi submit lại. |
| 1 | không rõ | `UNKNOWN` | Đọc `log[]` (các dòng stderr cuối). |

Các nhóm exit code này áp dụng ở agent mode (`--json` hoặc `MULTIX_OUTPUT=json`).
Không có chế độ đó, lệnh lỗi vẫn exit 1 như các phiên bản trước và in thêm các
dòng `code:`, `hint:` và `next:` ra stderr. Ledger lịch sử luôn ghi mã lỗi.

## Lịch sử chạy

Mỗi lệnh provider ghi thêm một dòng vào `~/.multix/history.jsonl` (quyền file
0600, xoay vòng ở 20 MB): id, thời điểm, thời lượng, lệnh, provider, model,
argv (giá trị của option có tên kiểu key, token, secret hoặc password bị che),
kết quả và mã lỗi, output kèm kích thước và hash, usage của provider (tokens,
cost, credits, metrics), số liệu HTTP và id phía provider. Key và signed URL
không bao giờ được ghi.

```bash
multix history                      # 20 lần chạy gần nhất
multix history --failed --since 1d  # các lần lỗi trong ngày
multix history show last            # một lần chạy đầy đủ (id, tiền tố id, last, last-N)
multix history stats --by model     # số lần, tỉ lệ thành công, p50/p90, cost, credits, tokens
multix rerun h_mfz3k2ab1c9d         # chạy lại (tham số thêm được nối vào sau)
```

`MULTIX_HISTORY=0` tắt ledger. `MULTIX_HISTORY_FILE` đổi vị trí file (chỉ trong
shell hoặc `~/.multix/.env`, không nhận từ `.env` của project).

## Quy trình lệnh an toàn

- Không in hoặc yêu cầu giá trị secret; `multix check` cho biết key nào đã đặt.
- Dùng `--input`, `--output` và provider flags rõ ràng khi cần tái lập kết quả.

## Bản đồ khả năng

| Nhu cầu | Bắt đầu từ |
| --- | --- |
| Phân tích hoặc transcribe file | [Gemini](/vi/commands/gemini/) |
| Sinh/sửa ảnh, speech hoặc transcription | [OpenAI](/vi/commands/openai/) |
| Ảnh, video, speech hoặc music MiniMax | [MiniMax](/vi/commands/minimax/) |
| Ảnh, image-to-video hoặc giọng nói qua routing | [OpenRouter](/vi/commands/openrouter/) |
| Leonardo image ID, video hoặc upscale job | [Leonardo](/vi/commands/leonardo/) |
| Seedream, Seedance, reference video hoặc 3D | [BytePlus](/vi/commands/byteplus/) |
| Workers AI image/speech hoặc AI Gateway video | [Cloudflare](/vi/commands/cloudflare/) |
| Voice workflow, dubbing hoặc audio generation | [ElevenLabs](/vi/commands/elevenlabs/) |
| Bất kỳ model queue fal.ai, ảnh hoặc video | [fal.ai](/vi/commands/fal/) |
| Bất kỳ model Atlas Cloud nào, hoặc job ảnh/video/âm thanh/3D bất đồng bộ cần tiếp tục sau | [Atlas Cloud](/vi/commands/atlascloud/) |
| Bất kỳ model Replicate, ảnh hoặc video; tiếp tục/hủy theo prediction ID | [Replicate](/vi/commands/replicate/) |
| Video Runway Gen-4.5 / Gen-4 Turbo hoặc ảnh Gen-4; tiếp tục/hủy theo task ID | [Runway](/vi/commands/runway/) |
| Video avatar từ prompt (Video Agent) hoặc kịch bản chính xác, dịch video, lipsync | [HeyGen](/vi/commands/heygen/) |
| Convert tài liệu hoặc tối ưu media local | [Media và tài liệu](/vi/commands/media-and-documents/) |
| Tự cập nhật CLI | [Tổng quan lệnh](/vi/commands/#tự-cập-nhật) |

Khi khác với tài liệu đã lưu, hãy coi `--help` và `multix check` chạy thành công
là nguồn chính xác nhất.
