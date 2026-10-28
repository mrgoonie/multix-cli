---
title: Danh mục provider
description: Chọn tài liệu lệnh có đối chiếu source cho từng AI provider của multix.
---

## Trang provider

| Provider | Bắt đầu | Dùng cho | Ràng buộc cần nhớ |
| --- | --- | --- | --- |
| Gemini | [Lệnh](/vi/commands/gemini/) | Analysis, ảnh/video và TTS | Video dùng Gemini Omni Flash và cần key đã bật billing. |
| OpenAI | [Lệnh](/vi/commands/openai/) | Ảnh, TTS và STT | Codex là driver ảnh experimental. |
| MiniMax | [Lệnh](/vi/commands/minimax/) | Ảnh, video, TTS và music | `i2i` giữ chủ thể cho scene mới, không chỉnh trực tiếp ảnh input. |
| OpenRouter | [Lệnh](/vi/commands/openrouter/) | Model ảnh, image-to-video, TTS và STT qua routing | Khung hình i2v là HTTPS URL; job có thể poll. |
| Leonardo | [Lệnh](/vi/commands/leonardo/) | Ảnh, video, upscale và account | i2i/i2v dùng Leonardo image ID có sẵn. |
| BytePlus | [Lệnh](/vi/commands/byteplus/) | Seedream, Seedance, reference video và 3D | Dùng `status` sau khi submit async. |
| Cloudflare | [Lệnh](/vi/commands/cloudflare/) | Workers AI image/speech và AI Gateway video | Video cần AI Gateway ID và Replicate token. |
| ElevenLabs | [Lệnh](/vi/commands/elevenlabs/) | Voice, speech, audio và dubbing | Dubbing có workflow job/status. |
| Fish Audio | [Lệnh](/vi/commands/fish/) | TTS qua API gốc (mặc định Drama 3), hội thoại nhiều giọng, từ điển phát âm, voice model | Model là đúng giá trị header `model`; tách biệt với model `fish-audio/*` của OpenRouter và giá của chúng. |
| fal.ai | [Lệnh](/vi/commands/fal/) | Bất kỳ model queue nào, cộng lệnh tiện lợi image/video | Status/result dùng app id của model (hai segment đầu path), không phải model id đầy đủ. |
| Atlas Cloud | [Lệnh](/vi/commands/atlascloud/) | Mọi model: ảnh, chỉnh sửa ảnh, video, âm thanh và 3D | Đầu vào được kiểm tra theo schema của từng model; `--async` cùng `status --wait --download` để tiếp tục job. |
| Replicate | [Lệnh](/vi/commands/replicate/) | Bất kỳ model nào qua API trực tiếp, cộng lệnh tiện lợi image/video | Model cộng đồng cần version; tiếp tục hoặc hủy job theo prediction ID. |
| Runway | [Lệnh](/vi/commands/runway/) | Video Gen-4.5 / Gen-4 Turbo và ảnh Gen-4 | `video` chỉ in task ID trừ khi có `--wait`; tiếp tục bằng `status <id> --wait --download`. |
| HeyGen | [Lệnh](/vi/commands/heygen/) | Video Agent (tạo video từ prompt), video avatar theo kịch bản, dịch video, lipsync, TTS, template | Credit API tính riêng với gói web của HeyGen; dùng `status --type` khớp với job (`agent` nhận session ID). |
| Sume | [Lệnh](/vi/commands/sume/) | Ảnh và video với mọi model trong catalog công khai; t2i, i2i, t2v, i2v, tham chiếu, lipsync | Dùng REST API gốc, không dùng MCP do Sume host. Giá job được giữ khi gửi, thu khi thành công và hoàn khi thất bại. |
| TopView | [Lệnh](/vi/commands/topview/) | Video marketing từ link sản phẩm hoặc tư liệu, video avatar, product avatar, ảnh sản phẩm (legacy API); video Seedance, Wan, MiniMax, TopView T1 và GPT Image 2 (API Platform) | Hai API và hai key riêng: legacy API tiêu credit gói topview.ai (`TOPVIEW_API_KEY` + `TOPVIEW_UID`), API Platform tiêu số dư USD riêng (`TOPVIEW_API_PLATFORM_KEY`). Không có lệnh hủy; tiếp tục bằng `status --task`. |

Chạy `multix <provider> --help` và `--help` của từng subcommand trước khi tự
động hóa. Đó là nguồn chuẩn cho option và default hiện tại.
