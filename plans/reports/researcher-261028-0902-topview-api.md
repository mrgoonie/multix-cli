# TopView API reference for a TypeScript client (researched 2026-10-28)

## Outcome first

1. TopView has **two unrelated API surfaces** under one account, with separate keys and balances and no migration between them:
   - **Legacy API**: `https://api.topview.ai`, headers `Authorization: Bearer <key>` + `Topview-Uid: <uid>`, billed in **credits** shared with the topview.ai web plan. All marketing features (avatar marketing video, video avatar, product avatar, product anyshoot) live here.
   - **API Platform**: `https://platform-backend.topview.ai/api/v1`, header `Authorization: Bearer <platform key>` only, billed in **USD** from a separate prepaid workspace balance. It documents **only generic model generation** (8 model families: Seedance, WAN, MiniMax, GPT Image 2, Topview T1). It documents **no** marketing endpoints.
2. **The five paths in the brief are not in any reference doc.** `/v1/url2video/task/submit`, `/v1/materials2video/task/submit`, `/v1/product_avatar/task/submit` and lowercase `/v1/product_anyshoot/task/submit` appear **only as marketing copy** on https://www.topview.ai/openapi. Their sample bodies there (`productUrl`, `style`, `productImageFileId`+`script`) contradict the documented API. Unauthenticated probes cannot confirm them, because the legacy gateway returns 401 for **any** path, including an invented one (see §6). **Treat all four as UNVERIFIED and do not build against them.** Use the documented equivalents instead:

| Brief name | Documented endpoint(s) on the legacy API | Status |
|---|---|---|
| URL-to-Video | `POST /v1/m2v/task/submit` with `productLink` (Avatar Marketing Video) | documented |
| Materials-to-Video | `POST /v1/m2v/task/submit` with `fileIds` (same endpoint) | documented |
| Video Avatar | `POST /v1/video_avatar/task/submit` | documented, exact path matches the brief |
| Product Avatar | 3 steps: `/v1/common_task/remove_background/submit`, then `/v3/product_avatar/task/image_replace/submit`, then `/v3/product_avatar/task/image2Video/submit` | documented (V3) |
| Product Anyshoot | `/v1/product_anyShoot/task/submit` (V1, **capital S**), `/v3/product_anyShoot/product_model/task/submit`, `/v3/product_anyShoot/product_background/task/submit` | documented |

3. **Recommendation (ranked):** (1) Build the marketing client on the documented legacy endpoints above, with a common envelope parser and a credit-based cost field (`costCredit`). (2) Build the platform client as a separate provider: generic `POST /models/{vendor}/{model}/{mode}/predictions` + `GET /predictions/{id}`, with a required `Idempotency-Key`. (3) Do not ship the marketing-page paths until someone with a key confirms them with a real call.

## Sources and credibility

| Source | What it is | Weight |
|---|---|---|
| https://docs.topview.ai/llms.txt and 149 `.md` pages (OpenAPI 3 JSON embedded, ReadMe-hosted) | Official legacy API reference | High for paths and fields. Medium for response schemas: many are templated ("This is your first endpoint!"), types are loose, and some examples contradict the schemas. |
| https://platform.topview.ai/llms.txt, `/llms-full.txt` (578 KB), `/docs/*` HTML, `/pricing` | Official API Platform docs and price catalog | High; generated from schemas and internally consistent |
| https://www.topview.ai/openapi | Marketing landing page | Low. Its only value is the statement that the two surfaces exist; its paths and sample bodies are unverified. |
| Live unauthenticated probes against both hosts (no paid calls) | Empirical error shapes | High for error shapes only |

Raw copies: `/tmp/claude-0/-workspace/912a14bd-21a0-5149-a318-2bed072f006c/scratchpad/docs/topview/` (legacy pages `reference__*.md`, `docs__*.md`; platform files under `platform/`; probe output under `probes/`).

---

## 1. The two surfaces

| | Legacy API | API Platform |
|---|---|---|
| Base URL | `https://api.topview.ai` (all paths below are relative to it; note `/user/credit/*` has no `/v1`) | `https://platform-backend.topview.ai/api/v1` |
| Auth headers | `Authorization: Bearer <api-key>` **and** `Topview-Uid: <uid>` (example: `curl https://api.topview.ai/v1/tts/list -H "Authorization: Bearer <your-api-key>" -H "Topview-Uid: <your-topview-uid>"`) | `Authorization: Bearer <platform-key>` only. Submissions also send `Idempotency-Key: <uuid>`. |
| Getting a key | topview.ai dashboard, then avatar menu, then **API Settings**, then API tab. The page shows the UID and key; use "Add Key" if there is none. | platform.topview.ai, then **API keys**: choose a workspace, name the key, choose permissions (`models:generate`, `requests:read`), optional expiry. The secret is shown once. |
| Billing unit | **Credits ("points")**, shared with the topview.ai web account. "Ultra credits cannot be used for API requests." | **USD**, a separate prepaid workspace balance. "Pay for what you use. Credits stay separate from your main-site plan." |
| Balance query | `GET /user/credit/detail` returns `result.remainCredit` (number) and `result.expiredTime`. `GET /user/credit/logs?taskType=&startTime=&endTime=&pageNo=&pageSize=` returns `result.data[].costCredit/taskId/taskType`. | **UNVERIFIED**: no public balance endpoint is documented. The console has Billing and Usage pages. Per task: `data.charged_usd`, plus `data.shortfall_usd` on `payment_required`. |
| Env var used in official examples | none (shell script placeholders) | `TOPVIEW_API_PLATFORM_KEY` |

Footnote verbatim from the openapi page: "One Topview account. Separate keys and balances, with no automatic migration. Balances cannot be shared or transferred."

---

## 2. Legacy API: common contract

**Envelope** (every legacy endpoint):
```json
{ "code": "200", "message": "Success", "result": { ... } }
```
- `code` is a **string** in all 68 examples (`"200"`). Success means `code === "200"`; anything else is failure. Accept a numeric 200 defensively.
- Submit responses are `result.taskId`, `result.status`, `result.errorMsg` (nullable), plus sometimes `result.subTaskId` and `result.noticeUuid`. A submit `status: "success"` means **accepted**, not finished.
- Query is `GET .../query?taskId=<id>&needCloudFrontUrl=<bool>`. `needCloudFrontUrl=true` returns a CloudFront URL instead of an S3 URL (stated on the anyshoot v3 page).
- Status values: `init | running | success | fail` (m2v, PA3 image2Video). PA3 image_replace query uses `success | running | fail`.

**Response codes** (docs page "Response Code", verbatim):
`200` Success · `4000` Request parameter error · `4001` Request data format does not match! · `4002` Request digital signature does not match! · `4003` Required parameter cannot be null · `4004` Resource not found! · `4005` Name duplicated · `4006` Request refuse · `4007` Exists unfinished task, please wait until the previous task is completed. · `4100` Credit not enough · `5000` Internal server error! · `5001` Feign invoke error · `5003` Server is busy, please try again later! · `5004` I/O error occurred · `5005` Unknown error occurred · `6001` Security problem detect

**Auth failures (probed, HTTP-level, not the envelope):**
- No header: `HTTP 401 {"error": "Missing Authorization header."}`
- Bad key: `HTTP 401 {"error": "Unauthorized."}`

**Rate limits / 429**: UNVERIFIED. Nothing is documented. The concurrency page says only: "All users share a common resource pool. When the pool becomes congested, requests are automatically queued with the following priority: Business Annual > Business Monthly > Pro Annual > Pro Monthly > Free users." Contact official@topview.ai for higher concurrency. Treat `5003` and `4007` as retryable with backoff (inferred from the message text, not documented guidance).

**Polling**: no global guidance. The only stated values are on Photo Avatar: "Recommended polling interval 3-5 seconds, timeout 5 minutes". Use 3–5 s for all features, with a longer timeout for m2v (UNVERIFIED duration).

**Callbacks (`noticeUrl`)**: optional on most submits. TopView POSTs `{"uuid","bizType","taskId","status":"success / fail","errorMsg","result":"<query result as JSON string>"}` with header `Topview-Uid`. Your server must reply `{"code":"200","message":"Success","result":{"uuid","topviewUid","result":"success / fail"}}`. Relevant bizTypes: `SCRAPER`, `ZERO_SHOT_AVATAR`, `M2V_PREVIEW`, `M2V_EXPORT`, `M2V_SCRIPT`, `PRODUCT_AVATAR_REPLACE_PRODUCT_IMAGE_V3`, `PRODUCT_AVATAR_IMAGE2VIDEO`(`_V2`), `PRODUCT_ANY_SHOOT`, `PRODUCT_ANY_SHOOT_V2_PRODUCT_MODEL`, `PRODUCT_ANYFIT_PRODUCT_BACKGROUND`, `COMMON_TASK_REMOVE_BACKGROUND`. URL validation endpoint: `POST /notice/notice_url/check` (path from the embedded spec; body fields not inspected).

**Storage**: "Unless otherwise stated, the URLs for videos and images produced via the API are valid for 7 days only." Example output URLs are S3 presigned with `X-Amz-Expires=86400` (24 h). Download promptly and re-query for a fresh URL (re-query refresh is an inference).

---

## 3. Legacy file upload (needed by every marketing flow)

1. `GET /v1/upload/credential?format=<ext>[&needAccelerateUrl]` returns `result.fileId`, `result.fileName`, `result.format`, `result.uploadUrl`.
   Formats (verbatim): "Image format supports PNG, JPG, JPEG, BMP, WebP. Audio format supports MP3, WAV, M4A. Video format supports MP4, AVI, MOV."
2. `PUT <uploadUrl>` with the raw file bytes as the body (S3 presigned, `X-Amz-Expires=3600`, `X-Amz-SignedHeaders=host`). Send no auth headers. The official script uses `curl --request PUT --upload-file`. The Content-Type requirement is not stated; `host` is the only signed header, so omitting it is safe.
3. `GET /v1/upload/check?fileId=<id>` returns `result: true|false`.

- Use the `fileId` in `fileIds`, `videoFileId`, `audioFileId`, `productImageFileId` and similar fields.
- **Size limits: UNVERIFIED** (none documented for legacy upload).
- **Plain public URLs**: not accepted by the documented marketing inputs; they take fileIds only. The one exception is m2v `productLink`, which is a product page URL.

---

## 4. Legacy marketing endpoints

### 4.1 URL-to-Video and Materials-to-Video = Avatar Marketing Video (`m2v`)

"By inputting a product website link or uploading local product video/image materials, AI automatically edits and generates a short marketing video."

**Submit**: `POST /v1/m2v/task/submit`

| Field | Type | Req | Notes (verbatim where quoted) |
|---|---|---|---|
| `productLink` | string | one of productLink/fileIds | "If both productLink and fileIds exist, the parameter of fileIds will be ignored" |
| `fileIds` | string[] | one of productLink/fileIds | videos or images from the upload API |
| `productName` | string | if no productLink | auto-parsed from the link otherwise |
| `productDescription` | string | if no productLink and `isDiyScript=false` | |
| `aspectRatio` | `"9:16"\|"3:4"\|"1:1"\|"4:3"\|"16:9"` | no | default `9:16` |
| `language` | enum of 33 codes (`en`, `ar`, `bg`, `hr`, `cs`, `da`, `nl`, `fil`, `fi`, `fr`, `de`, `el`, `hi`, `hu`, `id`, `it`, `ja`, `ko`, `ms`, `nb`, `pl`, `pt`, `ro`, `ru`, `zh-CN`, `sk`, `es`, `sv`, `zh-Hant`, `tr`, `uk`, `vi`, `th`) | no | default `en` |
| `voiceId` | string | no | from `GET /v1/voice/query` |
| `aiavatarId` | string | no | from `GET /v1/aiavatar/query` |
| `captionId` | string | no | from `GET /v1/caption/list`; random if omitted |
| `videoLengthType` | int 1–4 | no | 1: 30–50 s, 2: 15–30 s, 3: 30–45 s, 4: 45–60 s; default 1 |
| `endcardFileId`, `logoFileId`, `musicFileId` | string | no | fileIds; music is random if empty |
| `endcardAspectRatio` | `all\|9:16\|3:4\|1:1\|4:3\|16:9` | no | default `all` |
| `endcardBackgroundColor` | `black\|white` | no | |
| `preview` | "string" in the spec, `true` in the example | no | "When set to true, a preview video will be returned first. When you need to export the video, you need to trigger the export interface ... When set to false or empty, an exported video will be returned." |
| `isDiyScript` | "string" (boolean semantics) | no | default false |
| `diyScriptDescription` | string | no | used when `isDiyScript=true` |
| `diyStyle` | `diyScriptStyle\|diyScriptPrompt` | no | used when `isDiyScript=false` |
| `diyScriptStyle` | enum of 33 preset strings, e.g. `"Auto-select by AI"`, `"Storytelling style"` | no | |
| `diyScriptPrompt`, `targetAudience`, `noticeUrl` | string | no | |

The OpenAPI block marks both `productLink` and `fileIds` as `required`, which contradicts the "either" text. Send only the one you use.

**Submit response**: `result.taskId`, `status`, `errorMsg`, `subTaskId`, `noticeUuid`.

**Query**: `GET /v1/m2v/task/query?taskId=&needCloudFrontUrl=`
- `result.status`: `init|running|fail|success`
- `result.productName`, `productDescription`, `errorMsg`
- `result.previewVideos[]` and `result.exportVideos[]`, each `{scriptId:number, status: init|running|success|fail|null, title, description, videoUrl, coverUrl, videoDuration, videoEtag}`
- `result.videoSceneInfoList[]`, `imageSceneInfoList[]`, `scriptContentList[]{scriptId, scriptContents[]{segId, segText}}`
- No `costCredit` field is documented on m2v query. Use `/user/credit/logs?taskType=m2v`.
- `videoDuration` is documented as milliseconds, but the example value `36096000` is about 10 h if read as ms. The unit is UNVERIFIED (possibly µs).

**Extra steps:**
- `POST /v1/m2v/export` with body `{taskId (req), scriptId}` exports an HD, watermark-free, lip-synced video. Required when `preview=true`. Returns `{taskId, status, errorMsg, noticeUuid}`; poll the query endpoint and read `exportVideos`.
- Script editing: `GET /v1/m2v/script/list?taskId=` and `POST /v1/m2v/script/update` with body `{taskId, scriptId:"0", scriptContents:[{segId, segText}]}`.
- `GET /v1/m2v/task/list?pageNo=&pageSize=` lists tasks.
- `DELETE /v1/m2v/task/delete` with body `{taskIds:[...]}` deletes tasks.
- Scraping is **optional**, because m2v parses `productLink` itself. A standalone scraper exists: `POST /v1/scraper/task/submit {productLink, noticeUrl?}`, then `GET /v1/scraper/task/query?taskId=` returns `productName`, `productDescription`, and `productImages[]`/`productVideos[]` as `{fileId, fileName, fileType, format, fileUrl}`. Those fileIds can be fed to m2v `fileIds`.

**Cancel**: none documented. Delete is the only removal operation.

**Price**: "5 points will be deducted after export is completed." The getting-started page says "The billing rules is the same as on the website."

### 4.2 Video Avatar

**Submit**: `POST /v1/video_avatar/task/submit`

| Field | Type | Req | Notes |
|---|---|---|---|
| `avatarSourceFrom` | `"0"\|"1"\|"2"\|"3"` | yes | 0 = user local video; 1 = public avatar (`isCustom` false/null in AiAvatar List); 2 = custom avatar (`isCustom` true); 3 = user local photo |
| `videoFileId` | string | if source 0 | uploaded video |
| `imageFileId` | string | see note | the spec says "When audioSourceFrom equals 3"; probably means avatarSourceFrom=3 (doc typo, UNVERIFIED) |
| `aiAvatarId` | string | marked required (default `"3327"`) | for sources 1/2; the description is copy-pasted from voiceoverId |
| `isSave2CustomAiAvatar` | boolean | no | create a reusable avatar from this video |
| `modeType` | `"0"\|"1"` | no | 0 = avatar1 (default), 1 = avatar2 |
| `audioSourceFrom` | `"0"\|"1"` | yes | 0 = uploaded audio, 1 = TTS |
| `audioFileId` | string | if audio 0 | |
| `ttsText` | string | if audio 1 | |
| `voiceoverId` | string | if audio 1 and avatar source 0/2/3 | for source 1, null uses the avatar's default voice |
| `voiceSpeed` | number 0.8–1.2 | no | TTS only |
| `captionId` | string | no | only for avatarSourceFrom=1 |
| `noticeUrl` | string | no | |

**Response**: `result.taskId`, `status`, `errorMsg`, `subTaskId`.

**Query**: `GET /v1/video_avatar/task/query?taskId=&needCloudFrontUrl=` returns `result.taskId`, `status`, `errorMsg`, `inputVideoFileId`, `inputAudioFileId`, `outputVideoUrl`.
- Status enum: not given for this endpoint ("e.g., success or failure"). Assume `init|running|success|fail` (UNVERIFIED).
- No cost field is documented.

**Price** (two docs pages give these numbers; they agree):
- Getting Started: audio-driven costs "0.02 credits per second based on the length of the generated video", rounded up to whole seconds. Text-driven adds "0.1 credits ... for every 100 characters, rounded up to the nearest 100 characters". Public or own avatar costs the same.
- Points Deduction Rules: Avatar 1 as above. "Avatar 2: ... 0.4/s, maximum 28s."
- Deduction timing (submit vs success): UNVERIFIED.

### 4.3 Product Avatar (V3; the single-call path in the brief is undocumented)

Flow (verbatim): "`productImageFileId` ==> `bgRemovedImageFileId` ... (`avatarId` or `templateImageFileId`) + `productImageWithoutBackgroundFileId` ==> `imageId` & `url` ... `imageId` ==> `finishedVideoUrl`"

1. **Remove background**: `POST /v1/common_task/remove_background/submit {productImageFileId}`, then `GET /v1/common_task/remove_background/query?taskId=`, which returns `bgRemovedImageFileId`, `bgRemovedImagePath`, `maskImageFileId`, `maskImagePath` and their widths and heights.
2. **Replace product image**: `POST /v3/product_avatar/task/image_replace/submit`
   - `generateImageMode` (`auto|manual`, req, default `auto`)
   - `avatarId` (from `GET /v1/product_avatar/public_avatar/query`) **or** `templateImageFileId` (template wins if both)
   - `productImageWithoutBackgroundFileId` (req)
   - `imageEditPrompt` (used in auto mode)
   - `location` (number[4][2] normalized corner points; manual mode only)
   - `userFaceImageFileId` (appears in the examples only)
   - `noticeUrl`, `boardId`
   - Response: `{taskId, status: success|fail, errorMsg, noticeUuid}`
   - Query `GET /v3/product_avatar/task/image_replace/query?taskId=` returns `status: success|running|fail`, `costCredit`, and `replaceProductResult[]{imageId, url, fileId, faceExistence}`.
3. **Image to video**: `POST /v3/product_avatar/task/image2Video/submit`
   - `replaceProductTaskImageId` (req, = `imageId`; "If faceExistence=false, only mode=avatar2 can be selected")
   - `mode` (`avatar2|avatar4|avatar4Fast`, req)
   - `scriptMode` (`text|audio`, req)
   - `ttsText` (text mode; supports `<break time="1.0s"/>`)
   - `voiceId` (text mode)
   - `audioFileId` (audio mode; ≤28 s for avatar2, ≤120 s for avatar4/avatar4Fast)
   - `captionId`, `noticeUrl`
   - Query `GET /v3/product_avatar/task/image2Video/query?taskId=` returns `status: init|running|success|fail`, `costCredit`, `finishedVideoUrl`, and `aiAvatar{aiavatarId, aiavatarName, coverUrl, previewVideoUrl, voiceoverIdDefault}`.

Helpers: `GET /v1/product_avatar/category/list`; `GET /v1/product_avatar/public_avatar/query?ethnicityIds=&gender=&sortingType=Popularity|Newest&categoryIds=&pageNo=&pageSize=` returns `avatarId`, `avatarImagePath`, `avatarImagePathWithoutProduct`, `voiceoverId`, `gender`, `minSubsType`, and others.

**Price** (Points Deduction Rules): "Product Replacement: 1 point deduction."
- "Avatar 1(lite): 2.5 + n; Avatar 1(pro): 5 + n" (n = 1 per 400 characters or per 30 s of audio). Avatar 1 is not selectable in V3.
- "Avatar 2: 0.4/s, maximum 28s"; "Avatar 4: 0.1/s, maximum 120s"; "Avatar 4 Fast: 0.06/s, maximum 120s"
- Background-removal cost: UNVERIFIED.
- Deduction timing: UNVERIFIED.

### 4.4 Product Anyshoot

**V1 (replace product image)**: `POST /v1/product_anyShoot/task/submit`
- `productImageFileId` (req; "when mode=easy ... does not support webp format")
- `productMaskFileId`
- `templateId` | `templateImageFileId` (image wins)
- `templateMaskFileId` (marked req)
- `mode` (`easy|advanced`, req)
- `easyModePrompt` (marked req)
- `generatingCount` (string "1"–"4", req)
- `noticeUrl`
- Query: `GET /v1/product_anyShoot/task/result?taskId=&needCloudFrontUrl=` returns `taskId`, `status`, `errorMsg`, `costCredit` (float), `anyfitImages[]{key, url}`.

**V3 Product+Model (virtual try-on)**: `POST /v3/product_anyShoot/product_model/task/submit`
- `productImageFileId` (req), `productMaskFileId`, `templateId` | `templateImageFileId`, `templateMaskFileId` (req), `generatingCount` ("1"–"4", req; the example sends the number 2), `noticeUrl`
- Masks must be "black and white and have the **same resolution** as the original image"
- Query `GET /v3/product_anyShoot/product_model/task/result?taskId=&needCloudFrontUrl=` returns the same fields as V1.

**V3 Product+Background**: `POST /v3/product_anyShoot/product_background/task/submit`
- `mode` (`image|prompt`, req)
- `productImageWithoutBackgroundFileId` (req)
- `templateId` | `templateImageFileId` (image mode)
- `prompt` (prompt mode)
- `aspectRatio` (default 1:1)
- `location` (marked req; described as manual-mode only)
- `productSimilarity` (`natural` = 98% / `creative` = 90%)
- `noticeUrl`
- Query `GET /v3/product_anyShoot/product_background/task/query?taskId=` returns `status` and `anyfitImages[]{url}`.

**Templates**: `GET /v1/product_anyShoot/template/category/list`; `GET /v1/product_anyShoot/template/list?categoryIds=&style=UGC|Pro&pageNo=&pageSize=` returns `data[]{templateId, templateImageUrl, coverUrl, minSubsType, style, templateCategoryList[]}`. V2 endpoints also exist (`/v2/product_anyShoot/...`). Prefer V3.

**Price**: "Product Replacement (Product + Model, Product + Background): 1 point deduction for generating one image."
- The V3 example shows `costCredit: 1.00` for 2 generated images, which conflicts with 1 per image. Read `costCredit` rather than computing it.
- Anyshoot image-to-video (CommonTask Image2Video): 5 s costs Lite 2.5, Pro 3.5, Plus 5, Best 10; 10 s costs Lite 3.5, Pro 5, Plus 10, Best 20; multiplied by quantity.

### 4.5 Billing timing summary (legacy)

| Feature | When deducted | Refund on failure |
|---|---|---|
| Avatar Marketing Video | "after export is completed" | not stated (implicitly nothing is charged before export) |
| Video Avatar, Product Avatar, Product Anyshoot | **UNVERIFIED** | **UNVERIFIED** |
| For contrast only: Photo Avatar, AI Music, Storyboard, Object Remove | "Settled on success, fully refunded on failure" / "Charged after task completion" | yes |

Cost readback: the `costCredit` query field (PA3, Anyshoot) or `GET /user/credit/logs` (taskTypes `m2v`, `video_avatar`, `product_avatar_image2video`, `product_anyfit`, `pa2_replace_product_image`, `pa2_image2video`, `product_anyfit_v2_product_model`, `pa_download_without_watermark`, `voice_clone`, `common_task_image2video`).

---

## 5. API Platform (USD, generic models)

**Discovery**: no model-list endpoint is documented. `GET /api/v1/models` returns the same 403/401 as an invented path, so it is UNVERIFIED. The catalog is https://platform.topview.ai/llms.txt; its header warns "Catalog inclusion does not mean generation is available."

**Endpoints:**
- Submit: `POST /api/v1/models/{vendor}/{model}/{mode}/predictions` with headers `Authorization`, `Idempotency-Key`, `Content-Type: application/json`
- Poll: `GET /api/v1/predictions/{id}` (also returned as `data.urls.get`)
- Assets:
  - `POST /api/v1/media/files` (multipart: `kind`=image|video|audio, `file` ≤ 20 MiB, optional `modelKey`)
  - `POST /api/v1/media/imports` (JSON `{kind, url}`; public HTTPS, ≤ 20 MiB, redirects and private IPs rejected)
  - `GET /api/v1/media/files?kind=&search=&page=` (24 per page)
  - `GET /api/v1/media/files/{id}`
  - Asset fields: `data.id` (26 chars), `kind`, `content_type`, `size`, `reference` (`pfmedia:ID`), `download_url` (temporary signed), `display_name`. Errors: `MEDIA_NOT_FOUND` 404, `MEDIA_DELETED` 410.
  - Usage: "Pass data.download_url in the model's documented image or reference field." Model inputs take **public URLs**.

**Model ids** (`{vendor}/{model}/{mode}`):

| Model | Modes | Body shape |
|---|---|---|
| `alibaba/wan-3.0` | `image-to-video`, `text-to-video`, `reference-to-video` | `{input:{prompt, media:[{type: first_frame\|last_frame\|reference_image\|reference_video\|reference_audio\|file\|link, url}]}, parameters:{resolution: 480P\|720P\|1080P, ratio, duration: 2–30 or -1, audio, seed, prompt_extend, watermark}}` |
| `bytedance/seedance-2.5`, `seedance-2.0`, `seedance-2.0-fast`, `seedance-2.0-mini` | `text-to-video`, `image-to-video`, `omni-reference-to-video` | `{content:[{type:"text",text}, {type:"image_url",role:"first_frame",image_url:{url}}, {type:"video_url",role:"reference_video",video_url:{url}}], duration, resolution: 480p\|720p\|1080p (mini/fast: 480p\|720p), ratio: adaptive\|16:9\|9:16\|1:1\|4:3\|3:4\|21:9, seed, watermark, generate_audio, return_last_frame, camera_fixed, ...}`; `content` is required |
| `minimax/minimax-h3` | `text-to-video`, `image-to-video` | `content[]` as above; `resolution: 768P\|2K`, `ratio`, `duration`, `aigc_watermark` |
| `topview/topview-t1` | `text-to-video`, `image-to-video`, `omni-reference-to-video` | `content[]` (up to 30 images, 10 videos, 10 audios); `resolution: 720p\|1080p`, `ratio`, `duration`, `generate_audio`. "Public HTTP(S) media URLs only; inline base64, asset:// and draft tasks are not supported." |
| `openai/gpt-image-2` | `text-to-image`, `edit` | `{prompt (req), size, resolution: 1k\|2k\|4k, quality: auto\|low\|medium\|high, n, image_urls[], mask_url, output_format: png\|jpeg\|webp, output_compression, nsfw_check, moderation: auto\|low}` |

Bodies are **model-specific** ("Native request fields"). Generate per-model types from the JSON Schemas in `llms-full.txt`; do not assume one shared shape.

**Prediction object** (submit and poll return `{code:200 (int), message, data}`):
- `data.id`, `created_at`
- `code`: 0 normal, 402 payment required, 1403 failed
- `execution_state`
- `status`: `created|processing|payment_required|completed|failed`
- `outputs`: string[] of URLs, or base64 with `enable_base64_output`
- `charged_usd`: exact decimal string, e.g. `"0.040000000000"`
- `billing_state`: `RESERVED|CAPTURED|RELEASED`
- `error`
- `urls.get`
- `amount_due_usd`, `additional_charge_usd`, `shortfall_usd` (on payment_required)
- `last_frame_url`

**Billing** (verbatim):
- "The server handles the temporary balance reservation."
- "The estimated price is not a cap: actual usage above the reservation is automatically charged when sufficient eligible balance is available."
- "RELEASED returns the full hold after failure."
- On `payment_required`: "Top up the same workspace; settlement retries automatically without resubmitting."

**Polling and retry** (verbatim):
- "Poll ... every 2–5 seconds; back off for long-running tasks and 429 / 5xx responses."
- "A timeout is not a confirmed failure: query the original task; do not submit a duplicate."
- On a POST timeout, retry with the **same Idempotency-Key and unchanged body**.
- The official examples use exponential backoff capped at 60 s, honor `Retry-After`, give up after 8 consecutive failures, use a 30-minute deadline, and grow the interval from 3 s by ×1.25 up to 15 s.
- "New or rotated keys cannot query tasks created by another key."
- Output URLs "may expire; fetch the task again to obtain fresh result URLs".

**Errors**:
- Documented: 401 (missing/invalid/expired/revoked key), 403 (scope/model allowlist/account), 404 (task/asset not in this workspace).
- Probed shapes:
  - Predictions: `HTTP 401 {"error":{"retryable":false,"message":"Invalid API key","code":"INVALID_API_KEY"},"requestId":"...","code":401,"message":"Invalid API key","data":null}`. With no key, the code is `UNAUTHENTICATED` / "API key required".
  - Other paths: `{"message":"Invalid API key","code":"INVALID_API_KEY"}` (401), or with no key `{"message":"User or workspace access is unavailable","code":"IDENTITY_FORBIDDEN"}` (403).
- Insufficient balance surfaces as `status:"payment_required"` / `data.code:402`. A submit-time insufficient-balance error code is UNVERIFIED.

**Pricing** (USD, from the platform.topview.ai/pricing payload, "sale" price; 113 SKUs; full table in `platform/prices.tsv`):

| Model | Unit | Sale price (USD) |
|---|---|---|
| seedance-2.0-mini | /s | 480p 0.0286 (0.0171 with reference video); 720p 0.0643 (0.0386) |
| seedance-2.0-fast | /s | 480p 0.0457 (0.0269); 720p 0.1028 (0.0606) |
| seedance-2.0 | /s | 480p 0.0571; 720p 0.1285; 1080p 0.3181; 4k 0.6610 (refVideo: 0.0351 / 0.0789 / 0.1942 / 0.3966) |
| seedance-2.5 | /s | 480p 0.0873; 720p 0.1965; 1080p 0.4833 (refVideo: 0.0522 / 0.1175 / 0.2892) |
| wan-3.0 (all modes) | /s | 480P 0.0416; 720P 0.0832; 1080P 0.1664 |
| minimax-h3 | /s + /ref image | 768P 0.0648/s; 2K 0.1036/s; 0.0259 per reference image beyond 5 free |
| topview-t1 | /s | 720p 0.1649 (refVideo 0.0986); 1080p 0.4056 (0.2427); omni slightly higher (0.1717 / 0.4224) |
| gpt-image-2 (both modes) | /image | low 1k 0.0049, 2k 0.0179, 4k 0.0499; medium 0.0232 / 0.0912 / 0.3432; high 0.0848 / 0.3377 / 1.3293 |

Seedance prices are "Estimated, 16:9, 24fps; actual tokens billed", so read `charged_usd`.

**Marketing endpoints on the Platform: UNVERIFIED / not present.** None of the platform docs, the platform llms.txt, or the price catalog mentions url2video, m2v, video_avatar, product_avatar or anyshoot.

---

## 6. Trade-offs and adoption risk

| Dimension | Legacy marketing endpoints | API Platform |
|---|---|---|
| Doc quality | Medium-low: templated summaries, string-typed booleans, contradictory "required" flags, some types/units wrong | High: schema-generated, consistent |
| Stability | Multiple versions coexist (V1/V2/V3); the docs changelog shows steady churn; the marketing page now calls this surface "Legacy" | New (v1); marketed as the recommended route |
| Billing transparency | Credits; per-task `costCredit` on only some endpoints | Exact USD per task, reservation semantics |
| Abandonment risk | Moderate: labeled legacy, but "Existing keys, balance, and pricing stay" | Low near-term |
| Fit for a TS client | Needs per-feature multi-step orchestration (upload, then remove background, then replace, then video, then export) | One generic submit/poll pair, plus per-model body types |

Probe limitation: the legacy gateway checks auth **before** routing (an invented `/v1/nonexistent_xyz/task/submit` also returns 401 "Missing Authorization header."), so path existence cannot be verified without a key.

---

## Unresolved questions

1. Do `/v1/url2video/task/submit`, `/v1/materials2video/task/submit`, `/v1/product_avatar/task/submit` and `/v1/product_anyshoot/task/submit` exist, and with what bodies? This needs one authenticated call with an intentionally invalid body (expect `4000`/`4003` if the route exists, `4004` or a gateway 404 if not).
2. Legacy deduction timing and refunds for Video Avatar, Product Avatar and Anyshoot.
3. Legacy upload size limits; whether the S3 PUT needs a Content-Type.
4. The m2v `videoDuration` unit; the video_avatar query status enum; the `imageFileId` condition typo.
5. Any legacy rate limit or 429 behavior; the platform submit-time insufficient-balance error shape; a platform balance or model-list endpoint.
