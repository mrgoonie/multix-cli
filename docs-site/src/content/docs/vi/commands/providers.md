---
title: Danh mục provider
description: Chọn tài liệu lệnh có đối chiếu source cho từng AI provider của multix.
---

## Trang provider

| Provider | Bắt đầu | Dùng cho | Ràng buộc cần nhớ |
| --- | --- | --- | --- |
| Gemini | [Lệnh](/vi/commands/gemini/) | Analysis, ảnh/video và TTS | Video là experimental. |
| OpenAI | [Lệnh](/vi/commands/openai/) | Ảnh, TTS và STT | Codex là driver ảnh experimental. |
| MiniMax | [Lệnh](/vi/commands/minimax/) | Ảnh, video, TTS và music | `i2i` giữ chủ thể cho scene mới, không chỉnh trực tiếp ảnh input. |
| OpenRouter | [Lệnh](/vi/commands/openrouter/) | Model ảnh và image-to-video qua routing | Khung hình i2v là HTTPS URL; job có thể poll. |
| Leonardo | [Lệnh](/vi/commands/leonardo/) | Ảnh, video, upscale và account | i2i/i2v dùng Leonardo image ID có sẵn. |
| BytePlus | [Lệnh](/vi/commands/byteplus/) | Seedream, Seedance, reference video và 3D | Dùng `status` sau khi submit async. |
| Cloudflare | [Lệnh](/vi/commands/cloudflare/) | Workers AI image/speech và AI Gateway video | Video cần AI Gateway ID và Replicate token. |
| ElevenLabs | [Lệnh](/vi/commands/elevenlabs/) | Voice, speech, audio và dubbing | Dubbing có workflow job/status. |
| fal.ai | [Lệnh](/vi/commands/fal/) | Bất kỳ model queue nào, cộng lệnh tiện lợi image/video | Status/result dùng app id của model (hai segment đầu path), không phải model id đầy đủ. |

Chạy `multix <provider> --help` và `--help` của từng subcommand trước khi tự
động hóa. Đó là nguồn chuẩn cho option và default hiện tại.
