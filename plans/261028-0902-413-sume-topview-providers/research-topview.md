# TopView API research (evidence for the native provider)

Fetched 2026-10-28 with unauthenticated GETs of public docs only. No key was
available, so nothing below was confirmed against a live account.

TopView exposes two separate APIs with separate keys and separate money. The
CLI keeps them apart and never moves or converts value between them.

## 1. Legacy TopView API (web-plan credits)

Index: https://docs.topview.ai/llms.txt (every page also has a `.md` variant).

### Auth and envelope

- https://docs.topview.ai/reference/authentication-1.md: "you must authenticate
  and authorize your requests using the HTTP Topview-Uid header and
  Authentication header". Example:
  `curl https://api.topview.ai/v1/tts/list -H "Authorization: Bearer <your-api-key>" -H "Topview-Uid: <your-topview-uid>"`.
  The UID and the key both come from "API Settings" on topview.ai.
- Base URL: `https://api.topview.ai` (the `servers` entry of every OpenAPI block).
- Envelope: `{ code: String ("200: success Other: fail"), message, result }`.
- Response codes (https://docs.topview.ai/reference/error-response.md):

  | Code | Message |
  |---|---|
  | 4000 | Request parameter error |
  | 4001 | Format mismatch |
  | 4002 | "Request digital signature does not match!" |
  | 4003 | Null param |
  | 4004 | Not found |
  | 4005 | Duplicate |
  | 4006 | Refuse |
  | 4007 | "Exists unfinished task, please wait…" |
  | 4100 | "Credit not enough" |
  | 5000 | Internal |
  | 5001 | Feign |
  | 5003 | "Server is busy, please try again later!" |
  | 5004 | I/O |
  | 5005 | Unknown |
  | 6001 | Security |

### Billing

- https://docs.topview.ai/docs/billing-rules.md: "API credits are shared with the
  credits in your topview.ai web account", and "Ultra credits cannot be used for
  API requests."
- No USD price is published. Per-task point rules are at
  https://docs.topview.ai/reference/rules-for-consumption-rules.md, for example:
  - Avatar Marketing Video: "5 points will be deducted after export is completed".
  - Video Avatar: "0.1 point for every 100 characters … or … 0.02 point for every 1s".
  - Several rules depend on output length that is known only after the run.
- Query responses of Product Avatar V3 and AnyShoot V3 return `costCredit`
  (number).
- Decision: the CLI records only the credits the task reports (`costCredit`) and
  has no USD estimate, so `--max-cost` fails closed.
- `GET /user/credit/detail` returns the remaining balance (`remainCredit`). It is
  deliberately not wired up, because a balance must never be reported as spend.

### Concurrency and storage

https://docs.topview.ai/docs/concurrency-and-storage.md: "All users share a
common resource pool … requests are automatically queued", and "URLs for videos
and images produced via the API are valid for 7 days only."

### Upload (https://docs.topview.ai/reference/upload-api-usage.md)

1. `GET /v1/upload/credential?format=<ext>` returns `result.{fileId, fileName, format, uploadUrl}`.
2. `PUT` the raw bytes to `uploadUrl` (a signed `https://aigc.s3.amazonaws.com/...` URL).
3. `GET /v1/upload/check?fileId=` returns `result: boolean`.

### Task endpoints used

Every task uses `taskId` as a query param on its query GET. Status values are
"init | running | success | fail" (m2v query and export enums).

- **Avatar Marketing Video (m2v)**
  - Submit: `POST /v1/m2v/task/submit` returns `result.{taskId, status, errorMsg, subTaskId, noticeUuid}`.
  - Source: `productLink`, or `fileIds[]` ("if both … fileIds ignored").
  - Fields: `productName`, `productDescription`, `aspectRatio`, `language`,
    `voiceId`, `aiavatarId`, `captionId`, `videoLengthType`, `preview`, ….
  - `preview`: "Default value: false … When set to false or empty, an exported
    video will be returned."
  - Query: `GET /v1/m2v/task/query?taskId=` returns `exportVideos[]` and
    `previewVideos[]` (`videoUrl`, `coverUrl`).
  - Export: `POST /v1/m2v/export {taskId, scriptId}`.
- **Video Avatar**
  - Submit: `POST /v1/video_avatar/task/submit`.
  - Query: `GET /v1/video_avatar/task/query` returns `result.outputVideoUrl`.
- **Product Avatar V3**
  - Step 2 (replace the product image):
    - Submit: `POST /v3/product_avatar/task/image_replace/submit`.
    - Query: `GET /v3/product_avatar/task/image_replace/query` returns
      `replaceProductResult[{imageId,url,fileId}]` and `costCredit`.
  - Step 3 (image to video):
    - Submit: `POST /v3/product_avatar/task/image2Video/submit`.
    - Query: `GET /v3/product_avatar/task/image2Video/query` returns `finishedVideoUrl`.
    - The published schema spells that key with a trailing space, so the CLI
      accepts both spellings.
- **Product AnyShoot V3**
  - Product + model:
    - Submit: `POST /v3/product_anyShoot/product_model/task/submit`.
    - Query: `GET /v3/product_anyShoot/product_model/task/result`. The path
      really ends in `/result`.
    - Returns `anyfitImages[{key,url}]` and `costCredit`.
  - Product + background:
    - Submit: `POST /v3/product_anyShoot/product_background/task/submit`.
    - Query: `GET /v3/product_anyShoot/product_background/task/query`.

### Cancel

No cancel endpoint is documented. m2v has only a delete-task endpoint, which
is not a cancel, so the CLI offers no cancel.

### Marketing names on topview.ai/openapi

https://www.topview.ai/openapi lists `/v1/url2video/task/submit`,
`/v1/materials2video/task/submit`, `/v1/product_avatar/task/submit` and
`/v1/product_anyshoot/task/submit`, but publishes no schema for them.
Unauthenticated probes return 401 for any path, including made-up ones, so
these paths are unverifiable.

The CLI therefore maps each capability onto the documented endpoint:

| Capability | Documented endpoint |
|---|---|
| url-to-video | m2v with `productLink` |
| materials-to-video | m2v with `fileIds` |
| product-avatar | Product Avatar V3 |
| product-anyshoot | AnyShoot V3 |

## 2. TopView API Platform (separate USD balance)

Index: https://platform.topview.ai/llms.txt. It states: "A separate USD balance with
your Topview account. Catalog inclusion does not mean generation is available."

### Auth (https://platform.topview.ai/docs/authentication)

- "Send the key in the Authorization header on every authenticated API request."
- Example: `curl "https://platform-backend.topview.ai/api/v1/predictions/TASK_ID" -H "Authorization: Bearer $TOPVIEW_API_PLATFORM_KEY"`.
- Permissions: `models:generate` and `requests:read`.
- HTTP errors:
  - 401: "Missing, invalid, expired or revoked API key".
  - 403: scope or model allowlist.
  - 404: the task or asset is not in this workspace.

### Submit (https://platform.topview.ai/docs/quickstart)

- Endpoint: `POST /api/v1/models/{owner}/{model}/{mode}/predictions`, with the
  native JSON body and an `Idempotency-Key` header.
- "If a request times out, retry with the same key and unchanged input rather
  than creating another task."
- The model pages (llms-full.txt) add: "A timeout is not a confirmed failure:
  query the original task; do not submit a duplicate."
- Decision: the CLI never retries a submit. On an unknown outcome it prints the
  Idempotency-Key it used so that the user can repeat the submit safely with
  `--idempotency-key`.

### Poll

- Endpoint: `GET /api/v1/predictions/{id}`.
- Only the original creating key can read the task.
- "Poll every 2–5 seconds with backoff for long-running tasks or 429 / 5xx responses."
- Output schema (llms-full.txt):
  - `data.{id, created_at, code, execution_state, status, outputs[], amount_due_usd?, additional_charge_usd?, shortfall_usd?, charged_usd, billing_state, error, urls.get, last_frame_url?}`.
  - `status`: "created", "processing", "payment_required", "completed", "failed".
  - `charged_usd`: "Actual USD charge as an exact decimal string, not the reserved amount."
  - `billing_state`: "RESERVED is a temporary hold, not spending. CAPTURED is
    the final charge. RELEASED returns the full hold after failure".
  - On `payment_required`: "Top up the same workspace; settlement retries
    automatically without resubmitting."
- "The estimated price is not a cap: actual usage above the reservation is
  automatically charged". So there is no proven upper bound, and `--max-cost`
  fails closed.

### Models (verified routes, all "Status: available" on 2026-10-28)

These are the routes listed in https://platform.topview.ai/llms-full.txt:

| Owner/model | Modes |
|---|---|
| alibaba/wan-3.0 | image-to-video, text-to-video, reference-to-video |
| bytedance/seedance-2.5 | image-to-video, text-to-video, omni-reference-to-video |
| bytedance/seedance-2.0-mini | image-to-video, text-to-video, omni-reference-to-video |
| bytedance/seedance-2.0-fast | image-to-video, text-to-video, omni-reference-to-video |
| bytedance/seedance-2.0 | image-to-video, text-to-video, omni-reference-to-video |
| minimax/minimax-h3 | image-to-video, text-to-video |
| openai/gpt-image-2 | text-to-image, edit |
| topview/topview-t1 | image-to-video, text-to-video, omni-reference-to-video |

Each model has its own native schema. For example, Wan uses
`{input, parameters}` and Seedance uses a top-level `content[]`. The CLI passes
the body through and lets the server validate it.

`GET /api/v1/models` answers 403 IDENTITY_FORBIDDEN. There is no public
model-listing API, so `topview models` prints the verified table above.

### Pricing

https://platform.topview.ai/pricing shows "from" prices only, such as Seedance
2.5 at $0.0522/s and GPT Image 2 at $0.0049/image. These are lower bounds that
vary by resolution and duration, so no USD estimate is recorded.

### Assets

- Upload: `POST /api/v1/media/files`, multipart with `kind` = image|video|audio
  and `file`.
  - Limits: "Maximum file size is 20 MiB; audio and video must be at most 300
    seconds."
  - Upload quota: "100 assets or 1 GiB in a rolling 24-hour window".
- Import: `POST /api/v1/media/imports {kind, url}`, public HTTPS only. Not wired:
  model inputs accept public URLs directly.
- The response gives `data.{id, kind, reference ("pfmedia:ID"), download_url}`.

### Cancel

None documented.
