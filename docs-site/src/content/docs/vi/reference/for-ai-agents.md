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
   Các runner chung (`fal run`, `replicate run`, OpenRouter, Atlas) chuyển
   thẳng mọi model id của provider và được đánh dấu `any_model` kèm
   `model_scope`; multix chưa xác minh các id đó. Model đã xác minh có input đã
   biết: `multix models --model <id>` hiển thị input, voice, định dạng đầu ra
   và một ví dụ (id không có trong danh sách trả về `verified: null`), và
   `fal run` cảnh báo khi `--input` không khớp với model. Speech qua fal: các
   model TTS của ElevenLabs và Gemini dùng `fal tts` (flag có kiểu, được kiểm
   tra trước khi gửi; id TTS khác của fal cần `--text-field`), còn MiniMax dùng
   một dòng `fal run` chỉ nêu model đã xác minh đó.
   `multix models --task <task> --live` liệt kê thêm những model mà catalog
   của fal và OpenRouter đang phục vụ, mỗi model được đánh dấu `verified` hay
   không, kèm `listed` (`true`/`false`, hoặc `null` khi không đọc được toàn bộ catalog)
   và trạng thái `missing` cho model đã xác minh mà catalog không còn liệt kê
   (đã bị gỡ hoặc đổi tên). Catalog được cache một ngày trong
   `~/.multix/cache/models` (`--refresh` để tải lại; `MULTIX_CACHE_DIR` và
   `MULTIX_MODELS_TTL` đổi thư mục và TTL tính bằng giây, tối đa 7 ngày). Khi offline, bản
   cache cũ được dùng; không có bản nào thì catalog là `unavailable` và không
   model nào được coi là có sẵn.
2. **Kiểm tra miễn phí.** Thêm `--dry-run` vào bất kỳ lệnh nào: các bước kiểm
   tra cục bộ vẫn chạy (flag, file đầu vào, key), rồi request đầu tiên tới
   provider được in ra (method, URL không có query string, body với giá trị dài
   đã rút gọn, chỉ tên header) thay vì gửi đi. Lệnh `media` cục bộ dừng trước
   khi chạy. Thêm `--estimate` để ước tính chi phí, và `--max-cost <usd>` để
   đặt trần chi phí; xem [Chi phí](#chi-phí-ước-tính-giới-hạn-chi-tiêu-và-biên-nhận).
3. **Chạy với `--json`** (hoặc `MULTIX_OUTPUT=json`). stdout đúng một dòng, là
   envelope `multix.result/v1`; output cho người đọc được giữ lại.
4. **Tự kiểm tra kết quả.** Thành công nghĩa là `ok: true`, `outputs` không rỗng
   và không có `warnings` (`EMPTY_OUTPUT`, `CONTENT_MISMATCH`, `UNREADABLE_MEDIA`).
5. **Khi lỗi** làm theo `error.hint` và `next[]`; đừng gửi lại job tính phí một
   cách mù quáng. multix không bao giờ tự gửi lại một lần submit tính phí mà
   provider có thể đã nhận: nó chỉ thử lại việc đọc trạng thái và tải file, và
   chỉ thử lại submit khi provider chứng minh chưa tạo gì (ví dụ lỗi 429).
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
| `usage` | Số liệu provider trả về: `tokens` (`input`, `output`, `total`, `thinking`), `cost_usd`, `credits` và các `metrics` dạng số khác theo key path. `sources.cost_usd` / `sources.credits` ghi nguồn của từng số (ví dụ `api.elevenlabs.io header.character-cost`). Không ước tính: số ước tính hoặc báo giá của provider (như `estimatedCost` của Runway) chỉ nằm trong `metrics`, không bao giờ được báo là `cost_usd` hay `credits`. `cost_usd` và `credits` là số đã tiêu cho lần chạy: số dư tài khoản (`apiCredit` của Leonardo từ `leonardo me`, credit còn lại hoặc credit đi kèm gói của HeyGen từ `heygen me`) không bao giờ được tính vào `credits` hay `cost_usd`. |
| `http` | Số request tới provider, số request lỗi và tổng thời gian. |
| `provider_ids` | Request id, job id hoặc prediction id provider trả về. |
| `request` | Với `--dry-run`: request lẽ ra đã được gửi. Giá trị header, các trường có tên dạng secret và query string của URL (URL đã ký) đều bị che. |
| `estimate` | Giá ước tính trước khi chạy (với `--estimate`, `--max-cost`, hoặc với lệnh có bảng giá). `estimate_only: true` đánh dấu lần chạy `--estimate`. |
| `budget` | Với `--max-cost`: `ok`, `max_cost_usd`, `policy`, cùng `code` và `message` khi bị từ chối. |
| `cost` | Biên nhận chi phí của lần chạy (`multix.cost/v1`); xem [Biên nhận chi phí](#biên-nhận-chi-phí). |
| `next[]` | Lệnh nên chạy tiếp: lệnh status của job async, `multix check` khi lỗi key, `multix rerun <id>` khi lỗi tạm thời. |

## Exit code và mã lỗi

| Exit | Nhóm | Mã lỗi | Cần làm |
| --- | --- | --- | --- |
| 0 | thành công | | |
| 2 | sai cú pháp hoặc input | `USAGE`, `INVALID_INPUT`, `BUDGET_EXCEEDED`, `BUDGET_UNPROVEN` | Sửa flag; chưa bị tính phí. Với lỗi ngân sách, chạy lệnh `--estimate` trong `next[]`. |
| 3 | key hoặc cài đặt | `MISSING_KEY`, `INVALID_KEY`, `CONFIG_ERROR`, `BINARY_MISSING` | `multix check`, đặt key có tên trong `error.env`. |
| 4 | tạm thời | `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR` | Chờ `retry_after_s`, rồi `multix rerun <id>`. |
| 5 | bị từ chối | `QUOTA_EXCEEDED`, `CONTENT_BLOCKED`, `MODEL_NOT_FOUND`, `NOT_FOUND`, `PROVIDER_REJECTED`, `JOB_FAILED`, `RESPONSE_TOO_LARGE` | Đổi input, model hoặc provider. |
| 6 | hết thời gian hoặc không rõ | `TIMEOUT`, `UNKNOWN_REMOTE_STATE` | Job có thể vẫn đang chạy: dùng lệnh status trong `next[]`. `UNKNOWN_REMOTE_STATE`: lần submit thất bại mà không chứng minh được provider đã từ chối (bị cắt kết nối, lỗi gateway 5xx) nên job có thể đã vào hàng đợi; kiểm tra danh sách request của provider trước khi submit lại. |
| 1 | không rõ | `UNKNOWN` | Đọc `log[]` (các dòng stderr cuối). |

Các nhóm exit code này áp dụng ở agent mode (`--json` hoặc `MULTIX_OUTPUT=json`).
Không có chế độ đó, lệnh lỗi vẫn exit 1 như các phiên bản trước và in thêm các
dòng `code:`, `hint:` và `next:` ra stderr. Ledger lịch sử luôn ghi mã lỗi.

## Chi phí: ước tính, giới hạn chi tiêu và biên nhận

Mọi lệnh provider có gửi request đều nhận ba flag chi phí:

- `--estimate` ước tính chi phí lần chạy và không bao giờ gọi API tính phí. Lệnh
  in chi phí thấp, dự kiến và cao (USD), số đơn vị đếm theo từng meter, rate id,
  URL nguồn và ngày `last_checked`, các giả định, rồi exit 0. Với `--json`,
  envelope có `estimate_only: true` và `estimate`.
- `--max-cost <usd>` từ chối an toàn trước khi gửi bất cứ thứ gì.
  `BUDGET_EXCEEDED`: mức trần vượt giới hạn. `BUDGET_UNPROVEN`: không rõ giá,
  hoặc mức trần chỉ là ước tính. Cả hai exit 2 khi có `--json`, và `next[]` gợi
  ý chính lệnh đó kèm `--estimate`.
- `--cost-policy strict|estimate` (dùng cùng `--max-cost`). `strict`, mặc định,
  chỉ cho qua mức trần đã chứng minh; `estimate` chấp nhận mức cao ước tính.

```text
$ multix elevenlabs tts --text "Xin chào thế giới" --estimate
Estimate: $0.00136 expected, $0.00136–$0.00136 range (proven ceiling)
  model: elevenlabs eleven_multilingual_v2
  text: 17 characters (17 after NFC), 22 UTF-8 bytes
  units: characters 17
  rate: elevenlabs/multilingual@api (list), checked 2026-10-26, https://elevenlabs.io/pricing/api
  Nothing was sent; no provider was billed.
```

### Lệnh có bảng giá

| Lệnh | Tính phí theo | Mức trần |
| --- | --- | --- |
| `gemini generate-speech` | Token văn bản đầu vào, token âm thanh đầu ra (25 token mỗi giây âm thanh) | Ước tính: model quyết định độ dài âm thanh, nên `--max-cost` cần `--cost-policy estimate`. |
| `elevenlabs tts` | Ký tự (Unicode code point đúng như khi gửi) | Đã chứng minh. `--previous-text` và `--next-text` chỉ được tính vào mức cao. |

Mọi lệnh hoặc model khác có trạng thái ước tính `unknown`, không bao giờ là $0,
và `--max-cost` từ chối chạy.

### Bảng giá

Giá nằm trong một catalog có version (`multix.pricing/v1`,
[`src/budget/pricing-catalog.ts`](https://github.com/mrgoonie/multix-cli/blob/main/src/budget/pricing-catalog.ts)):
USD theo đơn vị, các khung giá có ngày hiệu lực (khuyến mãi và thay đổi đã lên
lịch), tier tính phí, `last_checked`, URL nguồn và cờ đã xác minh. Giá bị thiếu,
chưa xác minh, hoặc được kiểm tra lần cuối hơn 120 ngày trước sẽ thành
`unknown`. Trong vòng 24 giờ quanh một lần đổi giá, mức cao dùng giá cao hơn.

Giá được kiểm tra ngày 2026-10-26 (`--estimate` hiển thị giá đang áp dụng):

| Rate id | Model | Giá (USD) |
| --- | --- | --- |
| `gemini/gemini-3.8-flash-tts@paid-standard` | `gemini-3.8-flash-tts` | $0,50 / 1 triệu token đầu vào, $9 / 1 triệu token âm thanh; từ 2027-01-01: $1 và $18 |
| `gemini/gemini-3.8-flash-lite-tts@paid-standard` | `gemini-3.8-flash-lite-tts` | $0,50 / 1 triệu token đầu vào, $6 / 1 triệu token âm thanh; từ 2027-01-01: $1 và $12 |
| `gemini/gemini-3.1-flash-tts-preview@paid-standard` | `gemini-3.1-flash-tts-preview` | $1 / 1 triệu token đầu vào, $20 / 1 triệu token âm thanh |
| `gemini/gemini-2.5-flash-preview-tts@paid-standard` | `gemini-2.5-flash-preview-tts` | $0,50 / 1 triệu token đầu vào, $10 / 1 triệu token âm thanh |
| `gemini/gemini-2.5-pro-preview-tts@paid-standard` | `gemini-2.5-pro-preview-tts` | $1 / 1 triệu token đầu vào, $20 / 1 triệu token âm thanh |
| `elevenlabs/multilingual@api` | `eleven_v4`, `eleven_v3`, `eleven_multilingual_v2` | $0,08 / 1.000 ký tự |
| `elevenlabs/flash-turbo@api` | `eleven_v4_turbo`, `eleven_flash_v2_5`, `eleven_flash_v2`, `eleven_turbo_v2_5`, `eleven_turbo_v2` | $0,04 / 1.000 ký tự |
| `fish/s2-pro@api` | `s2.1-pro`, `s2-pro` | $15 / 1 triệu byte UTF-8 |
| `fish/s1@api` | `s1` | $15 / 1 triệu byte UTF-8 |
| `fish/drama-3@api` | `drama-3` | $10 / 1 triệu byte UTF-8 (khuyến mãi đến 2026-11-12T17:00Z), sau đó $50 |

Giá Gemini là tier Standard trả phí; tier miễn phí không tốn tiền. Gói thuê bao
ElevenLabs trừ credit thay vì USD. Giá Fish Audio được giữ sẵn cho provider Fish
sắp có; chưa lệnh nào dùng đến.

### Biên nhận chi phí

Mọi envelope `--json` của lệnh provider, cùng mục lịch sử của nó, mang một biên
nhận `cost` (`multix.cost/v1`):

| Trường | Ý nghĩa |
| --- | --- |
| `operation_id` | Thao tác logic mà lần chạy thuộc về; xem `MULTIX_OPERATION_ID` bên dưới. |
| `role` | `charge` (đã gửi request tính phí), `observation` (chỉ đọc trạng thái hoặc tải file) hoặc `none` (không gửi gì). |
| `status` | `settled` (provider báo, hoặc $0 vì không gửi gì hay provider từ chối mọi request tính phí bằng lỗi 4xx), `computed` (usage đo được nhân giá trong catalog), `uncertain` (đã gửi request tính phí rồi lần chạy lỗi hoặc bị cắt), `unknown`. |
| `estimate` | Khoảng ước tính trước khi chạy ở dạng rút gọn, kèm rate id, nguồn và `last_checked`. |
| `provider_reported` | `cost_usd` và `credits` đúng như provider báo; `null` khi không báo, và `null` không có nghĩa là $0. |
| `actual_usd`, `actual_source` | Chi phí thực và nguồn của nó: `provider_reported`, `computed_from_usage`, `no_request` hoặc `refused`. `null` khi không rõ hoặc không chắc chắn. |
| `measured` | Số đơn vị dùng để tính chi phí thực. |
| `variance_usd` | Chi phí thực trừ chi phí dự kiến. |
| `max_cost_usd`, `policy` | Giới hạn `--max-cost` và policy, khi có đặt. |

Ở chế độ text, lệnh in một dòng biên nhận `Cost: …` ra stderr.

`MULTIX_OPERATION_ID` đặt tên cho thao tác logic, để các lần chạy của nó chỉ
được tính một lần: poll trạng thái và tải file không cộng thêm gì, biên nhận gửi
lại chỉ tính một lần, con số provider báo sẽ chốt chi phí của thao tác, và chỉ
mỗi lần submit tính phí riêng biệt (submit lại thì bị tính phí lại) mới cộng
thêm chi phí. Lần chạy không gửi gì không bao giờ làm giảm chi phí của thao tác. Mặc định là
`<provider>:<job id>`, hoặc `run:<history id>` khi provider không trả id. Hãy
đặt biến này trong shell cho lần chạy đó; `.env` của project không đặt được.

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

`history stats` bỏ qua các lần chạy `--dry-run` và `--estimate`, và tính chi phí
mỗi thao tác một lần, chỉ từ các con số đã biết; `cost_uncertain_ops` và
`cost_unknown_ops` đếm số thao tác có chi phí không chắc chắn hoặc không rõ, nên
khi có một trong hai thì `cost_usd` chỉ là cận dưới.

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
