# ToAPIs: đặc tả tích hợp API tạo ảnh và video (cho provider TypeScript)

Ngày nghiên cứu: 2026-11-18 (Asia/Saigon). Không có API key nên không gọi endpoint có xác thực hoặc tính phí. Chỉ endpoint báo giá công khai `POST https://toapis.com/api/sku/quote/batch` được gọi thật. Mọi nội dung khác lấy từ tài liệu và **chưa được kiểm chứng bằng request thật**.

## 0. Kết luận chính

- Có **hai host với hai loại credential khác nhau**. Host model là `https://toapis.com/v1/...` và dùng `Authorization: Bearer sk-...`; host này phục vụ tạo ảnh/video, polling, upload và danh sách model. Ngoại lệ là gpt-image-2.5/2.6 official: tài liệu của chúng ghi `https://api.toapis.com/v1/...`, vẫn dùng key `sk-`. Host account là `https://api.toapis.com/api/v1/...` và dùng **System Access Token** (không chấp nhận `sk-`); host này phục vụ balance, task list, usage và pricing catalog. Một CLI chỉ có `TOAPIS_API_KEY` thì **không đọc được balance** bằng API mới.
- Tất cả model ảnh và video đều **bất đồng bộ**. Submit trả về `generation.task` với `status: "queued"`, hoặc `"pending"` với gpt-image-2.5/2.6 official chạy trên host `api.toapis.com`. Sau đó poll `GET /v1/images/generations/{id}` hoặc `GET /v1/videos/generations/{id}` (hoặc dùng `GET /v1/tasks/{id}` chung) cho tới khi `completed` hoặc `failed`. URL kết quả nằm ở `result.data[].url`, còn chi phí thực tế nằm ở `billing.cost_usd` (decimal string).
- Media tham chiếu **chỉ nhận URL công khai**, không nhận base64. Upload trước qua `POST /v1/uploads/{images|videos|audios}` (multipart, field `file`).
- Tên trường **khác nhau giữa các model**: `size` hay `aspect_ratio` hay `ratio`, `resolution` top-level hay `metadata.resolution` hay `mode`, `image_urls` là `string[]` hay `object[]`, và `reference_images` hay `image_with_roles`. Provider cần mapping theo từng model family, không dùng một schema chung được.
- Endpoint báo giá công khai hoạt động không cần auth. `seedance-2` hiện là `per_token`, **không phải** `per_second`, nên quy tắc "`display_price` = giá/giây × duration" chỉ đúng cho model `per_second` (đã thấy với `wan2.6`, `kling-v3`, `grok-video-1.0`).

## 1. Base URL, xác thực, content type

Nguồn: https://docs.toapis.com/docs/en/quickstart, https://docs.toapis.com/docs/en/api-reference/account/overview

| Mục | Giá trị |
| --- | --- |
| Base URL model API | `https://toapis.com` (người dùng ở Trung Quốc đại lục dùng `https://toapis.cn`) |
| Base URL account API | `https://api.toapis.com` (tài liệu không nói tới bản `.cn`) |
| Auth model API | `Authorization: Bearer YOUR_API_KEY` (key dạng `sk-...`, tạo tại https://toapis.com/dashboard/tokens) |
| Auth account API | `Authorization: Bearer YOUR_SYSTEM_ACCESS_TOKEN` (tạo ở Account settings). Key `sk-`, cookie và token MCP đều bị từ chối. |
| Content type | `application/json` cho generation; `multipart/form-data` cho upload |
| Header tùy chọn (account API) | `X-Locale`: `en`, `zh`, `zh-TW`, `ja`, `ko`, `ru` |

Tài liệu ghi chú rằng System Access Token **không phải credential chỉ đọc**, vì nó có quyền tạo, xoay vòng và thu hồi key. Tạo lại token sẽ vô hiệu token cũ.

Ba trang gpt-image-2.5-official, gpt-image-2.6 và gpt-image-2.6-official dùng host khác: `https://api.toapis.com/v1/images/generations` (bản Trung Quốc là `https://api.toapis.cn`). Các trang này vẫn xác thực bằng chính API key `sk-` (`$TOAPIS_API_KEY`). Submit trả `status: "pending"` (không phải `queued`), và polling theo `https://api.toapis.com/v1/images/generations/{id}`. Riêng `size` ở các model này nhận kích thước pixel như `"1024x1024"`, và `quality` nhận `auto`,`low`,`medium`,`high`,`xhigh`,`max`. Mọi trang khác ghi `https://toapis.com/v1/...`. Chưa xác minh `toapis.com` có phục vụ được các model này hay không.

Không có `llms.txt`, `llms-full.txt` hay `openapi.json` (cả ba trả 404). Mỗi trang docs lại có bản Markdown khi thêm đuôi `.md` vào URL, ví dụ `https://docs.toapis.com/docs/en/quickstart.md`. Danh sách trang đầy đủ nằm ở `https://docs.toapis.com/sitemap.xml`.

## 2. Tạo ảnh: `POST /v1/images/generations`

Nguồn: https://docs.toapis.com/docs/en/api-reference/images/gpt-image-2/generation và các trang `images/*/generation` khác.

### 2.1 Response khi submit

Mọi trang model ảnh đã đọc đều mô tả submit bất đồng bộ. Trang actual-cost có nhắc tới "compatible non-streaming synchronous image generation or edit responses" có `billing` ở top-level. Tuy vậy, không trang model nào trong số đã đọc cho thấy response đồng bộ hay trường `stream`. Provider vì thế nên coi mọi model ảnh là bất đồng bộ, nhưng vẫn kiểm tra: nếu response có `result.data` ngay lập tức thì dùng luôn. Trạng thái đầu tiên có thể là `queued` hoặc `pending` (gpt-image-2.5/2.6 official).

```json
{
  "id": "task_img_abc123def456",
  "object": "generation.task",
  "model": "gpt-image-2",
  "status": "queued",
  "progress": 0,
  "created_at": 1703884800,
  "metadata": {}
}
```

### 2.2 Trường theo model

| Model (ID) | Tỷ lệ khung | Độ phân giải | Ảnh tham chiếu | `n` | Trường riêng |
| --- | --- | --- | --- | --- | --- |
| `gpt-image-2` | `size` (mặc định `"1:1"`): `1:1`,`3:2`,`2:3`,`4:3`,`3:4`,`5:4`,`4:5`,`16:9`,`9:16`,`2:1`,`1:2`,`21:9`,`9:21`,`auto` | `resolution` (mặc định `"1k"`): `1k`,`2k`,`4k` | `reference_images: string[]`, tối đa 14; `image_urls` là alias được chuẩn hóa thành `reference_images` | mặc định 1 | `background: "transparent"` (bỏ trường này nếu muốn nền thường); `response_format` mặc định `"url"`; prompt tối đa 32.000 ký tự |
| `gpt-image-2-vip` | `size` | `resolution` | `reference_images`, `image_urls` | có | `quality`, `background`, `callback_url` |
| `gpt-image-2-official` (trang `gpt-image-2/official`) | `size` | `resolution` | `image_urls: string[]` | có | `quality`, `background`, `output_format`, `output_compression`, `mask_url` |
| `gpt-image-2.5-sunburst`/`-flare` (không official) | `size` | `resolution` | `reference_images` | có | `quality`, `background` |
| `gpt-image-2.5-*-official`, `gpt-image-2.6-*` (host `api.toapis.com`) | `size` dạng pixel, ví dụ `"1024x1024"` | 2.5 official: không có; 2.6: `resolution` | 2.5 official: `image_urls`; 2.6: `reference_images` | có | `quality`, `background`; bản 2.6 có thêm `output_format` (`png`/`jpeg`/`webp`/`gif`/`svg`), `frame_count` (2–16, cho GIF), `frame_duration_ms` |
| `gemini-3-pro-image-preview` (các giá trị trong hàng này lấy từ trang 3-pro; trang 2.5-flash và 3.1-flash chỉ được đối chiếu tên trường) | `size`: `1:1`,`2:3`,`3:2`,`3:4`,`4:3`,`4:5`,`5:4`,`9:16`,`16:9`,`21:9` | `metadata.resolution`: `1K`/`2K`/`4K` (viết hoa) | Phần mô tả trường ghi **`image_urls: object[]`** dạng `[{"url": "..."}]`, tối đa 6 ảnh, mỗi ảnh ≤10MB; nhưng ví dụ curl của 3.1-flash lại gửi `string[]`, nên đây là mâu thuẫn trong tài liệu | 3-pro: cố định 1, phải là số | `metadata.orientation` (không có ở 3.1 flash); 3.1 flash có `google_search`, `google_image_search` (chưa rõ nằm top-level hay trong `metadata`) |
| `*-official` của Gemini (`gemini-3-pro-image-official`, `gemini-3.1-flash-image-official`, `gemini-nano-banana-2.1-official`…) | `size` | `metadata.resolution` | `image_urls: string[]` | có | Ví dụ request xác nhận các trường nằm trong `metadata`: `temperature`, `topP`, `resolution`, `personGeneration`, `thinkingConfig.thinkingLevel`; ngoài ra có `maxOutputTokens`, `grounding`, `imageOutputOptions{mimeType,compressionQuality}`, `safetySettings` |
| `doubao-seedream-5-0` (5.0) | `size` (mặc định `"1:1"`): `1:1`,`4:3`,`3:4`,`16:9`,`9:16`,`3:2`,`2:3`,`21:9`,`9:21` | `metadata.resolution`: `2K` (mặc định), `3K`; không hỗ trợ 1K/4K | `image_urls: string[]`, tối đa 10, chỉ jpeg/png, ≤10MB | 1–15; tổng ảnh tham chiếu + ảnh đầu ra ≤ 15; tiền bị trừ trước theo `n` | `metadata.sequential_image_generation` (`disabled`/`auto`), `metadata.sequential_image_generation_options.max_images`, `metadata.watermark` |
| Seedream 4.0/4.5/5.0-pro/5.5 | `size` | `metadata.resolution` | `image_urls` (bản 5.5 có thêm `image`) | có | 5.0-pro/5.5 có `layer_decomposition`; 5.5 có `disable_nsfw`, `output_format`, `background`, `watermark` ở top-level |
| `flux-2-flex`, `flux-2-pro` | `size`: `1:1`,`4:3`,`3:4`,`16:9`,`9:16`,`3:2`,`2:3` | `metadata.resolution`: `1K`/`2K` | `image_urls: string[]`, tối đa 8 | không có | không có |
| `flux-kontext-pro`/`max` | `size` | không có | `image_urls` | không có | `safety_tolerance`, `prompt_upsampling`, `response_format` |
| `grok-image` | **`aspect_ratio`** | `resolution` | `image_urls` | có | `quality` |
| `qwen-image-3.0` | `size` | `resolution` | `image_urls` | có | `metadata.prompt_extend`, `negative_prompt`, `seed`, `watermark` |

Kết quả ảnh: `result.data[].url`. Với gpt-image, có thể có thêm `result.data[].background` (`opaque`/`transparent`).

## 3. Tạo video: `POST /v1/videos/generations`

Nguồn: https://docs.toapis.com/docs/en/api-reference/videos/seedance-2/generation và các trang `videos/*/generation` khác.

### 3.1 Response khi submit

```json
{
  "id": "tsk_vid_xxx",
  "client_business_id": "order_20260616_001",
  "object": "generation.task",
  "model": "seedance-2-mini",
  "status": "in_progress",
  "progress": 10,
  "created_at": 1781577600
}
```

### 3.2 Trường theo model

**Seedance 2 (`seedance-2`, `seedance-2-fast`, `seedance-2-mini`)**

- `duration` là integer 4–15; `0` hoặc `-1` nghĩa là tự động, nhưng chỉ cho bản 2 và fast.
- `aspect_ratio` nhận `21:9`,`16:9`,`4:3`,`1:1`,`3:4`,`9:16`,`adaptive`.
- `resolution` mặc định `"720p"`. Bản 2 nhận `480p`/`720p`/`1080p`/`4k`; bản fast và mini chỉ nhận `480p`/`720p`.
- Media tham chiếu:
  - `image_with_roles: [{url, role}]` với `role` ∈ `first_frame`|`last_frame`|`reference_image`. Tối đa 1 first, 1 last và 9 reference; không được trộn chế độ frame với chế độ reference.
  - `video_with_roles` với role `reference_video`.
  - `audio_with_roles` với role `reference_audio`; không được dùng audio một mình.
  - `image_urls` chỉ để tương thích và không được gửi cùng `image_with_roles`.
- Các trường khác:
  - `generate_audio` mặc định `true`; `return_last_frame` mặc định `false`; `disable_nsfw` mặc định `true`.
  - `tools: [{"type":"web_search"}]` chỉ dùng cho text-to-video.
  - `seed`, `callback_url`, `trace_id`, `client_business_id`.
- Bản mini luôn trả đúng 1 kết quả mỗi request.

**Seedance 2.5 (`seedance-2-5`, `seedance-2-5-flash`)**

- Giống Seedance 2, với các điểm khác sau:
  - `video_operation`: `generate` (mặc định), `edit`, `extend`.
  - `duration` 4–30 hoặc `-1`. Khi `edit`, chỉ nhận `-1`. Khi `extend`, nhận 4–30 hoặc `-1`, tính theo tổng độ dài sau khi nối.
  - `resolution` chỉ có `480p`/`720p`/`1080p`.
  - `output_format` nhận `mp4`/`mov`.
  - Giới hạn tham chiếu là 30 ảnh, 10 video và 10 audio, tổng cộng tối đa 50; được dùng audio một mình.
- Với edit, extend và first/last-frame, phải đặt `aspect_ratio: "adaptive"`.
- Với edit và extend, server đặt task type tường minh nên tổ hợp sai bị trả lỗi ngay lúc submit. Với các loại khác, model tự suy ra task type từ media và prompt, nên tổ hợp sai chỉ fail bất đồng bộ với `InvalidParameter.TaskTypeConstraint`.
- Có thêm chế độ draft (`draft`, `draft_task_id`), xem trang `seedance-2-5/draft`.

**Seedance `*-ext` (`seedance-2-ext`, `seedance-2-fast-ext`, `seedance-2.5-ext`)**

Nhóm này dùng **schema khác**: `seconds` (thay cho `duration`), `size`, `resolution`, `reference_image`, `reference_images`. Bản 2.5-ext có thêm `video_with_roles` và `audio_with_roles`.

**Duyệt media (asset review) của Seedance**

- Khi request có media, task có thể nằm ở `queued` tối đa khoảng 20 phút mỗi vòng để duyệt. Nếu bị từ chối, task chuyển `failed` và không tính phí video.
- Chỉ chấp nhận URL HTTP(S) công khai: ảnh ≤30 MB, video/audio ≤100 MiB, URL ≤2048 byte, tối đa 64 media.
- Nếu vi phạm, server trả HTTP 400 với `invalid_private_assets`. Tham chiếu dạng `asset://` đã bị bỏ.

**Veo 3.1 (`veo3.1-fast`, `veo3.1-lite`)**

- `duration` cố định 8.
- `aspect_ratio` nhận `16:9`/`9:16`.
- `image_urls` tối đa 10MB mỗi ảnh, định dạng jpeg/png/webp.
- `metadata.generation_type` nhận `frame`/`reference`; nếu bỏ trống, server tự suy ra (2 ảnh thành frame, 3 ảnh thành reference).
- `metadata.resolution` nhận `720p`; `1080p` chỉ có ở bản lite. Ví dụ curl xác nhận `resolution` nằm trong `metadata`.
- Ví dụ request:

```json
{"model": "veo3.1-fast", "prompt": "...", "duration": 8, "aspect_ratio": "16:9", "image_urls": ["https://.../start.jpg", "https://.../end.jpg"], "metadata": {"generation_type": "frame", "resolution": "720p"}}
```

**Veo 3.1 official (`Veo3.1-quality-official`, `Veo3.1-fast-official`, `Veo3.1-lite-official`)**

- `duration` nhận 4/6/8 (mặc định 8).
- Tỷ lệ khung nằm ở **`size`** (không phải `aspect_ratio`), nhận `16:9`/`9:16`.
- `resolution` nhận `720p`/`1080p`/`4k`.
- `image_urls` chỉ dùng phần tử đầu tiên làm first frame.
- `metadata` gồm `generateAudio` (mặc định false), `negativePrompt`, `personGeneration`, `lastFrame`, `referenceImages` (tối đa 3, loại trừ với `image_urls`), `compressionQuality` và `resizeMode`.

**Kling v3 / v2.6 (`kling-v3`, `kling-v2-6`)**

- `mode` nhận `std` (720P) hoặc `pro` (1080P).
- `duration` nhận 3–15 (mặc định 5).
- `aspect_ratio` mặc định `16:9`.
- `reference_images: string[]`.
- `image_with_roles` với role ∈ `first_frame`|`last_frame`|`reference`|`reference_image`.
- `audio` mặc định false; khi bật, request được tính phí theo giá có âm thanh.
- Với `kling-v3`, `negative_prompt` và `watermark` nằm trong `metadata`. Trang `kling-v2-6` lại liệt kê `negative_prompt` và `watermark` ở top-level, không có `metadata`.

**Kling 3.0 Turbo (`kling-3.0-turbo`)**

Model này dùng `resolution` (`720p`/`1080p`) thay cho `mode`. Các trường khác: `duration`, `aspect_ratio`, `reference_images: string[]` và `watermark` ở top-level.

**Kling 4.0 Flash (`kling-4.0-flash`)**

Schema giống Kling 4.0, với các điểm khác sau:
- `duration` 3–20.
- `resolution` chỉ có `720p`.
- `image_with_roles` chỉ nhận `first_frame`, không nhận `keyframe` hay `last_frame`.

**Kling 4.0 (`kling-4.0`)**

- `duration` 3–30.
- `resolution` nhận `720p`/`1080p`.
- `aspect_ratio` nhận `auto`,`16:9`,`9:16`,`1:1`,`21:9`.
- Media tham chiếu: `image_urls` (≤10), `video_urls` (≤5), `image_with_roles` với `first_frame`/`keyframe`/`last_frame`/`reference_image`, và `video_with_roles`.
- `metadata.keep_original_sound`.
- **Không** dùng `mode`/`audio` như Kling cũ.

**Kling v3-omni / video-o1**

Hai model này dùng `video_list[{video_url, refer_type, keep_original_sound}]`, `image_list[{image_url, type}]` và `element_list`.

**Wan 2.6 (`wan2.6`)**

- Server tự route: có `metadata.reference_urls` (video) thì chạy r2v, có `image_urls` (1 ảnh) thì chạy i2v, chỉ có prompt thì chạy t2v.
- `aspect_ratio` nhận `16:9`/`9:16`/`1:1`/`4:3`/`3:4`, nhưng không dùng được cho i2v.
- `resolution` nhận `720p`/`1080p` (mặc định 1080p).
- `duration` nhận 5/10/15.
- Các trường khác: `negative_prompt`, `seed`, `prompt_extend` (mặc định true), `audio`, `shot_type` (`single`/`multi`), `watermark`.

**Wan 3.0 (`wan3.0-video`, `wan3.0-video-prime`)**

Tỷ lệ khung nằm ở **`ratio`**. Ví dụ trong tài liệu dùng `"16:9"` và `"adaptive"`; danh sách giá trị đầy đủ chưa được kiểm tra. Các trường khác: `duration`, `resolution` (ví dụ `1080p`), `audio`, `watermark`, `image_with_roles` (với `first_frame`/`last_frame`), `reference_images`, `video_list`, `audio_with_roles`, `prompt_extend`, `disable_nsfw`.

**Grok (`grok-video-1.0`)**

- `duration` 1–15 (mặc định 8).
- `resolution` nhận `480p`/`720p`.
- `aspect_ratio` nhận `16:9`,`9:16`,`3:2`,`2:3`,`1:1`.
- `image` (một URL) và `reference_images`, tổng cộng tối đa 8 ảnh.

**Grok 1.5 (`grok-video-1.5`)**

Model này có thêm `video_generation_mode` và `input_reference`.

**Grok extend/remix**

- Extend dùng path riêng `POST /v1/videos/{video_id}/extend`; remix dùng `POST /v1/videos/{video_id}/remix`.
- Sora 2 remix cũng dùng `POST /v1/videos/{video_id}/remix`.
- Gemini Omni flash 1.1/1.2 dùng `POST /v1/videos` (không phải `/v1/videos/generations`).

## 4. Poll trạng thái task

Nguồn:
- https://docs.toapis.com/docs/en/api-reference/tasks/video-status
- https://docs.toapis.com/docs/en/api-reference/tasks/image-status
- https://docs.toapis.com/docs/en/api-reference/account/pricing/actual-cost

**Endpoint poll**

- Video: `GET /v1/videos/generations/{task_id}`. Các alias `GET /v1/video/generations/{task_id}` và `GET /v1/videos/{task_id}` cũng dùng được. Có thể thay `{task_id}` bằng `client_business_id`.
- Ảnh: `GET /v1/images/generations/{task_id}`.
- Endpoint chung cho ảnh và video: `GET /v1/tasks/{task_id}`, với cùng định nghĩa `usage`/`billing`.

**Ví dụ response khi hoàn tất (Seedance, có đầy đủ trường)**

```json
{
  "id": "task_seedance_example",
  "object": "generation.task",
  "model": "seedance-2-global",
  "status": "completed",
  "progress": 100,
  "created_at": 1792400000,
  "finished_at": 1792400060,
  "completed_at": 1792400060,
  "expires_at": 1794992060,
  "result": {"type": "video", "data": [{"url": "...", "fallback_url": "...", "format": "mp4", "last_frame_url": "...", "fallback_last_frame_url": "..."}]},
  "usage": {"charge_type": "per_token", "billed_tokens": 87300, "completion_tokens": 87300, "total_tokens": 87300},
  "billing": {"status": "settled", "credits": "87.3", "cost_usd": "0.4365"},
  "generation": {"duration": 5, "resolution": "720p", "ratio": "16:9", "generate_audio": true}
}
```

**Ví dụ response khi thất bại (ảnh)**

```json
{"id": "img_...", "object": "generation.task", "status": "failed", "progress": 0,
 "billing": {"status": "refunded", "credits": "0", "cost_usd": "0"},
 "error": {"code": "generation_failed", "message": "call upstream API failed: upstream returned status 422"}}
```

**Ý nghĩa các trường**

- `status` nhận `queued` | `in_progress` | `completed` | `failed`. Hai trạng thái cuối là trạng thái kết thúc.
- `result.data[].url` là URL chính. `fallback_url` chỉ dùng khi URL chính không truy cập được (áp dụng cho Seedance).
- `expires_at`: file được giữ 30 ngày, nên CLI phải tải về ngay.
- `usage`:
  - `charge_type` nhận `per_request` | `per_second` | `per_token`.
  - Theo từng loại, có `requests`, `output_seconds` hoặc `billed_tokens`. Có thể có thêm `input_seconds`, `input_images`, `input_tokens`/`output_tokens`/`total_tokens` (ảnh có thêm `*_tokens_details`) và `tool_usage.web_search`.
  - Các trường đo lượng tính phí chỉ xuất hiện khi `billing.status = "settled"`.
- `billing`:
  - `status` nhận `pending` (chưa có số tiền) | `settled` | `refunded` (cả hai số tiền đều `"0"`).
  - `credits` và `cost_usd` là **decimal string**.
  - Thiếu `billing` không có nghĩa là miễn phí, và `completed` không bảo đảm đã `settled`. Cần khử trùng lặp theo `id`, không cộng dồn qua mỗi lần poll.
- `error`:
  - Gồm `{code, reason?, message, input_media_errors?}`.
  - Với Seedance Global, `code` và `message` có thể là số hoặc `null`, nên phải parse lỏng.
- Lỗi HTTP 404/401 có dạng `{"error": {"code": 404, "message": "Task not found", "type": "not_found_error"}}`. Lưu ý `code` ở đây là số.

**Chiến lược poll theo khuyến nghị**

- Video: chờ 5 giây đầu, sau đó 10 giây một lần, tối đa 600 giây (video dài có thể mất 5–10 phút).
- Ảnh: 5–10 giây một lần, tối đa 120 giây.
- Thêm jitter. Khi gặp 429, đợi theo `Retry-After` rồi backoff mũ.

**Ba bộ giá trị trạng thái khác nhau**

| Nguồn | Giá trị |
| --- | --- |
| Generation query (`/v1/.../{id}`) | `queued`, `in_progress`, `completed`, `failed` |
| Account task list (`/api/v1/tasks`) | `pending`, `processing`, `completed`, `failed` |
| Webhook `data.status` | `SUCCESS`, `FAILURE`; `progress` là chuỗi `"100%"` |

## 5. Media tham chiếu: upload

Nguồn: https://docs.toapis.com/docs/en/api-reference/uploads/images, https://docs.toapis.com/docs/en/api-reference/uploads/videos, https://docs.toapis.com/docs/en/api-reference/uploads/audios

- Có ba endpoint: `POST /v1/uploads/images`, `POST /v1/uploads/videos` và `POST /v1/uploads/audios`. Request là `multipart/form-data` với `file` (bắt buộc) và `purpose` (mặc định `generation`).
- Định dạng và giới hạn:

  | Loại | Định dạng | Kích thước tối đa |
  | --- | --- | --- |
  | Ảnh | JPEG/PNG/WebP/GIF | 30 MB |
  | Video | MP4/WebM/MOV | 50MB |
  | Audio | MP3/WAV/M4A | 50MB |

- Response:

```json
{"success": true, "message": "", "data": {"id": "upload_abc12345", "url": "https://files.toapis.com/uploads/123/1737568800_abc12345.jpg", "mime_type": "image/jpeg", "size": 89234}}
```

- Lỗi có dạng `{"success": false, "message": "Unsupported image type. Allowed: JPEG, PNG, WebP, GIF"}`.
- Tài liệu nói rõ API generation **không còn nhận base64**. Giới hạn upload riêng của từng model có thể chặt hơn, ví dụ ảnh Veo và Gemini tối đa 10MB.

## 6. Model, task, balance, usage

Nguồn:
- https://docs.toapis.com/docs/en/api-reference/chat/list-models
- https://docs.toapis.com/docs/en/api-reference/models
- https://docs.toapis.com/docs/en/api-reference/account/overview
- https://docs.toapis.com/docs/en/api-reference/account/api-changes

**Endpoint dùng API key `sk-` trên host `toapis.com`**

- `GET /v1/models?type=image|video|audio|all`. Mặc định chỉ trả model text. Response có dạng `{success, object:"list", data:[{id, object:"model", created, owned_by, supported_endpoint_types[]}]}`.
- Trang "Public Model Catalog" là ảnh chụp ngày 2026-11-10, gồm 41 model ảnh và 54 model video.

**Endpoint dùng System Access Token trên host `api.toapis.com`**

Mọi response bọc trong `{code, message, data}`, với `code=0` khi thành công.

- `GET /api/v1/account/balance` trả `data.remaining_credits`, `used_credits`, `remaining_usd`, `used_usd`, `credits_per_usd` và `balance_kind`. Tất cả là decimal string; trong ví dụ, `credits_per_usd` là `"100"`.
- `GET /api/v1/api-keys/{api_key_id}/balance` trả balance của từng key.
- `GET /api/v1/tasks`:
  - Nhận `from`, `to`, `model`, `type`, `client_business_id`, `ids` (tối đa 20), `limit` (≤50) và `cursor`. Mặc định lấy 24 giờ gần nhất, tối đa 31 ngày.
  - **Không trả URL kết quả.**
  - Có thêm `GET /api/v1/tasks/{task_id}` cho từng task.
- `GET /api/v1/usage/records` bắt buộc `from`/`to` (tối đa 31 ngày) và trả `recorded_cost_usd`, `billing_phase`, `usage.*_tokens`, `trace`. Ngoài ra có `GET /api/v1/usage/summary`.
- `GET /api/v1/pricing?type=image|video&model=...` trả `prices[]` gồm `charge_type`, `price_basis`, `unit`, `unit_price` (USD) và `conditions`. Đây là giá hiện tại, không phải báo giá cho một request cụ thể.
- Rate limit: đọc 120 req/phút; riêng usage summary, invoices và pricing thêm giới hạn 6 req/phút.

**Endpoint đã ngừng**

- Changelog ngày 2026-11-12 xếp `GET /v1/balance`, `GET /v1/user/balance`, `GET /v1/pricing` và `POST /v1/tokens` vào bảng "Migrate earlier account endpoints". Các endpoint cũ này xác thực bằng model key (`sk-`). Bảng này "không phải danh sách path tương thích drop-in", và tài liệu **không nói** chúng đã bị tắt. Trong khi đó, danh sách 10 path cũ "still work" là một danh sách khác, chỉ gồm các path `/api/v1/account/...`.
- Kết quả là balance và pricing qua key `sk-` vẫn **có thể** còn chạy, nhưng không có tài liệu bảo đảm và chưa được kiểm chứng. CLI không nên phụ thuộc vào chúng.

## 7. Endpoint báo giá công khai (đã kiểm chứng trực tiếp ngày 2026-11-18)

Nguồn: thử trực tiếp `POST https://toapis.com/api/sku/quote/batch`. Endpoint này không có trong docs.

**Request**

Gửi kèm `Content-Type: application/json`, không cần auth:

```json
{"items":[{"key":"a","model":"seedance-2","params":{"resolution":"720p","duration":5}}]}
```

**Response**

Response có dạng `{"data":[{key, success, data|message,code,type}], "success": true}`, và giá trị `key` được trả lại đúng như đã gửi. Kết quả quan sát được:

| Model / params | `charge_type` | `unit_price` | `estimated_price` | `display_price` |
| --- | --- | --- | --- | --- |
| `wan2.6` 720p 5s | `per_second` | 0.06 | 0.3 | `"$0.3000"` |
| `wan2.6` 720p 10s | `per_second` | 0.06 | 0.6 | `"$0.6000"` |
| `kling-v3` std 5s | `per_second` | 0.06 | 0.3 | `"$0.3000"` |
| `kling-v3` pro 5s audio | `per_second` | 0.12 | 0.6 | `"$0.6000"` |
| `grok-video-1.0` 8s 720p | `per_second` | 0.01 | 0.08 | `"$0.0800"` |
| `veo3.1-fast` 8s | `per_request` | 0.14 | 0.14 | `"$0.1400"` |
| `gpt-image-2` 1k | `per_request` | 0.015 | 0.015 | `"$0.0150"` |
| `gpt-image-2` 4k, n=2 | `per_request` | 0.025 | 0.025 | `"$0.0250"` (không nhân `n`) |
| `doubao-seedream-5-0` n=3 | `per_request` | 0.0315 | 0.0315 | không nhân `n` |
| `gemini-3-pro-image-preview` 2K | `per_request` | 0.05 | 0.05 | `"$0.0500"` |
| `seedance-2` 720p (5s hoặc 10s) | `per_token` | 6.571429 | 6.571429 | `"$6.5714/1M total tokens"` |
| `seedance-2` 1080p 10s | `per_token` | 7.285714 | 7.285714 | `"$7.2857/1M total tokens"` |
| model không tồn tại | `success:false`, `code:16020`, `type:"model_unavailable"` | | | |

**Cách hiểu các trường**

- Với `per_second`, `estimated_price` bằng `unit_price × duration`, và `display_price` là chuỗi có định dạng của `estimated_price`.
- Với `per_request`, `estimated_price` bằng `unit_price` và **không thay đổi khi đổi `n`**. Tài liệu lại mâu thuẫn ở điểm này. Trang image-status ghi "The request `n` is not multiplied directly" khi nói về `usage.requests`, trong khi trang Seedream ghi "Charges will be pre-deducted based on the number". Hiện chưa biết chi phí thực tế có tăng theo `n` hay không (xem phần câu hỏi mở).
- Với `per_token` (Seedance 2):
  - Có thêm `price_basis:"total_tokens"`, `unit:"1m_tokens"`, `estimated_price_type:"unit_price"` và `billing_note`.
  - Có thêm `estimated_second_price` dạng `{output_unit_price, effective_output_unit_price, input_unit_price?, unit:"second", billing:false, description}`. Giá ước tính theo giây không phụ thuộc duration: với 720p là 0.142337 USD/giây cho cả 5 giây lẫn 10 giây.
  - Trường `description` (tiếng Trung, không đổi theo `X-Locale: en`) giải thích rằng giá theo giây dựa trên P75 của `usage.total_tokens` thực tế, rằng tiền giữ trước (pre-auth) được cộng thêm 20% biên an toàn, và rằng số tiền cuối cùng tính theo `total_tokens` thật.
  - Vì vậy, ước tính cho Seedance 2 là `estimated_second_price.output_unit_price × duration`, và số này chỉ mang tính ước lượng.
- Khi gửi thêm `params.has_video_input: true`, giá đổi thành 4/1M và có thêm `input_unit_price`. Tên param này do tôi đoán, server có vẻ chấp nhận, nhưng chưa có tài liệu nào xác nhận.
- Header response gồm `X-Ratelimit-Limit: 360` và `X-Ratelimit-Category: GA`.
- Trang https://docs.toapis.com/docs/en/api-reference/videos/seedance/pricing sao chép bảng giá Volcano Ark của Seedance. Bảng chia theo resolution và theo việc có hay không có video đầu vào, đồng thời liệt kê mức token tối thiểu (minimum tokens) theo tỷ lệ khung khi có video đầu vào. Trang ghi rõ giá và token thực tế do response của API quyết định. Tôi chỉ đọc phần mở đầu và các tiêu đề, không trích số liệu từ trang này.

## 8. Lỗi

Nguồn: https://docs.toapis.com/docs/en/api-reference/errors

- Lỗi request theo kiểu OpenAI có dạng `{"error": {"code": "invalid_request", "type": "toapis_error", "param": "", "message": "..."}}`. Một số endpoint dùng `{code, message, data}` ở top-level.
- Không được so khớp theo `message`, vì nội dung có thể đã được bản địa hóa. Hãy dựa vào `code`.
- Các nhóm mã lỗi cần map trong CLI:

  | Nhóm | Mã |
  | --- | --- |
  | Auth | `access_denied` / 401 / 403 |
  | Hết quota | `insufficient_user_quota`, `quota_not_enough`, `token_quota_not_enough`, `pre_consume_token_quota_failed` |
  | Rate limit | `rate_limit_exceeded`, `rate_limit_unavailable` (503) |
  | Model không khả dụng | `model_not_found`, `unsupported_model` |
  | Media không hợp lệ | `invalid_private_assets`, `invalid_image` |
  | Kiểm duyệt nội dung | `sensitive_words_detected`, `content_policy_violation`, … |
  | Timeout (request có thể đã được nhận) | `do_request_failed`, `first_output_timeout`, `up_timeout` |

- `error.reason` của task thất bại có thể là: `content_policy_rejected`, `generation_timeout`, `insufficient_user_balance`, `submission_pending_reconciliation`, `refund_pending`, …
- Khôi phục khi submit video bị timeout: `GET /v1/video/requests/{client_request_id}` trả `state`, `task_id` và `error_code`. Chỉ khi `state=failed` và `error_code=submission_rejected` thì mới được submit lại. Tài liệu không nói rõ `client_request_id` được gửi ở đâu lúc submit.

## 9. Rate limit cho task bất đồng bộ

Nguồn: https://docs.toapis.com/docs/en/api-reference/rate-limits/async-tasks

| Group | Submit RPM / RPS / burst 10s | Query RPM / RPS / burst 10s |
| --- | --- | --- |
| `default` | 300 / 5 / 50 | 3.000 / 50 / 500 |
| `vip` | 1.000 / 16,7 / 167 | 10.000 / 166,7 / 1.667 |
| `svip` | 2.000 / 33,3 / 334 | 30.000 / 500 / 5.000 |

- Giới hạn được đếm theo user, không theo token. Request bị từ chối với 429 không trừ hạn mức, nhưng lỗi nghiệp vụ thì vẫn trừ.
- Response có thể kèm các header `X-RateLimit-Limit/Remaining/Reset`, `X-RateLimit-Category: async_submit|async_query` và `Retry-After`.
- Tài liệu có nhắc tới batch query tối đa 100 ID, nhưng không có trang nào ghi path của endpoint đó.

## 10. Tính phí khi thất bại, hoàn tiền, ToS

Nguồn: https://toapis.com/billing-policy (cập nhật 2026-07-23), https://toapis.com/terms, https://toapis.com/usage-policy, https://docs.toapis.com/docs/en/api-reference/webhooks/task-webhooks. Trang https://docs.toapis.com/docs/en/faqs chỉ có liên kết, không có nội dung nào về tính phí.

- **Task bất đồng bộ thất bại ở trạng thái cuối được hoàn lại khoản quota đã trừ trước.** Lỗi có thể retry sẽ được retry nội bộ trước, và chỉ hoàn tiền khi đã fail hẳn. Lỗi validation và request không tạo được task nằm ngoài phạm vi hoàn tiền này.
- Trên response, việc hoàn tiền thể hiện bằng `billing.status:"refunded"` với `credits` và `cost_usd` bằng `"0"`. `refund_pending` nghĩa là hoàn tiền chưa xong. Webhook `generation.failed` chỉ được gửi sau khi đã chốt hoàn tiền.
- Seedance: nếu task fail ở bước duyệt media thì không tính phí video.
- Giá public chỉ để tham khảo; số tiền thực tế theo báo giá của tài khoản lúc submit. Giá video có thể phụ thuộc resolution, duration và việc có video đầu vào hay không. Với route tính theo giây vào/ra, thời lượng video tham chiếu cũng bị tính tiền.
- Mô hình trả trước: số dư không hết hạn, và được hoàn khi đóng tài khoản (trừ phí xử lý). Giá có thể đổi, kèm thông báo trước 7 ngày trong console.
- ToS và usage policy cấm bán lại hoặc chia sẻ quyền truy cập API khi không có thỏa thuận riêng, và cấm vượt qua kiểm duyệt nội dung. Vi phạm có thể dẫn tới khóa tài khoản mà không hoàn số dư. Nội dung tạo ra thuộc về người dùng. Một CLI dùng key của chính người dùng thì không vi phạm, nhưng một proxy dùng chung key thì có.

## 11. Gợi ý cho implementer (tóm tắt)

1. Client HTTP nhận `fetch`, `apiKey`, `baseUrl` (mặc định `https://toapis.com`, cho phép đổi sang `https://toapis.cn`). Không gọi account API trừ khi có token riêng.
2. Submit gồm `POST /v1/images/generations` hoặc `/v1/videos/generations`. Sau đó poll endpoint riêng theo loại: `GET /v1/images/generations/{id}` hoặc `GET /v1/videos/generations/{id}`. Tài liệu có nhắc tới `GET /v1/tasks/{id}` nhưng không có trang riêng hay ví dụ response. Coi `pending`/`queued`/`in_progress` là đang chạy; chỉ `completed` và `failed` là trạng thái cuối. Sau khi xong, tải `result.data[].url` về ngay.
3. Ghi chi phí từ `billing.cost_usd` khi `status=settled`. Coi `pending` hoặc thiếu trường là "chưa biết", không phải 0.
4. Ước tính chi phí trước khi chạy bằng `quote/batch`. Với `per_token`, dùng `estimated_second_price.output_unit_price × duration`. Với `per_request`, chưa rõ có cần nhân `n` hay không.
5. Map tham số theo family. Local file phải upload trước qua `/v1/uploads/*`.

## Câu hỏi còn mở

1. Path của endpoint batch status (tối đa 100 ID) không có trong tài liệu.
2. Chưa rõ `client_request_id` được gửi ở đâu khi submit video: body hay header?
3. Các model gpt-image-2.5-official/2.6 có bắt buộc phải gọi qua host `api.toapis.com` không, hay `toapis.com` cũng phục vụ được?
4. Tài liệu account API không nhắc tới `api.toapis.cn`, dù các trang gpt-image official có dùng host này. Chưa rõ account API có chạy trên `api.toapis.cn` hay không.
4b. Chi phí ảnh `per_request` có nhân theo `n` hay không (tài liệu tự mâu thuẫn). Ngoài ra, `image_urls` của Gemini preview là `object[]` hay `string[]`.
5. Giới hạn upload video/audio là 50MB, trong khi giới hạn duyệt media của Seedance là 100 MiB. Muốn gửi file lớn hơn 50MB thì phải dùng URL ngoài.
6. `/api/sku/quote/batch` không có trong tài liệu, nên schema `params` cho từng model (ví dụ `has_video_input`, `audio`, `mode`) chỉ suy ra qua thử nghiệm và có thể thay đổi mà không báo trước.
7. `GET /v1/pricing` (dùng key `sk-`) có còn chạy không. Tài liệu chỉ ghi nó là endpoint cũ.
8. Không có key nên mọi shape của submit, poll và upload đều chưa được xác minh bằng request thật.
