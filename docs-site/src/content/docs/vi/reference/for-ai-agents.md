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

## Quy trình lệnh an toàn

1. Đọc trang lệnh liên quan, sau đó chạy `multix <group> <command> --help` cho
   version đang cài.
2. Chạy `multix check` trước thao tác provider; không in hoặc yêu cầu secret.
3. Dùng `--input`, `--output` và provider flags rõ ràng khi cần tái lập kết quả.
4. Nêu rõ thao tác provider có bất đồng bộ không và giữ lại job ID.

## Bản đồ khả năng

| Nhu cầu | Bắt đầu từ |
| --- | --- |
| Phân tích hoặc transcribe file | [Gemini](/vi/commands/gemini/) |
| Sinh/sửa ảnh, speech hoặc transcription | [OpenAI](/vi/commands/openai/) |
| Ảnh, video, speech hoặc music MiniMax | [MiniMax](/vi/commands/minimax/) |
| Ảnh hoặc image-to-video qua routing | [OpenRouter](/vi/commands/openrouter/) |
| Leonardo image ID, video hoặc upscale job | [Leonardo](/vi/commands/leonardo/) |
| Seedream, Seedance, reference video hoặc 3D | [BytePlus](/vi/commands/byteplus/) |
| Workers AI image/speech hoặc AI Gateway video | [Cloudflare](/vi/commands/cloudflare/) |
| Voice workflow, dubbing hoặc audio generation | [ElevenLabs](/vi/commands/elevenlabs/) |
| Convert tài liệu hoặc tối ưu media local | [Media và tài liệu](/vi/commands/media-and-documents/) |

Khi khác với tài liệu đã lưu, hãy coi `--help` và `multix check` chạy thành công
là nguồn chính xác nhất.
