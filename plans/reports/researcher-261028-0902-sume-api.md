# Sume native REST API: reference for a TypeScript client

Date: 2026-10-28 (UTC). Live API build seen at `GET /v1/health`: `v1.0.69`, built 2026-10-28T05:13Z.

## Bottom line

- Base URL `https://api.sume.com`. Auth is `Authorization: Bearer sume_live_...` **or** `x-api-key: sume_live_...`, never both (both = `401 "Send only one API key credential."`, verified live).
- Flow: `POST /v1/open/estimate` (public, no key) -> `POST /v1/{image|video}-router/generate` (202 + job envelope) -> poll `GET /v1/jobs/{id}/status` until `terminal: true` -> `GET /v1/jobs/{id}/result` -> artifacts on `https://media.sume.com/...`.
- Money is USD in every API-key-facing surface (`usd` strings, `usd_micros` integers). Price is reserved at submit, captured on completion, refunded on `failed`/`canceled`.
- All bodies are JSON. Success wraps in `{"data": ...}`, errors in `{"error": {...}}` with a stable `code`.
- Send an `Idempotency-Key` on every generate call (1-255 printable ASCII).

### Sources and how much to trust them

| Source | Weight | Notes |
|---|---|---|
| Live OpenAPI `https://api.sume.com/reference/json` (= `/v1/openapi.json`, 4.1 MB, OpenAPI 3.0.3 "Sume Developer API 1.0.0") | Highest for shapes | The docs call it "source of truth". It does **not** list `/v1/open/*` routes. |
| `https://www.sume.com/docs/*` (overview, quickstart, authentication, models, images, video, uploads, jobs, webhooks, errors, limits, billing, client, reference, mcp, cli) | High, current | USD-denominated. Matches the live probes. |
| `https://www.sume.com/sume-api/quick-start` (agent prompt) | Medium | It is the only page that documents `/v1/open/catalog` and `/v1/open/estimate`. Probes confirm both. |
| Live unauthenticated probes (this session) | High for error shapes, rate-limit headers, and estimate | Nothing was billed. No valid key was available. |
| `https://docs.sume.com/*.md` (older docs site) | Low; it disagrees in places | Credits-based (`402 insufficient_credits`, `required_credits`). The OpenAPI explains the split: Sume API keys get `insufficient_funds` in USD, other credentials get `insufficient_credits`. |

Raw files are in `/tmp/claude-0/-workspace/912a14bd-21a0-5149-a318-2bed072f006c/scratchpad/docs/sume/`:
- `*.html` and `*.txt`: the pages.
- `api_sume_com_reference_json.out`: the OpenAPI.
- `api_sume_com_v1_open_catalog.out` and `api_sume_com_v1_catalog.out`: the two catalogues.
- `op-*.json`: operations with `$ref`s resolved.
- `probes/*.h`, `probes/*.b`: probe headers and bodies.
- `docs-sume-com/*.md`: the older docs site.

---

## 1. Base URL, auth, keys

| Item | Value | Evidence |
|---|---|---|
| Base URL | `https://api.sume.com` (paths start `/v1/...`) | Docs "At a glance". The OpenAPI `servers` field holds the same value. |
| Header A | `Authorization: Bearer <key>` | OpenAPI `bearerAuth` |
| Header B | `x-api-key: <key>` | OpenAPI `apiKey` |
| Both headers | `401 unauthorized`, message `Send only one API key credential.` | OpenAPI; live probe `st4` |
| Key prefix | `sume_live_` (`export SUME_API_KEY="sume_live_..."`). No test-key prefix appears anywhere. | Quickstart, OpenAPI |
| Key scope | One workspace. Another workspace's job id answers `404`. A browser session cookie is refused (`401 session_not_accepted`). | Authentication page |
| Key check | `GET /v1/open/balance` (free). `GET /v1/me` and `GET /v1/balance` answer `403 open_key_route_not_allowed` for dashboard keys. | Authentication page |
| Per-key spend limit | Optional USD cap that resets daily, weekly, monthly or never (UTC windows). Over the cap: `403 api_key_spend_limit_exceeded`, with no retry-after. | Authentication page |

`GET /v1/open/balance` 200 (verbatim from docs):
```json
{ "data": { "balance": 15.265433, "usage_this_month": 2.5, "auto_topup_setting": null,
  "billing_type": "credit-based", "currency": "USD",
  "balance_usd_micros": 15265433, "usage_this_month_usd_micros": 2500000 } }
```
`GET /v1/open/usage` answers `501 billing_in_dashboard`. Top-ups happen only in the dashboard.

Missing-key 401 (live, `GET /v1/jobs/x/status`, no headers):
```json
{"error":{"code":"unauthorized","message":"Missing API key. Send x-api-key or Authorization: Bearer.","request_id":"req_1d29...","category":"auth","stage":"auth","retryable":false,"retry_after_seconds":null,"public_reason":"authentication_required","next_action":"authenticate"}}
```
With an invalid key the message is `Missing or invalid API key.` and everything else is the same. An unknown route without a key also answers 401, not 404.

## 2. Public catalogue and `POST /v1/open/estimate`

### 2a. `GET /v1/open/catalog`: no key, 200

This route appears only on the sume-api quick-start page, not in the OpenAPI. The live copy is byte-identical to the provided `sume-catalog.json`.

```
{ "data": {
    "currency": "USD",
    "models": [ Model, ... ]          // 76 models: video 39, image 21, lipsync 15, captions 1
} }
```
Each `Model` has the following fields. `request_fields` is present on 34 of the 76 models; every other field is always present.

| Field | Type / values |
|---|---|
| `id` | string. This is the value for `model` on generate and estimate (e.g. `gpt-image-2`, `kling-4`, `sumelabs/wand`). |
| `slug` | `"<company>/<id>"`, e.g. `openai/gpt-image-2` |
| `name`, `description` | display strings |
| `kind` | `video` \| `image` \| `lipsync` \| `captions` |
| `company` | `{ slug, name }` |
| `modes` | string[]. Values: `text-to-video`, `image-to-video`, `reference-to-video`, `video-to-video`, `text-to-image`, `image-edit`, `image-to-lipsync`, `video-to-lipsync`, `video-captions`, `motion-transfer`, `object-swap`, `restyle` |
| `pricing` | `{ currency:"USD", unit:"second"\|"image", from_usd:"0.1570", from_usd_micros:157000, to_usd:"0.2350", qualifier:"from", options:[...] }` |
| `pricing.options[]` | `{ label, usd:"0.1570", usd_micros:157000, route:"r4fdc55", resolution?, quality?, audio? }`. One row per price point. `route` is an opaque provider-route tag. |
| `capabilities` | Image models: `text_to_image`, `image_edit`, `aspect_ratios[]`, `resolutions[]`, `qualities[]`, `max_images`, `output_formats[]`. Video models: `text_to_video`, `image_to_video`, `end_frame`, `reference_images`, `reference_videos`, `reference_audios`, `video_to_video`, `audio`, `resolutions[]`, `duration_seconds:{min,max}`, `aspect_ratios[]`, and optionally `duration_values[]` (e.g. Veo `[4,6,8]`), `lipsync`, `captions`, `dubbing`, `video_tool`, `max_reference_images`, `routes[]` |
| `constraints` | string[]. Rules in plain English, e.g. defaults and which inputs combine. |
| `request_fields` | Partial input hints: `{ <field>: { required?, type?, description?, min?, max?, default?, omit?, options?, media? } }`. `omit: true` means "do not send". |

There is **no JSON Schema per model** in this catalogue. The authoritative input contract is the OpenAPI request schema for each router, which uses `additionalProperties: false`. On top of that come the per-model `capabilities`, `constraints` and `request_fields`.

The three Sume Remix models are not router models. Their `capabilities.routes` point at `POST /v1/sume/remix/{motion-transfer|object-swap|restyle}/v1.0`.

Example, image model (trimmed to 3 of 9 options):
```json
{ "id": "gpt-image-2", "slug": "openai/gpt-image-2", "name": "ChatGPT Image 2", "kind": "image",
  "pricing": { "currency": "USD", "unit": "image", "from_usd": "0.0060", "from_usd_micros": 6000,
    "options": [
      { "label": "1K · low", "usd": "0.0060", "usd_micros": 6000, "route": "r4fdc55", "resolution": "1K", "quality": "low" },
      { "label": "1K · medium", "usd": "0.0530", "usd_micros": 53000, "route": "r4fdc55", "resolution": "1K", "quality": "medium" },
      { "label": "1K · high", "usd": "0.2110", "usd_micros": 211000, "route": "r4fdc55", "resolution": "1K", "quality": "high" } ],
    "qualifier": "from", "to_usd": "0.2110" },
  "company": { "slug": "openai", "name": "OpenAI" },
  "description": "Generates and edits images · up to 4K · up to 4 per request",
  "modes": ["text-to-image", "image-edit"],
  "capabilities": { "text_to_image": true, "image_edit": true,
    "aspect_ratios": ["auto","1:1","16:9","9:16","4:3","3:4","5:4","9:8","4:5"],
    "resolutions": ["1K","2K","4K"], "qualities": ["low","medium","high"], "max_images": 4,
    "output_formats": ["png","jpeg","webp"] },
  "constraints": ["Admit uses an image-token estimate (quality + size); the listed rate is high quality at 1024"] }
```
Example, text/image-to-video model (verbatim):
```json
{ "id": "kling-4", "slug": "kling/kling-4", "name": "Kling 4.0", "kind": "video",
  "pricing": { "currency": "USD", "unit": "second", "from_usd": "0.1570", "from_usd_micros": 157000,
    "options": [
      { "label": "720p", "usd": "0.1570", "usd_micros": 157000, "route": "r4fdc55", "resolution": "720p" },
      { "label": "1080p", "usd": "0.2350", "usd_micros": 235000, "route": "r4fdc55", "resolution": "1080p" } ],
    "qualifier": "from", "to_usd": "0.2350" },
  "company": { "slug": "kling", "name": "Kling" },
  "description": "Generates video from text, an image · 720p to 1080p · 3–30 s · native audio",
  "modes": ["text-to-video", "image-to-video"],
  "capabilities": { "text_to_video": true, "image_to_video": true, "end_frame": true,
    "reference_images": false, "reference_videos": false, "reference_audios": false,
    "video_to_video": false, "audio": true, "resolutions": ["720p","1080p"],
    "duration_seconds": { "min": 3, "max": 30 }, "aspect_ratios": ["16:9","9:16","1:1","21:9"] },
  "constraints": [
    "Text, a first frame (image_url), or a first and last frame (end_image_url); no video or audio inputs",
    "resolution 720p / 1080p (default 1080p); duration 3–30 seconds (default 5); aspect_ratio 16:9 / 9:16 / 1:1 / 21:9 (default 16:9); a first frame sets the framing, so aspect_ratio applies to text and references only",
    "generate_audio defaults to true (synchronized sound); false makes a silent clip at the same rate" ] }
```
Example, lipsync model showing `request_fields` (trimmed):
```json
{ "id": "veed-fabric-1.0", "kind": "lipsync", "modes": ["image-to-lipsync"],
  "pricing": { "unit": "second", "options": [ {"label":"480p","usd":"0.0800","resolution":"480p"}, {"label":"720p","usd":"0.1500","resolution":"720p"} ] },
  "capabilities": { "image_to_video": true, "lipsync": true, "audio": true, "resolutions": ["480p","720p"], "duration_seconds": {"min":2,"max":60}, "aspect_ratios": [] },
  "constraints": ["lipsync from an image: image_url (the face) + audio_url (the speech)", "no prompt", "duration required: ...2–60...", "resolution 480p / 720p (default 720p)", "no frames, references, aspect_ratio or generate_audio"],
  "request_fields": { "prompt": { "omit": true },
    "duration": { "required": true, "type": "integer", "description": "The audio's length in whole seconds.", "min": 2, "max": 60 } } }
```

Related catalogues, for comparison:
- `GET /v1/catalog` (public, in the OpenAPI) uses a different shape: `{apiVersion, data:[capability families], status}`. It prices in **credits** plus `estimated_usd`, and it is aimed at Sume's own products.
- `GET /v1/image-router/models` and `GET /v1/video-router/models` (and `/{model_id}`) need a key. Each row there carries `capabilities`, `pricing.basis` (`per_image` | `per_second` | `per_second_by_resolution`) and `constraints`.
- The router enums in the OpenAPI list more ids than `/v1/open/catalog`: 36 image ids including `higgsfield-*` and `flux-*`, and 64 video ids. Use the catalogue for "what an open key can run". `/v1/open/estimate` answers `404 model_not_found` "Model X is not on open.sume.com." for ids outside it.

### 2b. `POST /v1/open/estimate`: no key needed (verified live)

Request, as documented on the quick-start page: `{"model": "<id>", "input": {...}}`, where `input` holds the same fields as the generate body. Observed behaviour:
- A flat body (`{"model":"kling-4","prompt":..,"duration":5}`) is also accepted, but it ignored `resolution` and priced at the model default. Use the `input` wrapper.
- Unknown input fields are ignored (`foo:1` gave 200). Generate refuses them with 400, so estimate is **not** a full validator.
- An invalid key in `Authorization` is ignored (200).

Response 200 (live, verbatim):
```json
{"data":{"model":"kling-4","currency":"USD","usd":"0.7850","usd_micros":785000,"route":"r4fdc55",
 "billing":{"unit":"output_video_second","quantity":5,"duration_seconds":5,"resolution":"720p"}}}
```
`billing.unit` values seen:

| `billing.unit` | Model | Note |
|---|---|---|
| `output_video_second` | kling-4, wan-3.0, kling-avatar-2.0 | |
| `1000_video_tokens` | seedance-2.5 | quantity 108 for 5 s at 720p, $1.1560 |
| `audio_second` | veed-fabric-1.0 | |
| `image` | nano-banana-pro | 3 x 4K = $0.7201 |
| `usd_micros` | gpt-image-2 | quantity = number of images |

Pricing observations (live):
- gpt-image-2 with no `quality` is estimated at the **high** price ($0.2110). Low quality is $0.0060 per image.
- kling-4 with no `resolution` is priced at 1080p ($1.1750 for 5 s).
- veed-fabric-1.0 with `duration: 8` and unreadable example URLs was priced at **300 s ($24.00)**. That is the maximum on the rate card ("Max 300 seconds. Audio must be Sume-hosted"). So the estimate (and probably the reservation) can be the worst case when media cannot be read. UNVERIFIED with a real `media.sume.com` audio URL.
- The docs say `estimated_usd` can "sit a cent above the debit". The final charge is the `usage.usd` on the submit response.

Estimate errors (live): `404 model_not_found`; `400 invalid_request` with `details.errors[]`; `400 bad_request` (bad JSON); `415 unsupported_media_type`. `GET /v1/open/estimate` answers 401, so only POST is public.

## 3. Generate endpoints

Both routes:
- Headers: `Authorization` (or `x-api-key`), `Content-Type: application/json`, optional `Idempotency-Key` (regex `^[\x20-\x7E]+$`, length 1-255).
- The body schema uses `additionalProperties: false`, so fields a model does not take answer `400 invalid_request`.
- OpenAPI responses: 200 or 202 (same envelope), plus 400, 401, 402, 409, 413, 429, 500, 502, 503.

### 3a. `POST /v1/image-router/generate`

Required fields are `model` and `prompt`. Field list, from the OpenAPI:

| Field | Type | Notes |
|---|---|---|
| `model`* | string enum | Image Router id. A retired id (`nano-banana-2`) runs as its successor (`nano-banana-2.1`). |
| `prompt`* | string, minLength 1 | |
| `image_urls` | uri[] 1-16 | References or edit sources. Text-only models refuse it. Alias: `input_urls`. |
| `mask_url` / `mask_image_url` | uri | `mask_image_url` is for gpt-image-2 edits. |
| `aspect_ratio` | enum (`auto`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `9:8`, ... `21:9`) | Per model. For edits prefer `auto`; omitting the field is not the same as `auto`. |
| `image_size` | preset (`square`, `square_hd`, `portrait_16_9`, `landscape_16_9`, `landscape_4_3`, `portrait_4_3`, `auto`, `auto_2K`, `auto_3K`, `auto_4K`) \| `{width,height}` \| `"WxH"` | Wins over `aspect_ratio`. |
| `quality` | string | gpt-image-2: `low`/`medium`/`high`. GPT Image 2.5: `auto`/`low`/`medium`/`high`/`xhigh`/`max`. ideogram-v3: `TURBO`/`BALANCED`/`QUALITY`. |
| `resolution` | enum `0.5K`, `1K`, `2K`, `4K`, `720p`, `1080p` | Per model. |
| `rendering_speed` | `TURBO`\|`BALANCED`\|`QUALITY` | |
| `num_images` | int 1-10 | 1-4 in practice (qwen-image-layered takes 2-10). `n` is a deprecated alias. |
| `output_format` | `png`\|`jpeg`\|`jpg`\|`webp` | `format` is deprecated. |
| `background` | `auto`\|`transparent`\|`opaque` | GPT Image 2.5 only. |
| `model_params` | object | Empty allowlist; omit it. |
| `metadata` | object | Stored on the job, never sent to the model. |
| `mode` | `async` (default) \| `sync` \| `subscribe` \| `webhook` | |
| `webhook_url` | https uri, max 2048 | Sending it without `mode` selects `webhook`. |
| `wait_timeout_seconds` | int 0-30 | For `sync`/`subscribe` only. |

Verbatim docs example:
```bash
curl -X POST https://api.sume.com/v1/image-router/generate \
  -H "Authorization: Bearer $SUME_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"model":"gpt-image-2","prompt":"A ceramic coffee cup on a wooden table, soft morning light","quality":"low","aspect_ratio":"1:1"}'
```

### 3b. `POST /v1/video-router/generate`

Only `model` is required. `prompt` (minLength 1) is optional because lipsync, captions and edit models do not take it.

| Field | Notes |
|---|---|
| `model`* | Video Router id, or `auto-` / `sume/auto` / `auto`. |
| `prompt`, `task` | `task` is used only by `auto-`. |
| `duration` (int 2-600; alias `duration_seconds`) | Must fall in the model's `capabilities.duration_seconds` or `duration_values`. **Required** for lipsync, captions, dubbing and tool models. |
| `resolution` | enum `360p`, `480p`, `540p`, `720p`, `768p`, `1080p`, `2K`, `4K`, `4k`, `8K`; per model. |
| `aspect_ratio` | `auto`, `adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16` |
| `generate_audio` | bool |
| `image_url` (alias `first_frame_url`), `end_image_url` (alias `last_frame_url`) | First and last frame. `end_image_url` needs `image_url`. |
| `video_url` | Source for video-to-video, video lipsync and captions. |
| `audio_url` | Speech for lipsync. |
| `reference_image_urls` (max 30), `reference_video_urls` (max 10), `reference_audio_urls` (max 10) | Per-model caps are lower (e.g. 9-10 images). |
| `frame_images`, `input_references` | OpenRouter-style objects; for `auto-` only. |
| Per-tool objects: `captions{style, srt?, position?, shadow?}`, `dubbing{target_language, source_language?}`, `upscale{factor?, fps?, model?}`, `background{output}`, `depth{colormap}`; seedance-2.5 only: `extend`, `source_duration`, `draft`, `draft_job_id`; `bitrate_mode` | |
| `model_params`, `metadata`, `mode`, `webhook_url`, `wait_timeout_seconds` | Same as image. |

Verbatim docs examples:
```json
{ "model": "seedance-2.5", "prompt": "Steam rises from a coffee cup as the camera slowly pushes in", "duration": 5, "resolution": "480p", "aspect_ratio": "16:9" }
{ "model": "kling-4", "prompt": "The kite drifts gently in the wind, waves roll in", "image_url": "https://media.sume.com/assets/asset_6f1d0c2b/source.png", "duration": 5 }
{ "model": "veed-fabric-1.0", "image_url": "https://media.sume.com/assets/asset_face/source.jpg", "audio_url": "https://media.sume.com/assets/asset_voice/source.wav", "duration": 8, "resolution": "480p" }
```

Image references are **URLs only**. They must be public HTTPS URLs that download without cookies or headers and stay valid until the job ends. Localhost, private-network and non-HTTPS URLs are refused at submit. Local files go through the upload flow in section 5.

### 3c. Submit response: 202 Accepted (verbatim from docs)

```json
{ "data": {
    "request_id": "job_7513b52d-3669-4ffe-b317-8b02000715eb",
    "job": { "id": "job_7513b52d-3669-4ffe-b317-8b02000715eb", "type": "image_generation", "status": "queued",
             "model": "gpt-image-2", "created_at": "2026-10-21T02:31:52.075Z", "result": null, "error": null },
    "status_url": "https://api.sume.com/v1/jobs/job_.../status",
    "result_url": "https://api.sume.com/v1/jobs/job_.../result",
    "events_url": "https://api.sume.com/v1/jobs/job_.../events",
    "cancel_url": null, "cancelable": false,
    "next_action": "poll_status", "next_poll_after_seconds": 2,
    "terminal": false, "idempotency_hit": false } }
```
- The job id is `data.job.id`, which equals `data.request_id` and has the form `job_<uuid>`.
- `job.type` is `image_generation` or `video_generation`.
- The OpenAPI marks these as required on the submit envelope, although the docs example omits them: `recommended_poll_interval_seconds`, `retry_after_seconds`, `result_ready`, `usage: { credits: int, usd: "0.00" }` (the charge, rounded up to the cent), `generation_limits` (nullable), and `sync` (nullable; for sync mode).
- The full `job` object also carries `idempotency_key`, `communication_mode`, `updated_at`, `started_at`, `completed_at`, `canceled_at`, `auth_source`, `input`, `usage_summary` and `webhook_delivery`.
- In sync mode the `sync` object holds `{wait_timeout_seconds, completed, terminal, succeeded, failed, canceled, result_ready, timed_out, capacity_exhausted}`. The OpenAPI says sync can answer 200 or 202 with the same envelope, so handle both.

### 3d. Idempotency

- Same key + same body returns the original job with `idempotency_hit: true`, charged once.
- Same key + different body: `409 idempotency_conflict`.
- A retryable refusal frees the key: `queue_full`, `provider_capacity_exceeded`, or a `provider_submission_failed` with `retryable: true`. Resend with the **same** key.
- A final refusal keeps its answer: after `insufficient_funds` or `api_key_spend_limit_exceeded`, send a **new** key.
- Key lifetime/TTL is not documented (UNVERIFIED).

## 4. Jobs

### States

| `sume_status` (and `job.status`) | `status` | Terminal | Money |
|---|---|---|---|
| `queued` | `IN_QUEUE` | no | reserved |
| `processing` | `IN_PROGRESS` | no | reserved |
| `completed` | `COMPLETED` | yes | captured |
| `failed` | `FAILED` | yes | refunded |
| `canceled` | `CANCELED` | yes | refunded |

`next_action` is one of `poll_status`, `fetch_result` or `inspect_events`.

### `GET /v1/jobs/{id}/status`: 200

```json
{ "data": { "request_id": "job_...", "job_id": "job_...", "status": "IN_PROGRESS", "sume_status": "processing",
  "status_url": "...", "result_url": "...", "cancel_url": null, "cancelable": false,
  "next_action": "poll_status", "next_poll_after_seconds": 2, "result_ready": false, "terminal": false } }
```
The OpenAPI adds these required fields:
- `events_url`, `recommended_poll_interval_seconds`, `retry_after_seconds`
- `queue: { state: waiting|deferred|runtime_unavailable|processing|completed|failed|canceled, reason, position|null, available_at, retry_after_seconds, runtime{...} }`
- `queue_position`, `logs_available`
- optional `job`: the full job object, including `error` and `usage_summary`

A failed job's reason is in `job.error`:
```
{ code?, message?, category, stage, retryable, retry_after_seconds, public_reason, next_action, details? }
```
- `public_reason` is `"content_policy_rejected"` for content refusals.
- `details` may contain `provider_error_type`, `provider_error_message` and `input_field`.

### `GET /v1/jobs/{id}/result`

200 (verbatim from docs):
```json
{ "data": { "request_id": "job_...", "job_id": "job_...", "status": "COMPLETED",
  "result": { "artifacts": [ {
     "id": "artf_UCdnhWThU_Tbemv7E2gE7-ee9lNCIDxP", "type": "image",
     "url": "https://media.sume.com/artifacts/artf_UCdnhWThU_Tbemv7E2gE7-ee9lNCIDxP/images.png",
     "content_type": "image/png", "visibility": "public_by_link", "size_bytes": 1354577,
     "width": null, "height": null, "duration_ms": null } ] } } }
```
- Artifact fields per the OpenAPI: `id`*, `type`* (`image`, `video`, `audio`, `model`, `file`), `url`*, `content_type`* (nullable), `public_artifact_id`, `visibility`, `stage`, `size_bytes`, `width`, `height`, `duration_ms`, `checksum_sha256`.
- `data.job` (the full job) and `data.linked_resource` are also present.
- With `num_images` > 1, each image is one artifact.
- Error codes: `409 job_not_completed` while running (retryable, `details.status`); `409 job_failed` (message = reason); `409 job_canceled`.

### `POST /v1/jobs/{id}/cancel`

- Works only before generation starts (`cancelable: true`).
- 200 shape:
  ```
  { data: { request_id, job_id, status: "CANCELED", canceled: bool, idempotency_hit: bool,
            status_url, result_url, cancellation: { supported, requested, message }, job } }
  ```
- Canceling a job that is already canceled returns 200 with `idempotency_hit: true`.
- `409 job_generation_already_started` (`details: {status, cancelable, reason:"generation_started"}`) or `409 job_not_cancelable` (job already ended).

### Other job routes

- `GET /v1/jobs/{id}`: the full job.
- `GET /v1/jobs/{id}/events?limit=`: a sanitized timeline.
- `GET /v1/jobs?limit=1..100&status=&type=&starting_after=` returns `{data:{jobs:[...], next_cursor?}}`. `next_cursor` is absent on the last page. An unknown query parameter answers `400 unknown_parameter`.
- `POST /v1/jobs/{id}/webhook/redeliver`.

### Cost fields on a job

`job.usage_summary` is in **credits**, with USD in cents:
```
{ status: reserved|captured|refunded, reserved_credits, captured_credits, refunded_credits, released_credits,
  reserved_usd_cents, captured_usd_cents, refunded_usd_cents, released_usd_cents, final, updated_at }
```
- The submit envelope's `usage.usd` (a string, rounded up to the cent) is the figure to show a person.
- The credit-to-USD ratio is **not documented**. From the `/v1/catalog` rows it works out to about 62.5 credits = $1. For example, "9.38 credits per audio second" matches $0.15/s, and 145 credits matches $2.32. This is DERIVED and UNVERIFIED; do not hard-code it. Use the `*_usd_cents` fields and `usage.usd`.

## 5. Uploads and downloads

1. `POST /v1/files/generate-upload-url` with body `{ "content_type": "image/png", "size_bytes": 482113, "filename"?: "cup.png" }`.
   - `size_bytes` must be exact, up to 2 GiB, and is signed into the URL.
2. The response is 201:
   ```json
   { "data": { "public_url": "https://media.sume.com/assets/asset_6f1d0c2b9a8e4f7d/source.png",
     "upload_url": "https://…r2.cloudflarestorage.com/…", "upload_method": "PUT",
     "upload_headers": { "content-type": "image/png", "content-length": "482113" },
     "content_type": "image/png", "expires_at": "2026-10-21T02:46:37.491Z", "asset_id": "asset_6f1d0c2b9a8e4f7d" } }
   ```
3. `PUT` the raw bytes to `upload_url` with exactly `upload_headers` and **no API key**.
   - The URL expires 15 minutes after it is issued. Treat it as a secret and do not log it.
   - Once the PUT returns 200, `public_url` is usable in any `*_url` field.
4. Optional: `POST /v1/assets/{asset_id}/complete` checks that the bytes arrived (`409 asset_upload_incomplete` if not).
   - The reference page lists `/v1/assets/*` as "hidden from public OpenAPI", so treat this step as best-effort.
5. Upload errors: `400 invalid_request`, `413 asset_too_large` (`details.max_bytes`), `503 asset_store_not_configured`.

Some input limits come only from the older docs site (`input_media_too_large`):
- reference images up to 30 MB each, at most 10 of them over 7 MB;
- `image_not_fetchable` / `input_media_unreachable` when Sume cannot fetch the URL.

Downloads:
- Artifacts are plain public URLs on `https://media.sume.com/artifacts/...` (`visibility: "public_by_link"`), not signed. Fetch them with no auth.
- The docs say "copy it to your own storage if you need to control access".
- **Artifact retention or expiry is not documented (UNVERIFIED).** Download promptly.
- Do not parse artifact paths; the docs say they are opaque.

## 6. Billing semantics

- One workspace balance in **USD**, funded by dashboard top-ups only (from $5; each top-up lasts 365 days). Sume pays the card fee.
- Router models are billed at the provider price with 0% markup. Per-model rates are in `/v1/open/catalog`, `/v1/{image,video}-router/models` and https://www.sume.com/pricing/api.
- Lifecycle: submit reserves the price. If the balance is short, the call fails with `402 insufficient_funds` and nothing is charged. `completed` captures the reservation; `failed` or `canceled` refunds it.
  - `insufficient_funds` details: `{required_usd:"0.29", available_usd:"0.01"}`. Older clients also see `required_credits` and `available_credits`.
- Price basis:
  - `per_image`: price x `num_images`, varying by quality and resolution.
  - `per_second` / `per_second_by_resolution`: rate x `duration` for the chosen resolution, with optional audio surcharges in `options[].audio`.
  - Some models use special units (seedance-2.5 `1000_video_tokens`).
  - Video-input models bill input plus output seconds (Wan, Gemini edit).
  - Captions bill at least 60 s, and dynamic styles bill twice.
  - topaz-video bills twice above 30 fps.
  - Always call `/v1/open/estimate`; do not reimplement the formulas.
- Per-key spend limits (USD) and per-workspace concurrency (below) are separate gates.
- Sample rates from the catalogue:

  | Model | Rate |
  |---|---|
  | seedance-2.5 | 480p/720p/1080p = $0.1028/$0.2312/$0.5686 per second |
  | kling-4 | 720p $0.157/s, 1080p $0.235/s |
  | wan-3.0 | 720p $0.10/s |
  | gpt-image-2 | low $0.006, medium $0.053, high $0.211 per image |

## 7. Errors

Envelope (verbatim):
```json
{ "error": { "code": "invalid_request", "message": "Invalid request body.", "request_id": "req_0ee3...",
  "category": "validation", "stage": "validation", "retryable": false, "retry_after_seconds": null,
  "public_reason": "invalid_request", "next_action": "fix_input",
  "details": { "errors": [ { "path": "prompt", "loc": ["prompt"], "message": "must have required property 'prompt'", "type": "required" } ] } } }
```
- `request_id` is also sent as the `x-sume-request-id` header.
- `next_action` values: `fix_input`, `authenticate`, `add_funds`, `retry_later`, `poll_status`, `inspect_events`, `contact_support`.
- Every retryable error sends `retry-after`. Branch on `code`.

| Case | Status / code |
|---|---|
| Invalid, missing or revoked key | `401 unauthorized` (also `session_not_accepted`) |
| Wrong scope or route | `403 insufficient_scope`, `403 open_key_route_not_allowed` |
| Insufficient balance | `402 insufficient_funds` (`details.required_usd`, `available_usd`); never charged |
| Per-key spend cap | `403 api_key_spend_limit_exceeded` (`details.limit_usd`, `spend_usd`, `requested_usd`, `limit_reset`, `resets_at`) |
| Schema or validation mismatch | `400 invalid_request` with `details.errors[]{path,loc,message,type}`; `400 bad_request` (invalid JSON); `415 unsupported_media_type`; `413 payload_too_large` |
| Unknown model | `404 model_not_found` / `not_found` |
| Rate limit | `429 rate_limited` + `retry-after`; `details.scope` says read or write |
| Concurrency full | `429 queue_full`, `retry-after: 30`, `details.generation_limits`; retry with the same idempotency key |
| Provider issues | `502 provider_submission_failed` (refunded; retry only if `retryable`), `503 provider_capacity_exceeded` (refunded; retry with the same key), `503 provider_not_configured` (do not retry) |
| Transient Sume issues | `500 internal_error`; `503 database_busy`, `deploy_draining`, `overloaded`, `replica_not_ready`, `api_key_auth_unavailable` (retry after `retry-after`) |

The live probe `est5` returned the verbatim validation body:
```
details.errors: [{path:"duration", message:"duration is at most 30 seconds except on lipsync models (60) and caption models (600).", type:"custom"},
                 {path:"", message:"Kling 4.0 duration must be 3–30 seconds.", type:"custom"}]
```

## 8. Rate limits, polling, webhooks

**Rate limits:**
- Per key, separate read and write budgets per 60 s window. Write budgets by plan: Free 120/min, Pro 300, Startup 600, Scale 1200. Read = 40x write (Free 4800).
- Unauthenticated callers are limited per IP: write 120, read 480.
- Live headers confirm this: `ratelimit-limit: 120` on POST and `480` on unauthenticated GET; `4800` on GET with a key; `ratelimit-remaining`; `ratelimit-reset: 60`.

**Concurrency:**
- Comes from top-ups in the last 28 days: under $25 -> 2 processing / 10 queued; $25 -> 10/50; $100 -> 20/100; $1,000 -> 40/200 (older docs site).
- Read live values from `generation_limits` on the submit response (`concurrency_limit`, `queued_jobs_limit`, `queue_capacity_remaining`, `wave_size_hint`).

**Polling:**
- Wait `next_poll_after_seconds` between polls. It is 2 s while running; the header `x-sume-poll-after` carries the same value (docs only, not in the OpenAPI).
- On 429/5xx, sleep `retry-after`.
- Images take 5-30 s; video takes 1 to several minutes.
- Never resubmit after a local timeout. Reuse the job id, or the same `Idempotency-Key`.

**Webhooks:**
- Set `mode: "webhook"` and `webhook_url` (public HTTPS).
- Delivery is terminal-only, with three events:

  | Event | `status` |
  |---|---|
  | `job.completed` | `OK`; output in `payload.artifacts[]` |
  | `job.failed` | `ERROR`; reason in `error` |
  | `job.canceled` | `ERROR` |

- Body: `{event, request_id, job_id, status, payload, error?}`.
- Signature:
  - Headers: `x-sume-webhook-timestamp`, `x-sume-webhook-signature: sume-v1=<hex>`.
  - The signature is HMAC-SHA256 over `<timestamp>.<raw body>`, keyed with the workspace secret (`GET /v1/webhooks/signing-secret`).
  - During rotation the header holds several comma-separated entries.
  - Reject timestamps older than 300 s.
- Retries: answer 2xx within 10 s. Up to 10 tries, starting at 30 s and doubling, capped at 1 h. Dedupe on `job_id`.
- Other routes: `POST /v1/webhooks/test-deliveries`, `POST /v1/webhooks/signing-secret/rotate`.

## 9. MCP and CLI

| Surface | Endpoint | Auth |
|---|---|---|
| Hosted MCP, for people | `https://mcp.sume.com/mcp` (streamable HTTP) | OAuth (PKCE, DCR) with scopes `mcp:read` (17 tools) and `mcp:write` (41 tools). Answers an API key with `401 api_key_not_accepted`. |
| Hosted MCP, for scripts | `https://api.sume.com/mcp` | API key (Bearer or `x-api-key`), full tool set. A key made on the "Open pages" gets `403 open_key_route_not_allowed`. |
| Local `sume mcp` | does not exist | "Not launched in current `sumelabs/cli` releases (`sume mcp doctor` -> `coming_soon`)". |

- Paid MCP calls need `idempotency_key`. `dry_run: true` returns the price (`usage.usd`); `max_spend_usd` caps a call.
- The CLI (`curl https://cli.sume.com/install | bash`, binary `sume`) has no first-class image or video router subcommands.
- The official SDKs are `@sume-com/client` (Node 18+) and `sume-client` (Python).

## Recommendation for the TypeScript client (ranked)

1. **Wait strategy.** Use async submit plus polling on `status_url`, honouring `next_poll_after_seconds` and `retry-after`.
   - It needs no inbound endpoint and works for both images and video.
   - Webhooks are second; they need a public HTTPS receiver and should still have polling as a fallback.
   - `sync` is last: it caps at 30 s, video outlasts it, and it can return `capacity_exhausted`.
2. **Auth header.** Use `Authorization: Bearer`, the form every doc example uses. Never send both headers.
3. **Price check.** Before submitting, call `/v1/open/estimate` (free, keyless) with the `input` wrapper. Treat the submit response's `usage.usd` as authoritative.
4. **Local images.** Use `generate-upload-url` + PUT, then pass `public_url`. Skip `/v1/assets/{id}/complete`, which is hidden from the public contract.
5. **Idempotency.** Always send a UUID `Idempotency-Key`. Keep it with the job id. Reuse it only for retryable refusals or network errors; switch to a new key after 402 or 403.

### Trade-off matrix: wait strategies

| Option | Complexity | Latency | Reliability | Infra | Rank |
|---|---|---|---|---|---|
| async + poll | low | +0-2 s | high (reads are cheap; 40x budget) | none | 1 |
| webhook | medium (HMAC, receiver, dedupe) | lowest | high, with a poll fallback | public HTTPS endpoint | 2 |
| sync/subscribe | lowest | ok only for fast images | breaks past 30 s or on capacity | none | 3 |

Adoption risk:
- The API is young; the build version is v1.0.69 and the docs reference weekly changes.
- `/v1/open/*` is undocumented in the OpenAPI.
- Two docs sites disagree (USD vs credits).
- Mitigations: parse defensively (unknown fields allowed), branch on `code`, and keep the model list dynamic (from the catalogue, not hard-coded).

## Limitations / UNVERIFIED

- No authenticated call was made. All success shapes come from docs and the OpenAPI, not live traffic.
- Artifact URL lifetime and retention: not documented.
- Idempotency-Key retention window: not documented.
- Credit-to-USD ratio (about 62.5 credits per $1): derived, not stated.
- Whether the reservation for lipsync models is the 300 s worst case when audio cannot be read: inferred from the estimate only.
- Whether `/v1/open/estimate` with a key takes the workspace price book into account: not documented.
- Whether `subscribe` mode differs from `sync`: the OpenAPI says they are aliases.
- What the "Open pages"/open.sume.com key type is and how it differs from a dashboard key: only partially documented.

## Unresolved questions

1. Which key type will we hold: a dashboard key or an "open.sume.com" key? The answer decides `/v1/open/balance` vs `/v1/balance` access and MCP access.
2. Is `media.sume.com` artifact retention long enough to skip re-hosting, or must the client always download immediately?
3. Should the client trust the `/v1/open/catalog` model list or the larger router enums in the OpenAPI? Recommendation: trust the catalogue.
