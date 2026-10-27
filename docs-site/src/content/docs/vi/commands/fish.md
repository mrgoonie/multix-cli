---
title: Lệnh Fish Audio
description: Text-to-speech qua API gốc của Fish Audio (mặc định Drama 3), hội thoại nhiều giọng, từ điển phát âm và tra cứu voice model.
---

Lệnh Fish Audio dùng API gốc của Fish Audio và cần `FISH_API_KEY` (tạo tại
[fish.audio/app/api-keys](https://fish.audio/app/api-keys/)). Kiểm tra CLI đã
cài trước khi tự động hóa: `multix fish <command> --help`.

## Text-to-speech

```bash
multix fish tts --text "Welcome to multix." --voice adrian --output welcome.mp3
multix fish tts --text-file intro.txt --voice <voice-id> --format wav --output intro.wav
multix fish tts --model s2.1-pro --text "[whispering] Can you hear me?" --voice delia
```

Truyền văn bản bằng `--text` (alias `--prompt`), `--text-file` (UTF-8, tối đa
1 MiB), hoặc `--turns-file` cho hội thoại; chỉ chọn một. Mỗi request mang tối
đa 200.000 byte UTF-8; văn bản dài hơn cần tách ra. Audio được lưu thành
`fish_tts_<stamp>.<ext>` trong thư mục output và được sao chép tới `--output`
nếu có.

`--voice` nhận voice model id của Fish (`reference_id`) hoặc một trong các
voice công khai `adrian`, `delia` và `sheila`. Không có `--voice`, `fish tts`
không gửi voice nào và Fish tự chọn.

## Model

| Model | Ghi chú |
| --- | --- |
| `drama-3` (mặc định) | Hỗ trợ nhiều giọng. |
| `s2.1-pro` | Model Fish dùng khi header `model` bị thiếu hoặc không khớp chính xác. |
| `s2.1-pro-free` | Fish niêm yết giá $0. |
| `s2-pro` | Hỗ trợ nhiều giọng. |
| `s1` | Một voice mỗi request; không nhận văn bản nhiều giọng. |

Đặt model mặc định bằng `--model` hoặc `FISH_TTS_MODEL`. Giá tính theo từng
byte UTF-8 của văn bản đúng như khi gửi, kể cả tag; xem
[bảng giá](/vi/reference/for-ai-agents/#bảng-giá).

### Vì sao header model bị giới hạn

Fish chọn model theo đúng giá trị header HTTP `model`, không theo body của
request. Header bị thiếu hoặc viết sai vẫn được phục vụ, và tính phí, như
`s2.1-pro` với response 200 bình thường, và response audio không ghi tên model
đã chạy. Vì vậy multix chỉ gửi các giá trị trong danh sách trên và từ chối mọi
giá trị khác trước khi gửi. Kết quả JSON ghi `model_header_sent` cùng
`model_confirmed_by_response: false`: header là thứ multix đã gửi, không phải
model mà Fish xác nhận. `--dry-run` hiển thị giá trị header `model`; giá trị
của mọi header khác vẫn bị ẩn.

## Tùy chọn

| Flag | Ý nghĩa |
| --- | --- |
| `--format <fmt>` | `mp3` (mặc định), `wav`, `pcm` hoặc `opus`. |
| `--sample-rate <hz>` | wav/pcm: 8000, 16000, 24000, 32000 hoặc 44100; mp3: 32000 hoặc 44100; mặc định 44100. Opus luôn là 48000. |
| `--mp3-bitrate <kbps>` | `64`, `128` hoặc `192` (với `--format mp3`). |
| `--opus-bitrate <bps>` | `-1000` (tự động), `24000`, `32000`, `48000` hoặc `64000` (với `--format opus`). |
| `--temperature <n>`, `--top-p <n>` | Lấy mẫu, 0 đến 1. |
| `--speed <n>` | Tốc độ đọc, 0,5 đến 2. |
| `--volume <db>` | Thay đổi âm lượng theo dB (0 = giữ nguyên). |
| `--no-normalize-loudness` | Tắt chuẩn hóa độ lớn âm thanh (họ S2). |
| `--chunk-length <n>` | Số ký tự mỗi đoạn tổng hợp, 100 đến 300. |
| `--no-normalize` | Tắt chuẩn hóa văn bản (số, ngày tháng). |
| `--language <bcp47>` | Gợi ý ngôn ngữ cho bước chuẩn hóa văn bản, ví dụ `en`, `vi` hoặc `es-MX`. |
| `--latency <mode>` | `low`, `normal` hoặc `balanced`. |

## Tag và phoneme

Văn bản được gửi đúng như khi viết. Tag chỉ dẫn như `[whispering]` và tag
phoneme (`<|phoneme_start|>…<|phoneme_end|>`) là cú pháp của Fish và không bao
giờ bị xóa hay viết lại. Fish chỉ ghi nhận phoneme cho tiếng Anh (Arpabet),
tiếng Trung (pinyin) và tiếng Nhật (romaji). Tag phoneme không cân đối sẽ kèm
cảnh báo, vì Fish có thể đọc chúng thành tiếng.

## Hội thoại nhiều giọng

`drama-3`, `s2.1-pro`, `s2.1-pro-free` và `s2-pro` lồng tiếng tối đa 10 người
nói trong một request. Gắn `<|speaker:N|>` trước mỗi lượt và truyền một
`--voice` cho mỗi người nói, theo thứ tự chỉ số (`--voice` của speaker 0 đứng
đầu):

```bash
multix fish tts --voice adrian --voice sheila \
  --text "<|speaker:0|>Did you hear that?<|speaker:1|>[whispering] Stay quiet."
```

Hoặc viết các lượt thoại dạng JSON (1 đến 200 lượt, mỗi lượt một voice) để
multix tự tạo văn bản đã gắn tag; khi đó không được dùng `--voice`:

```json
[
  { "text": "Did you hear that?", "voice": "adrian" },
  { "text": "[whispering] Stay quiet.", "voice": "sheila" }
]
```

```bash
multix fish tts --turns-file scene.json --output scene.mp3
```

## Từ điển phát âm

Mỗi request nhận tối đa ba từ điển, theo một trong hai dạng không được trộn
lẫn, vì Fish từ chối request kết hợp cả hai:

- Từ điển đã xuất bản: lặp lại `--dictionary <id>@<version>`. Version phải là
  version id cố định sao chép từ web app Fish Audio; `latest` và số hiển thị
  như `V1` bị từ chối.
- Từ điển inline: một `--dictionary-file` chứa JSON
  `[{"items": [{"key", "value", "case_sensitive"?}]}]` (một mảng items đơn
  được đọc như một từ điển).

Key và value không được chứa `<|phoneme_start|>` hay `<|phoneme_end|>`; Fish
tự bọc value. Fish bỏ qua tham chiếu đã xuất bản mà nó không tìm thấy và vẫn
trả audio, nên multix cảnh báo rằng response 200 không chứng minh từ điển đã
được áp dụng.

## Kết quả và lỗi

- Request POST tính phí chỉ được gửi một lần và không bao giờ thử lại. Request
  bị ngắt sau khi Fish có thể đã nhận sẽ kết thúc với `UNKNOWN_REMOTE_STATE`;
  kiểm tra mức sử dụng trên fish.audio trước khi gửi lại.
- Audio được kiểm tra: chữ ký container, sample rate, thời lượng và SHA-256.
  Response 200 có body không phải audio đã yêu cầu sẽ báo lỗi; các byte được
  lưu lại để kiểm tra trước, trừ khi Fish gắn nhãn JSON hoặc HTML, khi đó lỗi
  kèm thông báo của Fish. Các vấn đề nhỏ hơn khi kiểm tra được báo dưới dạng
  cảnh báo.
- Với `--json`, kết quả gồm `model_requested`, `model_header_sent`,
  `model_confirmed_by_response`, `voices`, `speakers`, `input_chars`,
  `input_utf8_bytes`, `text_sha256`, `bytes`, `sha256`, `sample_rate_hz`,
  `duration_s`, `estimated_cost_usd`, `rate_id` và `warnings`. Văn bản chỉ
  được ghi dưới dạng độ dài và hash.

`--estimate` và `--max-cost` hoạt động với `fish tts`, kể cả văn bản đọc từ
`--text-file` hoặc `--turns-file`; xem
[Chi phí](/vi/reference/for-ai-agents/#chi-phí-ước-tính-giới-hạn-chi-tiêu-và-biên-nhận).

## Voice model

Liệt kê và đọc voice là request miễn phí.

```bash
multix fish voices list                          # voice model của bạn
multix fish voices list --public --language vi --title narrator
multix fish voices list --page-size 50 --page 2
multix fish voices get <voice-id>
```

## Fish Audio gốc và OpenRouter

`multix fish tts` và các model `fish-audio/*` của OpenRouter
([`openrouter tts`](/vi/commands/openrouter/)) là hai route riêng với giá
riêng. multix không bao giờ fallback từ route này sang route kia. Model Fish
trên OpenRouter cũng được tính giá theo byte UTF-8, và kết quả JSON của chúng
có `input_utf8_bytes`.

`multix speech generate --provider fish` chạy cùng request gốc đó qua bộ flag
speech chung; xem [Lệnh speech](/vi/commands/speech/).
