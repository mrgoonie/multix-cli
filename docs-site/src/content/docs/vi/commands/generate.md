---
title: Generate (mọi provider)
description: Tạo ảnh, video, lip-sync và upscale trên mọi provider với một bộ flag, routing tường minh, và kiểm tra input trước mọi request.
---

`multix generate <task>` gom tạo ảnh, video, lip-sync và upscale của 14
provider sau cùng một bộ flag. Nó không thay thế lệnh của từng provider; nó
ánh xạ request của bạn sang lệnh provider phục vụ được và chạy lệnh đó, nên
kiểm tra input, `--estimate` / `--max-cost`, polling, tải file, history và
envelope `multix.result/v1` đều là của chính lệnh provider. Mỗi provider cần
key riêng (xem [Biến môi trường](/vi/reference/environment/)).

Task: `image` (text-to-image, hoặc sửa ảnh với `--image`), `video`
(text-to-video, hoặc image-to-video với `--image` và tùy chọn `--end-image`),
`lipsync`, `upscale`.

Provider: `gemini`, `minimax`, `openai`, `openrouter`, `leonardo`,
`byteplus`, `cloudflare`, `fal`, `atlas`, `replicate`, `runway`, `sume`,
`topview`, `heygen`.

## Tìm model

```bash
multix models --task video --live                 # mọi provider phục vụ task, kèm model của nó
multix models --task video --live --ready --json  # chỉ provider đã có key, dạng JSON
```

Với `--live` và một task của generate, JSON có thêm `providers`: mỗi provider
phục vụ task là một mục, dù có key hay không.

```json
{
  "provider": "atlas",
  "task": "video",
  "ready": false,
  "keys": ["ATLASCLOUD_API_KEY"],
  "command": "multix generate video --provider atlas --model <id>",
  "default_model": "bytedance/seedance-v1-pro-fast/text-to-video",
  "any_model": true,
  "source": { "kind": "live", "state": "fresh", "url": "https://api.atlascloud.ai/api/v1/models", "fetched_at": "2026-11-07T07:00:00.000Z" },
  "models": [{ "id": "bytedance/seedance-v1-pro-fast/image-to-video", "label": "Seedance V1 Pro Fast", "tasks": ["image-to-video"] }]
}
```

`source.kind` là `live` khi đã đọc được catalog của provider (fal, OpenRouter,
Atlas Cloud, Replicate, Leonardo, Sume, TopView; được cache như các catalog
`--live` khác) và `static` trong trường hợp còn lại. Danh sách cần key, hoặc
lần đọc bị lỗi, sẽ quay về các model multix đã biết, kèm lý do trong
`source.error`. `tasks` là các task năng lực mà model phục vụ (`image`,
`image-edit`, `video`, `image-to-video`, `lipsync`, `upscale`). `any_model`
nghĩa là lệnh nhận bất kỳ model id nào của provider.

## Chạy

```bash
multix generate image "a red fox" --provider fal --aspect-ratio 16:9 --output fox.png
multix generate image "make it night" --provider openai --image day.png
multix generate video "waves at dusk" --model atlas:bytedance/seedance-v1-pro-fast/image-to-video --image frame.png
multix generate video "slow pan" --provider byteplus --image a.png --end-image b.png --duration 5 --no-generate-audio
multix generate lipsync --provider heygen --video in.mp4 --audio line.wav --output out.mp4
multix generate upscale --provider leonardo --image <leonardo-image-id>
```

| Flag | Ý nghĩa |
| --- | --- |
| `--provider <id>` | Provider. Bắt buộc, trừ khi `--model <provider>:<model>` đã nêu. Không có fallback tự động. |
| `--model <id>` | Model id, hoặc `<provider>:<model>`. Mặc định là model mặc định của lệnh provider. |
| `--image <path\|url>` | Ảnh đầu vào, lặp lại được: sửa ảnh, frame đầu, chủ thể lip-sync, nguồn upscale. |
| `--end-image <path\|url>` | Frame cuối của lần chạy image-to-video (cần `--image`). |
| `--video`, `--audio` | Video nguồn và track âm thanh (lip-sync). |
| `--aspect-ratio`, `--resolution`, `--duration`, `--num-images` | Được ánh xạ sang flag và giá trị riêng của provider. |
| `--generate-audio` / `--no-generate-audio` | Âm thanh cho model video có tạo âm thanh. |
| `--output <path>` | Lưu kết quả tại đây (sao chép từ file của lệnh provider khi lệnh đó không có `--output`). |
| `--async` | Gửi job và trả về job id cùng lệnh resume thay vì chờ. |
| `--wait-timeout <ms>` | Thời gian chờ. Mặc định: `MULTIX_WAIT_TIMEOUT`, nếu không thì theo lệnh provider. |
| `--json`, `--dry-run`, `--estimate`, `--max-cost`, `--cost-policy` | Chuyển cho lệnh provider. `--max-cost` bị từ chối khi lệnh đó không áp được. |

Request mà lệnh provider không nhận được (task không hỗ trợ, flag không có
tương đương, file local khi cần URL) sẽ lỗi `CONFIG_ERROR` (exit 3) trước mọi
request, nêu từng trường và các provider làm được task đó.

## Output

Envelope là `multix.result/v1` của lệnh provider, thêm `route`:

```json
{
  "schema": "multix.result/v1",
  "ok": true,
  "command": "fal image",
  "provider": "fal",
  "route": {
    "via": "generate",
    "task": "image",
    "provider": "fal",
    "command": "fal image",
    "args": ["a red fox", "--image-size", "landscape_16_9", "--json"]
  },
  "model": "fal-ai/flux/schnell",
  "outputs": [{ "path": "fox.png", "mime": "image/png" }]
}
```

## Phạm vi hỗ trợ

| Task | Provider |
| --- | --- |
| image | gemini, minimax, openai, openrouter, leonardo, byteplus, cloudflare, fal, atlas, replicate, runway, sume, topview |
| sửa ảnh (`image --image`) | gemini, minimax, openai, openrouter, leonardo, byteplus, atlas, runway, sume |
| video | gemini, minimax, leonardo, byteplus, cloudflare, fal, atlas, replicate, runway, sume, topview, heygen |
| image-to-video (`video --image`) | gemini, minimax, openrouter, leonardo, byteplus, fal, atlas, replicate, runway, sume, topview, heygen |
| lipsync | heygen, sume |
| upscale | leonardo (chỉ image id của Leonardo) |

Với những gì ngoài bảng này (ví dụ `fal run` với input tùy ý), hãy chạy trực
tiếp lệnh provider.
