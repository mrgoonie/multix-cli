---
title: Lệnh speech
description: Text-to-speech qua Gemini, OpenAI, ElevenLabs, MiniMax, Atlas Cloud và Fish Audio với một kiểu request và routing tường minh.
---

`multix speech` gom các model text-to-speech của nhiều provider sau cùng một bộ
flag. Nó không thay thế lệnh của từng provider (`gemini generate-speech`,
`openai generate-speech`, `elevenlabs tts`, `minimax generate-speech`,
`atlas audio`, `fish tts`); các lệnh đó vẫn hoạt động như cũ. Dùng `speech` khi muốn so
sánh provider, chọn model theo ngôn ngữ, hoặc để agent chọn mà không phải học
flag riêng của từng provider.

Provider: `gemini`, `openai`, `elevenlabs`, `minimax`, `atlas`, `fish`. Mỗi provider
cần key riêng (xem [Biến môi trường](/vi/reference/environment/)); không có key
mới.

## Tìm model

```bash
multix speech models                     # mọi model speech, nhóm theo provider
multix speech models --language vi       # chỉ model có ghi nhận tiếng Việt
multix speech models -p minimax --json   # một provider, dạng mảng JSON
multix speech models --ready             # chỉ provider đã có key
```

Mỗi dòng cho biết ngôn ngữ được ghi nhận, định dạng audio, model có nhận
`--style` không, các emotion có tên, số giọng tối đa, hỗ trợ async, cách đặt
tên voice (và lệnh liệt kê voice), các key `--extra` riêng của provider, cách
provider tính phí, cùng nguồn và ngày kiểm chứng. Model mặc định của provider
được đánh dấu. `--language` ẩn các model mà provider không công bố danh sách
ngôn ngữ; output dạng bảng nêu tên các model bị ẩn.

Các dòng lấy từ catalog của chính CLI (`src/speech/speech-catalog.ts`); hãy coi
output `multix speech models` của bản đang cài là hiện hành, không phải trang
này.

## Tạo speech

```bash
multix speech generate --provider openai --text "Welcome to multix." --output welcome.mp3
multix speech generate --provider elevenlabs --model eleven_v3 --language vi \
  --text-file intro.txt --output intro.mp3
```

Chạy `multix speech generate --help` để xem đầy đủ flag. Các flag chính:

| Flag | Ý nghĩa |
| --- | --- |
| `--provider <name>` | Provider sẽ chạy. |
| `--model <id>` | Model id; mặc định là model TTS mặc định của provider. |
| `--text <str>` / `--text-file <path>` | Văn bản, viết trực tiếp hoặc đọc từ file UTF-8 (chọn một, không dùng cả hai). |
| `--voice <id>` | Voice của provider đã chọn; mặc định là voice mặc định của provider đó. |
| `--speaker <name:voice>` | Hội thoại nhiều giọng (lặp lại được; Gemini, tối đa 2). Mỗi dòng văn bản bắt đầu bằng `name:`. |
| `--language <code>` | Mã ngôn ngữ (ví dụ `vi`, `fil`), được đối chiếu với danh sách ngôn ngữ của model. |
| `--style <text>` | Chỉ dẫn cách đọc, cho model hỗ trợ style. |
| `--emotion <name>` | Emotion có tên, cho model có tham số emotion (MiniMax). |
| `--format <fmt>` | Định dạng audio; nếu bỏ trống thì lấy từ đuôi `--output` hoặc định dạng đầu tiên của model. |
| `--output <path>` | Sao chép audio tới đường dẫn này. |
| `--async` | Gửi job rồi in job id và lệnh tiếp tục (model hỗ trợ async, như Atlas Cloud). |
| `--fallback <route>` | Route dự phòng `provider[:model[:voice]]` phải tự bật (lặp lại được); xem bên dưới. |
| `--extra <provider.key=value>` | Tùy chọn riêng của provider, ví dụ `elevenlabs.stability=0.4` (lặp lại được). |

Toàn bộ request được kiểm tra trước khi gọi provider, và mọi lỗi được báo cùng
lúc: voice thuộc provider khác, ngôn ngữ model không ghi nhận, `--style` hoặc
`--emotion` trên model không hỗ trợ, định dạng model không ghi được, `--async`
trên model đồng bộ, hoặc key `--extra` provider không nhận.

### Hội thoại tiếng Việt (Gemini, hai giọng)

```bash
cat > scene.txt <<'EOF'
Lan: Chào anh Minh, hôm nay anh khỏe không?
Minh: Chào Lan, anh khỏe lắm, cảm ơn em!
EOF

multix speech generate --provider gemini --language vi \
  --text-file scene.txt \
  --speaker "Lan:Kore" --speaker "Minh:Puck" \
  --output scene.wav
```

### Tiếng Việt có emotion (MiniMax)

```bash
multix speech generate --provider minimax --language vi --emotion happy \
  --text "Xin chào các bạn, chào mừng đến với multix!" --output hello.mp3
```

MiniMax nhận `--language` qua giá trị `language_boost`; dòng tương ứng trong
`multix speech models` cho biết mỗi provider dùng field request nào.

### Fish Audio

```bash
multix speech generate --provider fish --model drama-3 \
  --text "Welcome to multix." --extra fish.speed=1.1 --output welcome.mp3
```

Route này gửi cùng request gốc như
[`multix fish tts`](/vi/commands/fish/), với voice mặc định Adrian trừ khi
`--voice` chỉ định voice khác. Route chỉ gửi một voice; với hội thoại nhiều
giọng, dùng `multix fish tts --turns-file`. `--extra` nhận `fish.temperature`,
`fish.top_p`, `fish.speed`, `fish.volume`, `fish.chunk_length`,
`fish.normalize` và `fish.latency`.

## Quy tắc routing

Mỗi provider tính phí speech khác nhau và voice không thay thế được cho nhau,
nên routing luôn tường minh:

- **Không tự đổi provider.** Bạn chọn provider bằng `--provider`. Nếu thiếu,
  chỉ chấp nhận `--model` khi đúng một provider phục vụ model id đó; kết quả
  khi đó ghi `provider_inferred: true`. Thiếu cả hai, lệnh dừng và chỉ tới
  `multix speech models`.
- **Fallback phải tự bật.** Route `--fallback` chỉ được dùng khi mọi route
  trước nó không thể bắt đầu vì thiếu API key. Việc kiểm tra này diễn ra trước
  mọi request tính phí, và mỗi route fallback được kiểm tra ngay từ đầu như
  route chính. Fallback sang provider khác dùng voice mặc định của provider đó,
  trừ khi route ghi rõ voice (`minimax::<voice-id>`); `--voice` không bao giờ
  được mang sang provider khác.
- **Văn bản quá dài bị từ chối, không bị cắt.** Model có giới hạn ký tự được
  công bố (`max_chars` trong `speech models`) từ chối văn bản dài hơn trước khi
  gửi request.
- **Không trả phí hai lần.** Khi đã gọi provider, lỗi được báo nguyên trạng và
  không bao giờ được gửi lại qua route khác.
- **Việc chuyển route luôn hiển thị.** Khi dùng fallback, một cảnh báo trên
  stderr nêu cả hai route, key bị thiếu, voice thay đổi, cách tính phí của
  provider mới và định dạng nếu đổi; với `--json`, các chi tiết này nằm trong
  `data.fallback`.

```bash
multix speech generate --provider elevenlabs --model eleven_v3 --language vi \
  --text "Xin chào" --fallback openai:gpt-4o-mini-tts:nova --output hello.mp3
```

## Chế độ agent

Các flag toàn cục `--json` và `--dry-run` hoạt động như ở mọi lệnh khác
([Dành cho AI agent](/vi/reference/for-ai-agents/)).

- `--dry-run` kiểm tra request, chọn route và hiển thị request đầu tiên gửi tới
  provider thay vì gửi đi. Atlas Cloud đọc input schema của model trước, nên
  dry run của nó hiển thị bước tra cứu đó chứ không phải request submit.
- Với `--json`, `data` là object `multix.speech.result/v1`: `request` (schema
  `multix.speech.request/v1`; văn bản chỉ được ghi dưới dạng `text_chars` và
  `text_sha256`; `request.body` của dry run vẫn hiển thị văn bản), `route` (provider, model, voice,
  format), `fallback` khi có dùng, cùng các file hoặc `job` async.
- `multix models --task speech` liệt kê `multix speech generate` cạnh các lệnh
  của từng provider.

```bash
multix speech models --language vi --json
multix speech generate --provider gemini --language vi --text-file scene.txt \
  --speaker "Lan:Kore" --speaker "Minh:Puck" --output scene.wav --dry-run --json
```

## MCP server từ xa

Trên [MCP server từ xa](/vi/guides/mcp-server/), `speech generate` bắt buộc có
`--provider`, và job chỉ nhận key của các provider được nêu trong `--provider`
và `--fallback`. Truyền `--text-file` dưới dạng URL `https://` trong `inputs`.
`speech models --ready` không dùng được từ xa; `multix_catalog` cho biết bạn đã
lưu key của provider nào.
