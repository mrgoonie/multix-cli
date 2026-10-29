# TopView OpenAPI research: Legacy API and API Platform

Date: 2026-10-28 (UTC). Researcher session. Read-only research; no paid or submit endpoint was called. All fetches were unauthenticated GETs.

## Outcome first

TopView exposes two separate, non-interoperable APIs under one TopView account:

| | Legacy API | API Platform |
|---|---|---|
| Base URL | `https://api.topview.ai` | `https://platform-backend.topview.ai` |
| Auth | `Authorization: Bearer <api-key>` **and** `Topview-Uid: <uid>` | `Authorization: Bearer <platform-key>` only (+ `Idempotency-Key` on submit) |
| Key source | topview.ai web app, account menu, "API Settings" (`https://www.topview.ai/api-settings`) | `https://platform.topview.ai` console, "API keys", per workspace, with permissions `models:generate`, `requests:read` |
| Billing | Credits ("points") shared with the topview.ai web subscription | Separate USD balance per workspace; charged as exact decimal USD strings |
| Envelope | `{code: "200" (string), message, result}` | `{code: 200 (integer), message, data}`; errors `{error:{code,message,retryable}, requestId, code, message, data:null}` |
| Status values | `init`, `running`, `success`, `fail` | `created`, `processing`, `payment_required`, `completed`, `failed` |
| Media input | `fileId` from S3 presigned-upload flow | Public HTTPS URL in body; optional Assets API returns a signed `download_url` |
| Marketing APIs (m2v / video avatar / product avatar / anyshoot) | Yes | **No** (8 generic video/image models only) |

Recommendation (ranked):
1. **Marketing features (URL/materials-to-video, video avatar, product avatar, anyshoot): Legacy API is the only option.** Build against the paths in docs.topview.ai, **not** the paths printed on the topview.ai/openapi landing page (see "Path discrepancy" below).
2. **Generic text/image-to-video and image generation: prefer the API Platform** (USD pricing, idempotency, machine-readable schemas and a public price catalog). Use Legacy `common_task` only if you need a model the Platform does not list (Kling, Veo, Vidu, Grok, Happy Horse, etc.).
3. Treat them as two providers (or one provider with two clients) with two env keys. The landing page says: "One Topview account. Separate keys and balances, with no automatic migration. Balances cannot be shared or transferred." (https://www.topview.ai/openapi)

---

## 1. Legacy API vs API Platform

### Positioning (source: https://www.topview.ai/openapi)
- "API Platform — Recommended — For businesses & high-volume use. Pay for what you use. Credits stay separate from your main-site plan."
- "Legacy API — For individuals & light use. Use monthly plan credits. Existing keys, balance, and pricing stay."
- "One Topview account. Separate keys and balances, with no automatic migration. Balances cannot be shared or transferred."

### Legacy API auth (source: https://docs.topview.ai/reference/authentication-1.md)
- "you must authenticate and authorize your requests using the HTTP Topview-Uid header and Authentication header."
- Key location: top-right of https://www.topview.ai/dashboard/home, account space, "API Settings"; "Your Topview Uid and Key will be displayed under the API tab. If there is no Key, click "Add Key"".
- Example:
  ```
  curl https://api.topview.ai/v1/tts/list \
    -H "Authorization: Bearer <your-api-key>" \
    -H "Topview-Uid: <your-topview-uid>"
  ```
- Every OpenAPI block declares security schemes `Topview-Uid` (apiKey, header `Topview-Uid`) and `Authorization` (apiKey, header `Authorization`, "Bearer {Your Authorization}"). Doc examples show keys formatted `sk-...`.
- Probed (unauthenticated GET): missing header returns HTTP 401 `{"error": "Missing Authorization header."}`; bogus key returns HTTP 401 `{"error": "Unauthorized."}`. This is a gateway body, not the `{code,message,result}` envelope. The gateway answers 401 before routing, so route existence could not be probed.

### Legacy billing (source: https://docs.topview.ai/docs/billing-rules.md)
1. "API credits are shared with the credits in your topview.ai web account. You can obtain credits by subscribing to the corresponding plan."
2. "The pricing for each feature can be found on the respective API documentation pages."
3. "For most features, the billing rules are the same as those on the website..."
4. "Ultra credits cannot be used for API requests. API usage is billed only from your standard subscription credits, purchased credit packs, and other eligible balances—not from Ultra monthly credits."

### Legacy concurrency/storage (source: https://docs.topview.ai/docs/concurrency-and-storage.md)
- Shared resource pool; queue priority "Business Annual > Business Monthly > Pro Annual > Pro Monthly > Free users". Higher concurrency via official@topview.ai.
- "the URLs for videos and images produced via the API are valid for 7 days only."
- No numeric rate limit is documented. Error `4007` ("Exists unfinished task, please wait until the previous task is completed.") suggests per-feature serialization for some tasks.

### API Platform auth (source: https://platform.topview.ai/docs/authentication)
- "Send the key in the Authorization header on every authenticated API request. Do not use a main-site session cookie or a supplier key." Header: `Authorization: Bearer YOUR_PLATFORM_KEY`.
- Keys: created in console "API keys", per workspace, optional expiry, revocable. "New keys allow all models and modes, including future models."
- Permissions: `models:generate` ("Submit allowed models; upload, import and read workspace assets."), `requests:read` ("Retrieve task status and results.").
- "A rotated or newly created key cannot query an old key's task." (https://platform.topview.ai/docs/quickstart)
- Auth errors: 401 "Missing, invalid, expired or revoked API key."; 403 "Required scope, model allowlist or account access is missing."; 404 "The requested task or asset is not available in this workspace." Inspect `error.code` and `error.message`.
- Doc env var name used in examples: `TOPVIEW_API_PLATFORM_KEY` (fallbacks in sample code: `TOPVIEW_API_KEY`, `PLATFORM_API_KEY`). Source: https://platform.topview.ai/llms-full.txt

### API Platform billing
- llms.txt: "A separate USD balance with your Topview account. Catalog inclusion does not mean generation is available." (https://platform.topview.ai/llms.txt)
- Server reserves funds at submit ("The server handles the temporary balance reservation"); "No estimate request is required." (quickstart). The overview page says "Get a quote before submitting to see the estimate and required balance", which conflicts with quickstart; quoting is optional in the API flow.
- "The estimated price is not a cap: actual usage above the reservation is automatically charged when sufficient eligible balance is available." On shortfall the task goes `payment_required`; "Top up the same workspace; settlement retries automatically without resubmitting." (llms-full.txt, Result Guide)
- Console strings (JS bundle, unverified as docs): "Get a 10% bonus, up to $10 per top-up. Paid and bonus balances are tracked separately."; "Platform levels are independent of your Topview website subscription. Your workspace shares its balance and limits across Playground and API Keys."; levels activated by top-up size ("Any successful top-up below $1,000", "One-time top-up of $1,000–$4,999", "$5,000 or more"), each with "Requests / minute" and "Max concurrency". **Numeric RPM/concurrency values are not public** (`GET /platform/v1/account/level` requires auth).

---

## 2. Marketing APIs (Legacy API, base `https://api.topview.ai`)

### Path discrepancy (important)
The landing page https://www.topview.ai/openapi lists these "Core API Endpoints":
`POST /v1/url2video/task/submit`, `POST /v1/materials2video/task/submit`, `POST /v1/video_avatar/task/submit`, `POST /v1/product_avatar/task/submit`, `POST /v1/product_anyshoot/task/submit`.

Only `/v1/video_avatar/task/submit` exists in the reference docs. The other four **do not appear anywhere in docs.topview.ai** (149 pages, via https://docs.topview.ai/llms.txt). The landing page also embeds illustrative snippets with fields not found in any doc (e.g. url2video `{productUrl, language, aspectRatio, duration: 30, style: "ugc"}`; product_avatar `{avatarId, productImageFileId, script, voiceId, aspectRatio}`; text2video `{"model":"seedance-2","resolution":720,"sound":"on"}`). Treat these as marketing copy. **UNVERIFIED: whether those paths are live aliases** (the gateway returns 401 before routing, and calling submit is forbidden here).

Documented mapping:

| Landing name | Documented endpoint(s) |
|---|---|
| URL-to-Video | `POST /v1/m2v/task/submit` with `productLink` ("Avatar Marketing Video") |
| Materials-to-Video | `POST /v1/m2v/task/submit` with `fileIds` (same endpoint) |
| Video Avatar | `POST /v1/video_avatar/task/submit` |
| Product Avatar | V3: `POST /v3/product_avatar/task/image_replace/submit` then `POST /v3/product_avatar/task/image2Video/submit` |
| Product Anyshoot | V3: `POST /v3/product_anyShoot/product_model/task/submit` (virtual try-on) and `POST /v3/product_anyShoot/product_background/task/submit`; V1 `POST /v1/product_anyShoot/task/submit` (note camelCase `anyShoot`) |

No cancel endpoint exists for any legacy task (searched all 149 pages). m2v has a delete endpoint.

### 2a. Avatar Marketing Video (m2v): URL-to-Video and Materials-to-Video
Sources: https://docs.topview.ai/reference/getting-started-1.md, https://docs.topview.ai/reference/avatar_marketing_video_submit_task.md, https://docs.topview.ai/reference/get_m2v-task-query.md, export/list/delete pages.

Flow: submit, poll query for preview videos, optionally export the chosen script as an HD, watermark-free video.

`POST /v1/m2v/task/submit` body (JSON; schema `required: ["productLink","fileIds"]` but the descriptions say "Either productLink or fileIds must be non-empty"):
- `productLink` string, default "". "If both productLink and fileIds exist, the parameter of fileIds will be ignored".
- `fileIds` string[]: videos or images from the upload flow.
- `productName` string: "Required when productLink is empty."
- `productDescription` string: "Required when productLink is empty and isDiyScript=false."
- `aspectRatio` enum `9:16 | 3:4 | 1:1 | 4:3 | 16:9`, default `9:16`.
- `language` enum, default `en`: `en, ar, bg, hr, cs, da, nl, fil, fi, fr, de, el, hi, hu, id, it, ja, ko, ms, nb, pl, pt, ro, ru, zh-CN, sk, es, sv, zh-Hant, tr, uk, vi, th`.
- `voiceId` string (from `GET /v1/voice/query`).
- `captionId` string (from `GET /v1/caption/list`; random if omitted).
- `aiavatarId` string (from `GET /v1/aiavatar/query`). Note the lowercase `aiavatarId` here vs `aiAvatarId` in video_avatar.
- `videoLengthType` integer enum `1|2|3|4` (default 1): 1 = 30-50s, 2 = 15-30s, 3 = 30-45s, 4 = 45-60s.
- `endcardFileId` string; `endcardAspectRatio` enum `all | 9:16 | 3:4 | 1:1 | 4:3 | 16:9` (default `all`); `endcardBackgroundColor` `black | white` (default black).
- `logoFileId` string; `musicFileId` string (random music if empty).
- `preview` **string** "Default value: false. When set to true, a preview video will be returned first... When set to false or empty, an exported video will be returned."
- `isDiyScript` **string** (true = custom script); `diyScriptDescription` string (only when isDiyScript=true).
- `diyStyle` enum `diyScriptStyle | diyScriptPrompt` (only when isDiyScript=false); `diyScriptStyle` enum of 33 preset English strings (e.g. "Storytelling style", "Auto-select by AI"); `diyScriptPrompt` string.
- `targetAudience` string; `noticeUrl` string (callback).

Submit response `result`: `taskId`, `status`, `errorMsg`, `subTaskId`, `noticeUuid`.

Query: `GET https://api.topview.ai/v1/m2v/task/query?taskId=...&needCloudFrontUrl=false` (OpenAPI server is `https://api.topview.ai/v1/m2v/task` + path `/query`).
`result`: `taskId`, `status` (`init | running | fail | success`), `productName`, `productDescription`, `errorMsg`,
`exportVideos[]` and `previewVideos[]` each with `scriptId` (number), `status` (`init | running | success | fail | null`), `title`, `description`, `videoUrl`, `coverUrl`, `videoDuration` (ms), `videoEtag`;
`videoSceneInfoList[]`, `imageSceneInfoList[]`, `scriptContentList[]{scriptId, scriptContents[]{segId, segText}}`. **No `costCredit` field is documented for m2v query.**

Other m2v endpoints:
- `POST /v1/m2v/export` body `{taskId (required), scriptId}` returns `{taskId, status, errorMsg, noticeUuid}`.
- `GET /v1/m2v/task/list?pageNo=1&pageSize=20` returns `{taskId, status, errorMsg, productName, productDescription, gmtCreate ("yyyy-MM-dd HH:mm:ss"), diskSpace{size, unit}}`.
- `DELETE /v1/m2v/task/delete` body `{taskIds: string[]}` returns `{taskId, status: success|fail, errosMsg [sic], data{size, unit}}`.
- `GET /v1/m2v/script/list`, `POST /v1/m2v/script/update` (script editing; not detailed here).
- Cost: "5 points will be deducted after export is completed." (https://docs.topview.ai/reference/rules-for-consumption-rules.md)

Related standalone: `POST /v1/scraper/task/submit {productLink, noticeUrl}` and `GET /v1/scraper/task/query` return `productName, productDescription, productImages[]{fileId, fileName, fileType}` (https://docs.topview.ai/reference/scrapper_submit_task.md).

### 2b. Video Avatar
Sources: https://docs.topview.ai/reference/getting-started-2.md, https://docs.topview.ai/reference/video_avatar_submit_task.md, https://docs.topview.ai/reference/video_avatar_query_task.md

`POST /v1/video_avatar/task/submit` body (* = schema-required):
- `avatarSourceFrom`* string enum `"0" | "1" | "2" | "3"` (default "1"): 0 user local video; 1 public avatar (`isCustom` null/false in AiAvatar List); 2 custom avatar (`isCustom` true); 3 user local photo.
- `videoFileId` string: required when avatarSourceFrom = 0.
- `aiAvatarId`* string (example "3327"). The description text is copy-pasted from voiceoverId and is unreliable; presumably required for sources 1/2.
- `isSave2CustomAiAvatar` boolean.
- `captionId` string (only avatarSourceFrom = 1).
- `noticeUrl` string.
- `imageFileId` string ("When audioSourceFrom equals 3" as written; likely means avatarSourceFrom = 3).
- `modeType` string: "0-avatar1, 1-avatar2", default 0.
- `audioSourceFrom`* string: 0 uploaded audio, 1 text to speech (default 1).
- `audioFileId` string: required when audioSourceFrom = 0.
- `ttsText`* string: required when audioSourceFrom = 1.
- `voiceoverId` string: required for TTS with avatarSourceFrom 0/2/3; null means avatar default for source 1.
- `voiceSpeed` number, range 0.8 to 1.2, default 1 (TTS only).

Submit response: `code, message, result{taskId, status, errorMsg, subTaskId}`.

Query: `GET /v1/video_avatar/task/query?taskId=...&needCloudFrontUrl=` returns `result{taskId, status, errorMsg, inputVideoFileId, inputAudioFileId, outputVideoUrl}`. Status strings are not enumerated on this page (described "e.g., success or failure"); assume the common `init | running | success | fail`. **No costCredit documented.**

Billing (getting-started-2): audio-driven "0.02 credits per second" of generated video, rounded up to whole seconds; text-driven adds TTS "0.1 credits are charged for every 100 characters, rounded up". The Points Deduction table instead says Avatar 1 "0.1 point for every 100 characters ... or ... 0.02 point for every 1s", Avatar 2 "0.4/s, maximum 28s".

### 2c. Product Avatar (V3 is current)
Sources: https://docs.topview.ai/reference/pa3_getting_started.md and the pa3 submit/query pages. Changelog: "Product Avatar Add V3 Version". V1/V2 product-avatar pages are no longer in the index.

Three-step flow:
1. Background removal: `POST /v1/common_task/remove_background/submit {productImageFileId, noticeUrl}`, then `GET /v1/common_task/remove_background/query?taskId=` returns `bgRemovedImageFileId`, `bgRemovedImagePath`, `bgRemovedImageWidth/Height`, `maskImageFileId`, `maskImagePath`, `maskImageWidth/Height`.
2. Replace product image: `POST /v3/product_avatar/task/image_replace/submit`
   - `generateImageMode`* enum `auto | manual` (default auto)
   - `avatarId` string (from `GET /v1/product_avatar/public_avatar/query`) or `templateImageFileId` (marked required but "avatarId and templateImageFileId cannot be both empty"; templateImageFileId wins if both)
   - `productImageWithoutBackgroundFileId`* string
   - `imageEditPrompt` (marked required; used only in auto mode)
   - `location` array of 4 `[x,y]` normalized points (manual mode only)
   - `noticeUrl`, `boardId`
   - Guide example also sends `userFaceImageFileId` (not in schema).
   - Response `result{taskId, status: success|fail, errorMsg, noticeUuid}`.
   - Query `GET /v3/product_avatar/task/image_replace/query?taskId=&needCloudFrontUrl=` returns `status` (`success | running | fail`), `costCredit` (double), `replaceProductResult[]{imageId, url, fileId}` (guide example also shows `faceExistence` boolean).
3. Image to video: `POST /v3/product_avatar/task/image2Video/submit`
   - `replaceProductTaskImageId`* (= `imageId` from step 2; "If faceExistence=false, only mode=avatar2 can be selected.")
   - `mode`* enum `avatar2 | avatar4 | avatar4Fast` (all 1080p; avatar4/avatar4Fast up to 120 s). Guide example sends `"mode": "pro"`, which is not in the enum (stale example).
   - `scriptMode`* enum `text | audio` (default text)
   - `ttsText` (required for text; supports `<break time="1.0s"/>`), `voiceId` (required for text), `audioFileId` (required for audio; at most 28 s for avatar2, at most 120 s for avatar4/avatar4Fast), `captionId`, `noticeUrl`.
   - Query `GET /v3/product_avatar/task/image2Video/query?taskId=` returns `status` (`init | running | success | fail`), `costCredit` (number), `finishedVideoUrl` (schema key literally has a trailing space: `"finishedVideoUrl "`), `aiAvatar{aiavatarId, aiavatarName, coverUrl, previewVideoUrl, voiceoverIdDefault}`.
- Helpers: `GET /v1/product_avatar/category/list`; `GET /v1/product_avatar/public_avatar/query?ethnicityIds=&gender=male|female&sortingType=Popularity|Newest&categoryIds=&pageNo=1&pageSize=20` returns `avatarId, avatarImagePath, avatarImagePathWithoutProduct, voiceoverId, gender, avatarCategoryList, avatarEthnicityList, minSubsType (free|starter)`.
- Cost (Points table): product replacement 1 point; Avatar 2 0.4/s (max 28 s); Avatar 4 0.1/s (max 120 s); Avatar 4 Fast 0.06/s (max 120 s).

### 2d. Product AnyShoot
Sources: https://docs.topview.ai/reference/product-model-api-usage-v3.md, product_anyshoot_v3_* pages, product_anyshoot_v1.md, get_new-endpoint-18.md.

V3 Product + Model (virtual try-on): `POST /v3/product_anyShoot/product_model/task/submit`
- `productImageFileId`* string; `productMaskFileId` string (same dimensions as product image)
- `templateId` string (template list) or `templateImageFileId` string (one required; templateImageFileId wins)
- `templateMaskFileId`* string
- `generatingCount`* enum `"1".."4"` (guide example sends integer 2)
- `noticeUrl`
- Response `result{taskId, status, errorMsg, subTaskId, noticeUuid}`.
- Query `GET /v3/product_anyShoot/product_model/task/result?taskId=&needCloudFrontUrl=false` ("true - returns the CloudFront URL; false - will return the S3 URL") returns `result{taskId, status, errorMsg, costCredit, anyfitImages[]{key, url}}`.

V3 Product + Background: `POST /v3/product_anyShoot/product_background/task/submit`
- `mode`* enum `image | prompt`; `productImageWithoutBackgroundFileId`*; `templateId` or `templateImageFileId` (mode=image); `prompt` (mode=prompt); `aspectRatio` enum `9:16|3:4|1:1|4:3|16:9` default 1:1; `location`* (see location-parameters doc); `productSimilarity` enum `natural | creative` (98% / 90% restoration); `noticeUrl`.
- Query `GET /v3/product_anyShoot/product_background/task/query?taskId=` returns `taskId, status, anyfitImages[]{url}`.
- Template helpers: `GET /v3/product_anyShoot/product_background/template/list`, `POST .../template/create`, `.../template/delete`; product_model template category/list pages.

V1 (closest to landing path): `POST /v1/product_anyShoot/task/submit {productImageFileId*, productMaskFileId, templateId, templateImageFileId, templateMaskFileId*, mode* easy|advanced, easyModePrompt*, generatingCount* (1-4), noticeUrl}`; query `GET /v1/product_anyShoot/task/result?taskId=` returns `taskId, status, errorMsg, costCredit (Float), anyfitImages[]{key, url}`.

Cost: "Product Replacement (Product + Model, Product + Background): 1 point deduction for generating one image."

### Common legacy status values
"`init` Task submitted, waiting for processing; `running`; `success`; `fail` Task failed, see `errorMsg`". Polling "3–5 seconds, timeout should be set to 5 minutes." (https://docs.topview.ai/reference/image-to-video-v2-text-to-video-omni-reference-api-usage.md). Note that submit responses usually return `status: "success"`, meaning the submission was accepted, not that the task is done.

### Callbacks (all legacy submits accept `noticeUrl`)
Source: https://docs.topview.ai/reference/post_notice-notice-url-check.md
- Validate first: `POST /notice/notice_url/check?noticeUrl=...` (auth headers).
- TopView POSTs `{uuid, bizType, taskId, status: "success"|"fail", errorMsg, result: <query-task result>}` with header `Topview-Uid`; the receiver must answer `{code:"200", message:"Success", result:{uuid, topviewUid, result:"success"|"fail"}}`.
- bizType values include `M2V_PREVIEW`, `M2V_EXPORT`, `M2V_SCRIPT`, `ZERO_SHOT_AVATAR`, `PRODUCT_AVATAR_REPLACE_PRODUCT_IMAGE_V3`, `PRODUCT_AVATAR_IMAGE2VIDEO_V2`, `PRODUCT_ANY_SHOOT`, `PRODUCT_ANY_SHOOT_V2_PRODUCT_MODEL`, `PRODUCT_ANYFIT_PRODUCT_BACKGROUND`, `COMMON_TASK_IMAGE2VIDEO`, `COMMON_TASK_TEXT2VIDEO`, `COMMON_TASK_TEXT2IMAGE`, `COMMON_TASK_REMOVE_BACKGROUND`, `PHOTO_AVATAR4`, and others. A CLI does not need this; polling is sufficient.

---

## 3. File upload

### Legacy: presigned S3 PUT and fileId
Sources: https://docs.topview.ai/reference/upload-api-usage.md, get_upload_credential.md, upload_file_to_s3.md, get_upload_check.md
1. `GET /v1/upload/credential?format=<ext>&needAccelerateUrl=` (auth headers). `format`: "Image format supports PNG, JPG, JPEG, BMP, WebP. Audio format supports MP3, WAV, M4A. Video format supports MP4, AVI, MOV." Response `result{fileId, fileName, format, uploadUrl}`.
2. `PUT <uploadUrl>` with the raw file body (presigned `https://aigc.s3.amazonaws.com/...` URL, `X-Amz-Expires=3600` in the example). No TopView auth headers on the PUT.
3. `GET /v1/upload/check?fileId=...` returns `result: true|false`.
4. Pass `fileId` into task fields (`fileIds`, `videoFileId`, `audioFileId`, `productImageFileId`, `firstFrameFileId`, ...). Public URLs are **not** accepted in legacy task bodies (except m2v `productLink`).
- No documented max file size.

### API Platform: Assets (optional)
Sources: https://platform.topview.ai/docs/assets-upload, /assets-import, /assets-list, /assets-get
- Model inputs take public URLs directly (`input.media[].url`, `content[].image_url.url`, `image_urls`). Assets are a convenience.
- Upload: `POST /api/v1/media/files` multipart, fields `kind` (`image|video|audio`, required), `file` (binary, required, max 20 MiB), `modelKey` (optional).
- Import: `POST /api/v1/media/imports` JSON `{kind, url, modelKey?}`; "The URL must be publicly reachable over HTTPS. Redirects and private-network addresses are rejected."
- List: `GET /api/v1/media/files?kind=&search=&page=0` (24 per page) returns `data{items, total, page}`.
- Get: `GET /api/v1/media/files/{id}` (26-char id). Refreshes `download_url`.
- Asset object: `data{id, kind, content_type, size (also byte_size), reference ("pfmedia:ID"), download_url (temporary signed), display_name}`.
- "Pass data.download_url in the model's documented image or reference field."
- Limits: 20 MiB; audio/video at most 300 s; "workspace upload allowance is 100 assets or 1 GiB in a rolling 24-hour window". Errors `MEDIA_NOT_FOUND` (404), `MEDIA_DELETED` (410). Requires `models:generate`.

---

## 4. Generic image/video generation

### 4a. API Platform (recommended path)
Sources: https://platform.topview.ai/llms-full.txt, https://platform.topview.ai/docs/quickstart

- Submit: `POST https://platform-backend.topview.ai/api/v1/models/{provider}/{model}/{mode}/predictions`, with headers `Authorization: Bearer`, `Idempotency-Key: <unique per task>`, `Content-Type: application/json`. "If a request times out, retry with the same key and unchanged input rather than creating another task."
- Poll: `GET https://platform-backend.topview.ai/api/v1/predictions/{id}` "every 2–5 seconds; back off for long-running tasks and 429 / 5xx responses" (honor `Retry-After`). Sample code uses a 30-minute deadline.
- Replay input: `GET /api/v1/predictions/{id}/replay-input` (requires `requests:read`; resubmit with a new Idempotency-Key).
- Voices helper: `GET /api/v1/audio/voices?modelKey=MODEL_KEY` (for audio models; none in the current public catalog).
- **Request bodies are model-native and differ per family** (the model route supplies `model`; `additionalProperties: false`):

| Route (provider/model/mode) | Body shape |
|---|---|
| `alibaba/wan-3.0/{image-to-video, text-to-video, reference-to-video}` | `{input:{prompt, media:[{type: first_frame|last_frame|reference_image|reference_video|reference_audio, url}]}, parameters:{resolution: 480P|720P|1080P, ratio: adaptive|16:9|9:16|1:1|4:3|3:4|21:9, duration: -1 or 2..30, audio: bool, seed, prompt_extend, watermark}}` |
| `bytedance/seedance-2.5/{image-to-video, text-to-video, omni-reference-to-video}` | `{content:[{type:"text",text}, {type:"image_url",role:"first_frame"\|"last_frame",image_url:{url}}, {type:"video_url",role:"reference_video",video_url:{url}}, {type:"audio_url",role:"reference_audio",audio_url:{url}}], ratio, resolution: 480p|720p|1080p, duration: -1 or 4..30 (default 5), generate_audio: bool}` |
| `bytedance/seedance-2.0`, `-2.0-fast`, `-2.0-mini` (same three modes) | Same `content[]` shape. Duration -1 or 4..15. Resolution: 2.0 = 480p/720p/1080p; Fast and Mini = 480p/720p. Omni limits: 2.0/Fast/Mini 3 videos, 9 images, 3 audios; 2.0 omni requires at least 1 reference video. |
| `minimax/minimax-h3/{image-to-video, text-to-video}` | `content[]` shape; `resolution: 768P|2K` (default 768P); `duration` 4..15; `ratio` required non-adaptive for text-only |
| `topview/topview-t1/{image-to-video, text-to-video, omni-reference-to-video}` | `content[]` shape; `resolution: 720p|1080p`; `duration` -1 or 4..30; `generate_audio` default true; omni: up to 10 videos, 30 images, 10 audios |
| `openai/gpt-image-2/{text-to-image, edit}` | `{prompt, resolution: 1k|2k|4k, quality: auto|low|medium|high, aspect_ratio (or alias size; 1:1, 3:2, ..., auto, or WxH), n: 1..4, output_format: png|jpeg|webp, output_compression, moderation: auto|low, nsfw_check, mask_url}`; edit adds `images` / `image_urls` (1..16) |

  The doc tables and the curl samples disagree on the GPT Image 2 edit field name (`images` in the table, `image_urls` in the sample and advanced schema). Use `image_urls` (it appears in the raw schema).
- Image input limits (platform): PNG/JPEG/WebP only, at most 20 MiB, at most 40 megapixels. Seedance 300–6000 px/side, aspect 0.4–2.5; MiniMax H3 256–5760 px; Wan 3.0 240–8000 px, no PNG alpha.
- Response (submit and poll share it): `{code: 200, message, data}` where `data` has:
  - `id`, `created_at`
  - `code` ("0 for normal tasks; 402 when payment is required; 1403 for a failed task.")
  - `execution_state`
  - `status` enum `created | processing | payment_required | completed | failed`
  - `outputs: string[]` ("Empty until settled successfully. HTTPS result URLs or image data")
  - `charged_usd` (exact decimal string, e.g. "0.040000000000")
  - `billing_state` enum `RESERVED | CAPTURED | RELEASED`
  - `amount_due_usd`, `additional_charge_usd`, `shortfall_usd` (when payment_required)
  - `error` (empty string unless failed)
  - `urls{get}`
  - `last_frame_url` (optional)
  - Sample code checks `body.code !== 200` as an error. "Save media promptly because URLs may expire." "Fetch the task again to obtain fresh result URLs."
- Model list (public, unauthenticated, verified 2026-10-28):
  - `GET https://platform-backend.topview.ai/platform/v1/models` returns `{data:{items:[...], nextCursor}, requestId}`. Each item has `id` (26-char opaque), `slug`, `category` (VIDEO|IMAGE), `manufacturer`, `protocol` (ARK, WAN, MINIMAX, TOPVIEW_T1, TOPVIEW_IMAGE), `protocolVersion`, `displayName`, and `offers[]{skuCode, spec{resolution, mode?, quality?, referenceVideo, freeReferenceImages}, price{componentCode, meter, unit, unitSize, stepQuantity, minimumQuantity, referenceUnitUsd, payableRatio, saleUnitUsd, referenceSource, referenceAsOf}}`.
  - `GET /platform/v1/catalog` returns a similar `data[]` (7 items at fetch time).
  - **The catalog does not contain the public route slug** (`bytedance/seedance-2.0`); map `displayName` to the route manually, or use the llms.txt list (8 routes: alibaba/wan-3.0, bytedance/seedance-2.5, bytedance/seedance-2.0-mini, bytedance/seedance-2.0-fast, bytedance/seedance-2.0, openai/gpt-image-2, minimax/minimax-h3, topview/topview-t1).
  - `GET /api/v1/models` returns 403 `IDENTITY_FORBIDDEN` unauthenticated (undocumented; may list models with a key).
- Pricing (live catalog `saleUnitUsd`, 2026-10-28; https://platform.topview.ai/pricing shows the same headline values):
  - Wan 3.0: $0.0416 / $0.0832 / $0.1664 per second (480P / 720P / 1080P).
  - Topview T1: 720p $0.1649/s (no ref video) or $0.1027/s (ref video); 1080p $0.3590/s or $0.2193/s.
  - MiniMax H3: 768P $0.0648/s, 2K $0.1036/s, plus $0.0259 per reference image beyond 5 free.
  - Seedance family is metered in `completion_tokens` per 1,000,000 tokens (`unitSize` 1000000): Seedance 2.0 $5.95/M (480p/720p, no ref video), $6.545/M (1080p), $3.655/M (with ref video); 2.0 Fast $4.76/M; 2.0 Mini $2.975/M; 2.5 $9.095/M (480/720p), $9.945/M (1080p). The pricing page shows them as per-second equivalents ("from $0.0171 / second" for Mini ... "$0.0522 / second" for 2.5).
  - GPT Image 2: per generated image, from $0.004856 (low, 1k) to $1.329 (high, 4k); medium 1k $0.0232, medium 2k $0.0912.

### 4b. Legacy common_task (secondary)
Source: https://docs.topview.ai/reference/image-to-video-v2-text-to-video-omni-reference-api-usage.md and the text_to_video/text_to_image pages
- `POST /v1/common_task/text2video/task/submit`, `POST /v2/common_task/image2video/task/submit`, `POST /v1/common_task/omni_reference/task/submit`, `POST /v1/common_task/text2image/task/submit`, `POST /v1/common_task/image_edit/task/submit`; queries via `GET .../task/query?taskId=&needCloudFrontUrl=`.
- Video body: `model` (display name, e.g. "Seedance 2.5", "Kling V3", "Veo 3.1", "Topview T1"), `prompt`, `firstFrameFileId`, `endFrameFileId`, `referenceImageFileIds[]`, `aspectRatio`, `resolution` (integer 480/720/1080...), `duration`, `sound` ("on"|"off"), `generatingCount` 1-4, `draftMode` (Seedance 2.5 only), `boardId`, `noticeUrl`.
- Query `result{taskId, status, errorMsg, costCredit, videos[]{status, errorMsg, fileId, filePath, width, height, duration(ms), coverPath, boardTaskId}}`. Images: `images[]{status, fileId, filePath, width, height, errorMsg}`.
- Pricing in credits per generation, e.g. Seedance 2.0 1080p 2 credits/s, 720p 1, 480p 0.4. `totalCost = unitCost × generatingCount`.
- No model-list endpoint for legacy; models are only in doc tables (40+ video models).

---

## 5. Envelopes, errors, rate limits

### Legacy
- Envelope `{ "code": "200", "message": "Success", "result": {...} }`. **`code` is a string** in schemas and examples. Check `code === "200"`; otherwise read `message`. HTTP status for business errors is not documented (likely 200).
- Gateway auth errors: HTTP 401 `{"error":"Missing Authorization header."}` / `{"error":"Unauthorized."}` (observed).
- Error codes (https://docs.topview.ai/reference/error-response.md): 200 Success; 4000 Request parameter error; 4001 Request data format does not match!; 4002 Request digital signature does not match!; 4003 Required parameter cannot be null; 4004 Resource not found!; 4005 Name duplicated; 4006 Request refuse; 4007 Exists unfinished task, please wait until the previous task is completed.; **4100 Credit not enough**; 5000 Internal server error!; 5001 Feign invoke error; 5003 Server is busy, please try again later!; 5004 I/O error occurred; 5005 Unknown error occurred; 6001 Security problem detect.
- No invalid-key business code is documented (the gateway 401 covers it). No rate-limit code or numbers are documented. The landing page claims "rate-limit headers" but none were observed and none are documented.
- `costCredit` type inconsistency: the schema says number/float; guide examples return strings `"5.00"` (common_task) and numbers `1.00` (anyshoot). Parse both.

### API Platform
- Success: `{code: 200, message, data}`.
- Error (observed): `{"error":{"retryable":false,"message":"API key required","code":"UNAUTHENTICATED"},"requestId":"...","code":401,"message":"API key required","data":null}`. Some routes return `{"message":"User or workspace access is unavailable","code":"IDENTITY_FORBIDDEN"}` (HTTP 403).
- Known codes: `UNAUTHENTICATED` (401), `IDENTITY_FORBIDDEN` (403), `MEDIA_NOT_FOUND` (404), `MEDIA_DELETED` (410). Payment shortfall is a task status (`payment_required`, `data.code` 402), not a submit error. Console text: "This workspace has reached its concurrency or rate limit. This request was not submitted or charged." **The exact error code string for insufficient balance at submit and for 429 is not documented.**
- Rate limit: 429 with `Retry-After` handled in the official sample code; per-level "Requests / minute" and "Max concurrency" exist, but their values are not public.

---

## 6. Credit / balance query
- Legacy: `GET https://api.topview.ai/user/credit/detail` (auth headers) returns `result{uid, remainCredit (number), expiredTime (ISO 8601), apiKeyMap{apiKey, [{uid, date, costCredit, taskId, taskType}]}}`. Source: https://docs.topview.ai/reference/query_user_credit.md
- Legacy logs: `GET /user/credit/logs?taskType=&startTime=&endTime=&pageNo=1&pageSize=20` (UTC "yyyy-MM-dd hh:mm:ss"); taskType enum `m2v, common_task_image2video, video_avatar, product_avatar_image2video, voice_clone, product_anyfit, pa_download_without_watermark, pa2_replace_product_image, pa2_image2video, product_anyfit_v2_product_model`; returns `result{total, pageNo, pageSize, data[]{uid, apiKey, date, costCredit, taskId, taskType}}`. Source: https://docs.topview.ai/reference/query_credit_logs.md
- Legacy storage: `GET /user/space` returns `usedDiskSpace{size, unit}`, `maxDiskSpace{size, unit}`.
- Platform: **no documented API-key balance endpoint.** `GET /platform/v1/wallet` and `/platform/v1/me` exist (console, session auth; return 401 unauthenticated). Whether a Platform Bearer key can read them is UNVERIFIED. Per-task cost is `data.charged_usd`.

---

## Trade-off matrix (for the multix provider)

| Dimension | Legacy API | API Platform |
|---|---|---|
| Feature coverage needed (marketing) | Full (m2v, avatar, product avatar, anyshoot) | None |
| Generic gen coverage | 40+ models (Kling, Veo, Vidu, Grok...) | 8 models |
| Input ergonomics | Upload required (3 calls per file) | URLs inline; optional Assets |
| Client complexity | Two headers; string `code`; per-feature query shapes | One header; idempotency key; uniform prediction object |
| Cost transparency | Credits; `costCredit` on some queries only; docs pricing tables | Exact USD per task; public machine-readable price catalog |
| Doc quality | Mixed: copy-pasted descriptions, stale examples, wrong required flags | High: JSON Schemas, consistent |
| Adoption risk | Labelled "Legacy", "for individuals & light use"; versions churn (PA V1 to V2 to V3, AnyShoot V1/V2/V3) | New (prices "referenceAsOf 2026-10-25"); small catalog; may change quickly |
| Fit with repo rules (runtime-neutral client: fetch/apiKey/baseUrl) | Fine; needs `uid` as an extra input | Fine |

## Unresolved questions / not verified
1. Whether `/v1/url2video/task/submit`, `/v1/materials2video/task/submit`, `/v1/product_avatar/task/submit`, `/v1/product_anyshoot/task/submit` exist as live aliases. They are only on the marketing page; the gateway's 401 blocks route probing without a key. Build on the documented paths.
2. Video Avatar query status strings and cost field (not enumerated in its schema).
3. m2v `costCredit` in query (not documented; use `/user/credit/logs` by taskId if cost must be reported).
4. Legacy HTTP status codes for business errors (4100 etc.); assumed HTTP 200 with string `code`.
5. Platform: numeric rate limits and concurrency per level; error code for insufficient balance at submit; whether a Bearer key can read `/platform/v1/wallet`; whether `GET /api/v1/models` lists models with a key.
6. Platform catalog lacks route slugs; mapping displayName to `provider/model` path must be hard-coded from llms.txt.
7. Legacy upload max size and presigned URL lifetime (example shows 3600 s).
8. Doc inconsistencies to handle defensively: `generatingCount` string vs integer; `preview`/`isDiyScript` typed as strings; `finishedVideoUrl ` with a trailing space in the schema; PA3 example `"mode":"pro"` not in the enum; GPT Image 2 `images` vs `image_urls`.

## Sources (credibility)
- Official reference docs (primary, high): https://docs.topview.ai/llms.txt and the linked .md pages (149 fetched), notably authentication-1, error-response, rules-for-consumption-rules, billing-rules, concurrency-and-storage, avatar_marketing_video_submit_task, get_m2v-task-query, video_avatar_submit_task/query_task, pa3_*, product_anyshoot_v3_*, product_anyshoot_v1, upload-api-usage, get_upload_credential, get_upload_check, query_user_credit, query_credit_logs, post_notice-notice-url-check, image-to-video-v2-text-to-video-omni-reference-api-usage.
- Official Platform docs (primary, high): https://platform.topview.ai/llms.txt, https://platform.topview.ai/llms-full.txt, /docs, /docs/quickstart, /docs/authentication, /docs/assets-upload, /docs/assets-import, /docs/assets-list, /docs/assets-get, /pricing.
- Live unauthenticated endpoints (primary, observed 2026-10-28): https://platform-backend.topview.ai/platform/v1/models, /platform/v1/catalog; 401/403 probes on api.topview.ai and platform-backend.topview.ai.
- Marketing page (low for API facts, high for positioning): https://www.topview.ai/openapi
- Platform console JS bundle strings (low/medium; UI copy, not contract).
