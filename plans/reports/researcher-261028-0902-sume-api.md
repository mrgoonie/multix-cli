# Sume native REST API: research for a TypeScript provider client

Date: 2026-10-28 (UTC). Researcher: researcher subagent. No API key used; no paid endpoint called.

## Outcome

A provider client needs only about eight endpoints, and they are documented well enough to build against now:
the public catalog, the estimate endpoint, two router submit endpoints, job status, job result, job cancel,
and the upload URL. Every field name below is copied from the live OpenAPI document, the docs pages, or a live
unauthenticated response. The one gap is `POST /v1/open/estimate`. Sume documents its request shape in a single
place and does not document its response anywhere, so treat the estimate as best-effort until a keyed call
confirms the shape.

## Sources and credibility

| ID | Source | Credibility |
|---|---|---|
| S1 | Live OpenAPI 3.0.3 `https://api.sume.com/reference/json` (same as `/v1/openapi.json`, 4.1 MB, 560 paths) | Highest. The docs call it the "source of truth". |
| S2 | `https://api.sume.com/v1/open/catalog` and `/v1/open/catalog/{id}`, live unauthenticated responses | Highest for the catalog shape. Saved to `/tmp/claude-0/-workspace/7a47674c-91a0-5ade-9bb4-5f68f8c4aecc/scratchpad/sume-catalog.json` |
| S3 | `https://www.sume.com/docs` plus `/docs/quickstart`, `/authentication`, `/models`, `/images`, `/video`, `/jobs`, `/webhooks`, `/errors`, `/limits`, `/uploads`, `/reference`, `/billing` | High. These are the current official docs (USD-denominated). |
| S4 | `https://www.sume.com/sume-api/quick-start` (the "agent prompt") | Medium. This page is the only source for `/v1/open/estimate`. |
| S5 | Official SDK `@sume-com/client@0.3.1` (npm, published 2026-10-25), `dist/v2/client.js` | High. Shows how Sume's own client calls the API. |
| S6 | `https://www.sume.com/docs/mcp`, `/docs/mcp/tools-and-gates` | High for MCP. Not relevant to REST. |
| S7 | `https://docs.sume.com/llms-full.txt` (older docs site) | Low. It is stale and still describes billing in "credits" plus `/v1/balance`. It conflicts with S3. |

Conflict note: the docs on www (S3) and the error descriptions in the OpenAPI (S1) both say an API key from Dashboard →
API keys is billed in USD. Some older OpenAPI schema fields still say "credits" (`usage.credits`,
`usage_summary.*_credits`, `credits_per_second`). Build on the USD fields and treat the credit fields as legacy.

## 1. Base URL and auth

- The base URL is `https://api.sume.com` (sources: S3 `/docs` "At a glance", and the OpenAPI `servers`). All routes are under `/v1`.
- The auth header is `Authorization: Bearer sume_live_...`. The API also accepts `x-api-key: sume_live_...`.
  - Send exactly one of the two. "a request carrying both `x-api-key` and `Authorization: Bearer` is rejected with `401 unauthorized` (`Send only one API key credential.`)" (S1 securitySchemes, S3 /docs/authentication).
- Keys look like `sume_live_...` (S3).
- The SDK rejects a key that contains whitespace or `:` (S5).
- Successful bodies are wrapped as `{"data": ...}`, and errors as `{"error": ...}` (S3 /docs).
- To validate a key cheaply, call `GET /v1/open/balance`. A `200` means the key works.
  - Response `data`: `balance` (number, USD), `usage_this_month`, `auto_topup_setting`, `billing_type` (`"credit-based"`), `currency` (`"USD"`), `balance_usd_micros`, `usage_this_month_usd_micros` (S3 /docs/authentication).
  - `GET /v1/me` and `GET /v1/balance` both return `403 open_key_route_not_allowed` for these keys.
  - `GET /v1/open/usage` returns `501 billing_in_dashboard`.
- Auth errors (S3):
  - `401 unauthorized`
  - `401 session_not_accepted`
  - `403 insufficient_scope`
  - `403 open_key_route_not_allowed`
  - `503 api_key_auth_unavailable`, which is retryable and comes with `retry-after`.
- I verified live that, without a key, every `/v1/open/*` route except the catalog returns 401 with this body:
  `{"error":{"code":"unauthorized","message":"Missing API key. Send x-api-key or Authorization: Bearer.","request_id":"req_...","category":"auth","stage":"auth","retryable":false,"retry_after_seconds":null,"public_reason":"authentication_required","next_action":"authenticate"}}`

## 2. Endpoints for a provider client

| Method | Path | Auth | Success | Source |
|---|---|---|---|---|
| GET | `/v1/open/catalog` | none (public, `cache-control: public, max-age=60`) | 200 | S2, S4 |
| GET | `/v1/open/catalog/{id}` | none | 200, or 404 `model_not_found` | S2, S5 |
| POST | `/v1/open/estimate` | key (401 without one) | UNVERIFIED | S4 only |
| POST | `/v1/image-router/generate` | key | 202 (200 is also declared) | S1, S3 |
| POST | `/v1/video-router/generate` (video, lipsync, captions) | key | 202 (200 is also declared) | S1, S3 |
| GET | `/v1/image-router/models[/{model_id}]`, `/v1/video-router/models[/{model_id}]` | key | 200 | S1, S3 |
| GET | `/v1/jobs/{id}/status` | key | 200 | S1, S3 |
| GET | `/v1/jobs/{id}/result` | key | 200, or 409 | S1, S3 |
| GET | `/v1/jobs/{id}` | key | 200 (full job envelope) | S1, S3 |
| GET | `/v1/jobs` (query `limit` 1–100, `status`, `type`, `starting_after`) | key | 200 `data.jobs`, `data.next_cursor` | S1, S3 |
| POST | `/v1/jobs/{id}/cancel` | key | 200 | S1, S3 |
| GET | `/v1/jobs/{id}/events` (query `limit`) | key | 200 `data.request_id`, `data.job_id`, `data.events` | S1 |
| POST | `/v1/jobs/{id}/webhook/redeliver` | key (`jobs:write`) | 200 | S1 |
| POST | `/v1/files/generate-upload-url` | key | 201 | S1, S3 |
| POST | `/v1/assets/{asset_id}/complete` (optional upload check) | key | not specified; hidden from public OpenAPI | S3 /docs/uploads, /docs/reference |
| GET | `/v1/open/balance` | key | 200 | S3 |
| GET | `/v1/health` | none | 200 `{"apiVersion":"v1","status":"ok","build":{...}}` (verified live) | S1, live |

## 3. Catalog: `GET /v1/open/catalog` (live, S2)

On 2026-10-28 the catalog listed 76 models: 39 `video`, 21 `image`, 15 `lipsync`, and 1 `captions`.

```
{ "data": { "currency": "USD", "models": [ <row>, ... ] } }
```

A single row comes from `/v1/open/catalog/{id}` and is returned as `{"data": <row>}`. Fields of a row:

- `id`: the model id to send as `model` (for example `"seedance-2.5"`, `"gpt-image-2"`). Some ids contain a slash, such as `"sumelabs/wand"` and `"sumelabs/depth-anything-video"`, so URL-encode the id in path routes. The SDK uses `encodeURIComponent`.
- `slug`: for example `"bytedance/seedance-2.5"`.
- `name`
- `kind`: `"video"`, `"image"`, `"lipsync"` or `"captions"`. The SDK routes `image` to `/v1/image-router/generate` and the other three to `/v1/video-router/generate` (S5 `ROUTER_BY_KIND`).
- `company`: `{slug, name}`
- `description`
- `modes`: string[]. Values seen: `text-to-video`, `image-to-video`, `text-to-image`, `image-edit`, `reference-to-video`, `video-to-lipsync`, `video-to-video`, `image-to-lipsync`, `motion-transfer`, `object-swap`, `restyle`, `video-captions`.
- `capabilities`. Video rows have:
  - `text_to_video`, `image_to_video`, `end_frame`, `reference_images`, `reference_videos`, `reference_audios`, `video_to_video`, `audio` (all booleans)
  - `resolutions[]`, `duration_seconds{min,max}`, `aspect_ratios[]`
  - sometimes `duration_values[]`, `lipsync`, `captions`, `dubbing`, `video_tool`, `max_reference_images`, `routes[]`

  Image rows have `text_to_image`, `image_edit`, `aspect_ratios[]`, `resolutions[]`, `qualities[]`, `max_images`, and `output_formats[]`.
- `constraints`: string[] of rules in plain text.
- `request_fields`: present on only 34 of the 76 rows. It is a map from field name to `{required, type, description, min, max, default, options, media, omit}`, where `omit: true` means the model does not take that field. Field names seen: `prompt`, `duration`, `generate_audio`, `video_url`, `reference_image_urls`, `image_urls`, `resolution`, `preset_id`, `aspect_ratio`, `captions.style`, `dubbing.target_language`, `num_images`.
- `pricing`:
  - `currency`: `"USD"`
  - `unit`: `"second"` or `"image"`
  - `from_usd`: decimal string, for example `"0.1028"`
  - `from_usd_micros`: integer, for example `102800`
  - `to_usd`: string
  - `qualifier`: always `"from"`
  - `options[]`: each option is `{label, usd, usd_micros, route, resolution?, quality?, audio?}`. Example: `{"label":"480p","usd":"0.1028","usd_micros":102800,"route":"r4fdc55","resolution":"480p"}`. The `route` value is opaque.

The catalog has no JSON Schema for inputs. The input contract is `capabilities` plus `request_fields` (when present)
plus `constraints`.

There are three special-route models (`sume-remix-motion-transfer`, `sume-remix-object-swap`, `sume-remix-restyle`).
They list `capabilities.routes: ["POST /v1/sume/remix/<x>/v1.0"]` and are NOT submitted through the routers.

The catalog and the OpenAPI `model` enums differ. The OpenAPI enums also list `higgsfield-*`, `hunyuan-1.5`, `sam-3-video`
and others that are not in the open catalog. Treat the open catalog as the list of what an Open key can buy.

The router models endpoint (`GET /v1/video-router/models`, S1) returns a different row shape:
`{id, name, modality, routing:"pass_through", gated, capabilities, pricing{basis: per_second|per_second_by_resolution|per_1000_video_tokens, credits_per_second, usd_per_second, usd_per_second_by_resolution, usd_options[{label,resolution,audio,quality,usd}] ...}, constraints}`.
In the docs, the image `pricing.basis` value is `per_image`.

## 4. Estimate: `POST /v1/open/estimate` (UNVERIFIED response)

- The only source is S4: "POST https://api.sume.com/v1/open/estimate with {"model": "<id>", "input": {...}} returns the exact dollars for that input."
- The request body is `{"model": "<id>", "input": { ...same fields as the generate body... }}`. Note that `input` is nested here, while generate takes a flat body.
- The response shape is NOT documented in the OpenAPI, the docs, the npm SDK, or the Python SDK (`sume-client` 0.1.1). The route exists: unauthenticated GET and POST return 401 rather than 404. Do not assume field names. The likely names are `usd` or `usd_micros`, based on the `usage.usd` naming on submit, but that is unverified.
- Alternatives that are documented:
  - The submit response carries `data.usage` = `{credits: integer, usd: string}`, described as "The same charge in US dollars, rounded up to the cent".
  - The MCP `dry_run: true` flag returns the price as `usage.usd` (S6).
  - The hidden route `/v1/generation/admission-preview` exists but is not public.

## 5. Submit: `POST /v1/image-router/generate` and `/v1/video-router/generate`

Headers: `Authorization`, `Content-Type: application/json`, and the optional `Idempotency-Key`.

Image body (S1, S3 /docs/images):

- Required: `model`, `prompt`.
- Optional:
  - `image_urls` (string[], 1–16; alias `input_urls`), `mask_url`, `mask_image_url`
  - `aspect_ratio`
  - `image_size` (preset, `WxH`, or `{width,height}`; wins over `aspect_ratio`)
  - `quality`, `resolution` (`0.5K`, `1K`, `2K`, `4K`, `720p`, `1080p`), `rendering_speed`
  - `num_images` (1–4; alias `n`)
  - `output_format` (`png`, `jpeg`, `jpg`, `webp`; alias `format`), `background`
  - `model_params`, `metadata`
  - `mode`, `webhook_url`, `wait_timeout_seconds`

Fields that a model does not take are refused with `400`.

Video body (S1, S3 /docs/video):

- Required: `model`.
- Optional:
  - `prompt`
  - `duration` (alias `duration_seconds`), `resolution` (`360p`, `480p`, `540p`, `720p`, `768p`, `1080p`, `2K`, `4K`, `4k`, `8K`), `aspect_ratio`
  - `image_url` (alias `first_frame_url`), `end_image_url` (alias `last_frame_url`), `video_url`, `audio_url`
  - `reference_image_urls`, `reference_video_urls`, `reference_audio_urls`
  - `generate_audio`, `extend`, `source_duration`, `draft`, `draft_job_id`, `bitrate_mode`
  - per-model objects: `captions`, `dubbing`, `upscale`, `background`, `depth`
  - `model_params`, `metadata`
  - `mode`, `webhook_url`, `wait_timeout_seconds`

`mode` takes `async` (the default), `webhook`, `sync` or `subscribe`. The last two are the same thing: a blocking wait of at most `wait_timeout_seconds`, which is limited to 0–30.

Response: `202 Accepted` (S3; S1 declares both 200 and 202). Example from S3:

```
{"data":{"request_id":"job_...","job":{"id":"job_...","type":"image_generation"|"video_generation","status":"queued","model":"gpt-image-2","created_at":"...","result":null,"error":null},
 "status_url":"https://api.sume.com/v1/jobs/job_.../status","result_url":".../result","events_url":".../events",
 "cancel_url":null,"cancelable":false,"next_action":"poll_status","next_poll_after_seconds":2,"terminal":false,"idempotency_hit":false}}
```

S1 also lists these `data` fields: `recommended_poll_interval_seconds`, `retry_after_seconds`, `result_ready`,
`usage{credits, usd}`, `generation_limits` (nullable; includes `concurrency_limit`, `queued_jobs_limit`,
`queue_capacity_remaining`, `wave_size_hint`, …), and `sync` (nullable;
`{wait_timeout_seconds, completed, terminal, succeeded, failed, canceled, result_ready, timed_out, capacity_exhausted}`).

The job id has the form `job_<uuid>`. `data.request_id` equals `data.job.id`.

## 6. Status, result and cancel

Status values (S3 /docs/jobs, S1 enums). The two spellings always agree.

| `sume_status` (and `job.status`) | `status` | Terminal |
|---|---|---|
| `queued` | `IN_QUEUE` | no |
| `processing` | `IN_PROGRESS` | no |
| `completed` | `COMPLETED` | yes |
| `failed` | `FAILED` | yes |
| `canceled` | `CANCELED` | yes |

`GET /v1/jobs/{id}/status` returns 200 with these `data` fields:

- `request_id`, `job_id`, `status`, `sume_status`
- `status_url`, `result_url`, `events_url`, `cancel_url` (nullable), `cancelable`
- `next_action`: `poll_status`, `fetch_result` or `inspect_events`
- `next_poll_after_seconds` (nullable), `recommended_poll_interval_seconds`, `retry_after_seconds`
- `result_ready`, `terminal`
- `queue{state, reason, position, available_at, retry_after_seconds, runtime}`, `queue_position`, `logs_available`
- optionally `job`

The poll hint is also sent as the `x-sume-poll-after` header. While a job runs the hint is 2 s.

`GET /v1/jobs/{id}/result` returns 200 with:
`{"data":{"request_id","job_id","status":"COMPLETED","result":{"artifacts":[{...}]},"linked_resource"?,"job"?}}`.

Each artifact has:

- Required: `id` (`artf_...`), `type` (`image`, `video`, `audio`, `model` or `file`), `url` (an `https://media.sume.com/artifacts/...` URL), `content_type` (nullable).
- Optional: `public_artifact_id`, `visibility` (`"public_by_link"`), `stage`, `size_bytes`, `width`, `height`, `duration_ms`, `checksum_sha256`.

The output URLs are therefore `result.artifacts[].url`, and they are public by link. Each image is one artifact.

Errors from the result endpoint (all 409):

- `job_not_completed` (retryable; poll first)
- `job_failed` (the message gives the reason)
- `job_canceled`

The error on a failed job is the `job.error` object: `{code, message, category, stage, retryable, retry_after_seconds, public_reason, next_action, details}`.
A content refusal sets `public_reason: "content_policy_rejected"`. The SDK maps that to its own `nsfw` status.

`POST /v1/jobs/{id}/cancel`:

- No request body.
- Cancel works only before generation starts, which means while `cancelable` is true (S3, S1).
- 200 response `data`: `request_id`, `job_id`, `status: "CANCELED"`, `canceled` (boolean), `idempotency_hit` (true if the job was already canceled), `status_url`, `result_url`, `cancellation{supported, requested, message}`, `job`.
- Cancel is idempotent: cancelling an already-canceled job returns 200.
- A job whose generation has started returns `409 job_generation_already_started`. A job that has already ended returns `409 job_not_cancelable`.
- Canceled jobs are refunded (S3 /docs/jobs, /docs/limits).
- Many models start within a second, so cancel usually fails with 409 after that.

## 7. Billing model

- There is one workspace balance, in US dollars, and each top-up lasts 365 days (S3 /docs/billing).
- Prices are the provider's price "with 0% markup". Sume's own products use the API rate card.
- Charge lifecycle (S3 /docs/limits):
  1. On submit, the price is reserved from the balance.
  2. When the job completes, the reservation is charged.
  3. When the job fails or is canceled, the reservation is refunded.
- A refused submit is never charged. This covers `402 insufficient_funds`, `403 api_key_spend_limit_exceeded` and `429 queue_full`.
- Errors `502 provider_submission_failed` and `503 provider_capacity_exceeded` are documented as "Refunded" (S3 /docs/errors).
- The job's `usage_summary` (S1) is
  `{status: reserved|captured|refunded, reserved_credits, captured_credits, refunded_credits, released_credits, reserved_usd_cents, captured_usd_cents, refunded_usd_cents, released_usd_cents, final, updated_at}`.
  The USD values in it are cents, rounded up. I did NOT verify the credit-to-USD ratio.
- Per-key spend limits are in USD. When a call would exceed one, the API returns `403 api_key_spend_limit_exceeded`, and `details` contains `{limit_usd, spend_usd, requested_usd, limit_reset, resets_at}`.
- Insufficient balance returns `402 insufficient_funds`, and `details` contains `{required_usd, available_usd}` as strings such as `"0.29"`.

## 8. Idempotency

- Send the `Idempotency-Key` header on the generate endpoints. It is 1–255 printable ASCII characters, pattern `^[\x20-\x7E]+$` (S1, S3).
- The same key with the same body returns the original job with `idempotency_hit: true`, charged once.
- The same key with a different body returns `409 idempotency_conflict`. Its `error.details` names `job_id`, `job_type`, `job_status`, `status_url`, `result_url`.
- A retryable refusal frees the key, so you can resend with the same key. This applies to `queue_full`, `provider_capacity_exceeded`, and a retryable `provider_submission_failed`.
- A final refusal keeps its answer. After `insufficient_funds`, use a new key.
- Each job stores its key as `job.idempotency_key`.

## 9. Rate limits, 429 and Retry-After

- Every response carries `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset`. Live unauthenticated responses showed `480`, `479` and `60`.
- `429 rate_limited` carries `retry-after`. Every retryable error also sends `retry-after`, and the body field `retry_after_seconds` (S3 /docs/errors).
- Reads and writes have separate budgets, and `details.scope` names the one that ran out. Write budgets per minute by plan: Free 120, Pro 300, Startup 600, Scale 1200. The read budget is 40× the write budget (S1 429 description).
- `429 queue_full` means the workspace has too many jobs in flight. It comes with `retry-after: 30`, and `details.generation_limits`. The job is not charged.
- The SDK retries on 429, on 5xx, and on network errors. It honours `retry-after` given as seconds or as an HTTP date, and otherwise uses exponential backoff with jitter (S5 `utils/retry.js`). It defaults to 3 retries and a 2 s poll interval.

## 10. File inputs

- Media inputs are public HTTPS URLs that can be fetched without cookies or custom headers and stay valid until the job ends. The API rejects localhost, private-network, and non-HTTPS URLs (S3 /docs/uploads, /docs/reference).
- To send local files, upload them in two steps (S3 /docs/uploads, S1, S5):
  1. `POST /v1/files/generate-upload-url` with body `{content_type (required), size_bytes (required, exact size, max 2 GiB), filename?}`. It returns `201` with `{"data":{"public_url","upload_url","upload_method":"PUT","upload_headers":{"content-type","content-length"},"content_type","expires_at","asset_id"}}`.
  2. `PUT` the bytes to `upload_url` with exactly the `upload_headers`. Do not send the API key to it, and do not log the URL, because it is a secret.
- The upload URL expires after 15 minutes. After the PUT returns 200, pass `public_url` to the generate call. It has the form `https://media.sume.com/assets/asset_.../source.png`.
- Upload errors: `400 invalid_request`, `413 asset_too_large` (with `details.max_bytes`), `409 asset_upload_incomplete`.

## 11. Error envelope (S3 /docs/errors, S1)

```
{"error":{"code","message","request_id","category","stage","retryable","retry_after_seconds","public_reason","next_action","details"?}}
```

- `request_id` is also sent in the `x-sume-request-id` header.
- `next_action` takes these values: `fix_input`, `authenticate`, `add_funds`, `retry_later`, `poll_status`, `inspect_events`, `contact_support`.
- Validation failures put the per-field errors in `details.errors[]`. Each entry is `{path, loc[], message, type}`.
- The full code table is at https://www.sume.com/docs/errors. Codes a provider client should handle:
  - 400: `bad_request`, `invalid_request`
  - 401: `unauthorized`
  - 402: `insufficient_funds`
  - 403: `api_key_spend_limit_exceeded`
  - 404: `not_found`, `model_not_found` (the latter on the catalog)
  - 409: `idempotency_conflict`, `job_not_completed`, `job_failed`, `job_canceled`, `job_generation_already_started`, `job_not_cancelable`
  - 413: `payload_too_large`
  - 415: `unsupported_media_type`
  - 429: `queue_full`, `rate_limited`
  - 500: `internal_error`
  - 502: `provider_submission_failed`
  - 503: `provider_capacity_exceeded`, `provider_not_configured`, `overloaded`

## 12. Webhooks (optional)

- To get a webhook, send `mode: "webhook"` with `webhook_url`.
- The event types are `job.completed`, `job.failed` and `job.canceled`.
- The payload is `{event, request_id, job_id, status: "OK"|"ERROR", payload: {artifacts}}`.
- Each delivery carries two headers, `x-sume-webhook-timestamp` and `x-sume-webhook-signature: sume-v1=<hex>`. The signature is HMAC-SHA256 over `<timestamp>.<raw body>`.
- Reject deliveries whose timestamp is more than 300 s old.
- Failed deliveries are retried up to 10 times (S3 /docs/webhooks).

## Recommendation for the TypeScript client

1. Discover models with `GET /v1/open/catalog`. Route by `kind`: `image` goes to the image router, and everything else goes to the video router. Skip rows that have `capabilities.routes`.
2. Submit with a generated `Idempotency-Key`. Then poll `/v1/jobs/{id}/status`, honouring `next_poll_after_seconds` (default 2 s), until `terminal` is true.
   - If `sume_status === "completed"`, read `/result` and take `result.artifacts[].url`.
   - If the status is `failed` or `canceled`, read `job.error` from `GET /v1/jobs/{id}`.
3. Report cost from `data.usage.usd` on the submit response, which is documented. Call `/v1/open/estimate` before submitting only if a keyed probe confirms its response shape.
4. Upload local files through `/v1/files/generate-upload-url` and a PUT. The client should take `fetch`, `apiKey` and `baseUrl` as inputs and import no `node:*` modules, per AGENTS.md.

The risk of building on this API is moderate. Sume shipped API build `v1.0.69` on 2026-10-28 and still has legacy credit/USD dual fields and docs that disagree with each other. The safeguards are to parse only the documented fields and to tolerate unknown status strings, as the SDK's `statusOf()` does.

## Limitations and unverified items

- **`/v1/open/estimate` response shape:** not verified, and documented nowhere. The only source for the request shape is S4.
- **Live authenticated responses:** none observed (no key was available). The shapes come from the docs and the OpenAPI.
- **Credit-to-USD conversion:** not verified for the `usage.credits` and `usage_summary.*_credits` fields.
- **Whether `/v1/open/catalog` filters:** not verified. A `?kind=video` query returned 200, but I did not check whether the list was actually filtered.
- **Exact rate-limit numbers:** unknown for the "Open" keys.
- **`/v1/assets/{id}/complete`:** its response and status code are undocumented, and the route is hidden from the public OpenAPI.
- **200 vs 202 on submit:** the docs show 202, and the OpenAPI declares both. Accept both.

## Unresolved questions

1. What does `POST /v1/open/estimate` return (field names, and whether amounts are `usd` strings or `usd_micros`)? Answering this needs one keyed call (estimate is free).
2. Are `/v1/sume/remix/*` models (catalog `capabilities.routes`) in scope for the provider?
