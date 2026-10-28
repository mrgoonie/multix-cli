# Sume native REST API — evidence for the multix provider

Checked 2026-10-28 against the official docs. Only free, unauthenticated reads
were made (docs pages, the OpenAPI document, the public catalog, and one
`POST /v1/open/estimate`, which is documented as non-billable). No key was
available, so no authenticated or paid call was made.

## Sources

| Source | URL |
|---|---|
| Docs home and quickstart | https://www.sume.com/docs, https://www.sume.com/docs/quickstart |
| Authentication | https://www.sume.com/docs/authentication |
| Errors and idempotency | https://www.sume.com/docs/errors |
| Images, video | https://www.sume.com/docs/images, https://www.sume.com/docs/video |
| Jobs and polling | https://www.sume.com/docs/jobs |
| File uploads | https://www.sume.com/docs/uploads |
| Limits and billing | https://www.sume.com/docs/limits, https://www.sume.com/docs/billing |
| Agent quick start (catalog/estimate) | https://www.sume.com/sume-api/quick-start |
| OpenAPI ("Sume Developer API" 1.0.0) | https://api.sume.com/reference/json |
| Public catalog | https://api.sume.com/v1/open/catalog |

## Endpoints used by multix

Quick start: "1. Pick a model: GET https://api.sume.com/v1/open/catalog lists every
model with its id, modes, capabilities and dollar prices. 2. Price it: POST
https://api.sume.com/v1/open/estimate with {"model": "<id>", "input": {...}} returns
the exact dollars for that input. 3. Submit: POST .../v1/video-router/generate
(video, lipsync, captions) or .../v1/image-router/generate (images) ... The 202
holds the job id, status_url and result_url. 4. Poll: GET .../v1/jobs/<id>/status
until completed, failed or canceled; then GET .../v1/jobs/<id>/result for media
URLs. POST .../v1/jobs/<id>/cancel cancels. 5. Failed and canceled jobs are
refunded; you pay only for completed ones."

| Purpose | Request | Notes |
|---|---|---|
| Catalog | `GET /v1/open/catalog` | Public. `{data:{currency:"USD", models:[...]}}`. 76 models on 2026-10-28 (video 39, image 21, lipsync 15, captions 1). |
| Estimate | `POST /v1/open/estimate {model, input}` | Answered without a key too (probed once). `{data:{model, currency, usd:"0.0060", usd_micros:6000, route, billing:{unit, quantity, duration_seconds, resolution}}}`. Unknown model: 404 `model_not_found`. Does not validate: a 99 s duration was clamped to 30. |
| Image submit | `POST /v1/image-router/generate` | 202 (200 in sync mode). Body `additionalProperties: false`; required `model`, `prompt`. |
| Video submit | `POST /v1/video-router/generate` | Same envelope; required `model`. Video, lipsync and captions models. |
| Status | `GET /v1/jobs/{id}/status` | `status` IN_QUEUE/IN_PROGRESS/COMPLETED/FAILED/CANCELED, `sume_status` queued/processing/completed/failed/canceled, `terminal`, `next_poll_after_seconds`. |
| Result | `GET /v1/jobs/{id}/result` | `data.result.artifacts[]` `{id, type, url (https://media.sume.com/...), content_type, size_bytes, width, height, duration_ms}`; 409 `job_not_completed`/`job_failed`/`job_canceled`. |
| Job | `GET /v1/jobs/{id}` | Whole job including `usage_summary`. |
| Cancel | `POST /v1/jobs/{id}/cancel` | "Works only before generation starts"; 409 `job_generation_already_started` / `job_not_cancelable`. |
| Upload | `POST /v1/files/generate-upload-url {content_type, size_bytes, filename?}` then `PUT upload_url` | 201 `{public_url, upload_url, upload_method:"PUT", upload_headers, expires_at, asset_id}`. "PUT the file to upload_url with exactly the upload_headers. Then pass public_url to a model." "The upload URL is a secret". Up to 2 GiB. |

Uploads: "Models take media as public HTTPS URLs ... image_urls, image_url,
end_image_url, video_url, audio_url and the reference_*_urls fields all take URLs".

## Auth

Authentication page: `Authorization: Bearer sume_live_...` (or `x-api-key`, never
both). Keys are server-side only. `GET /v1/open/balance` checks a key without
spending ("A 200 means the key works"); it returns the workspace balance, which
multix never records as spend. Auth errors: 401 `unauthorized`, 403
`insufficient_scope`, 403 `open_key_route_not_allowed`, 403
`api_key_spend_limit_exceeded` ("Not charged").

## Errors, retries, idempotency

Envelope: `{error:{code, message, request_id, category, retryable,
retry_after_seconds, details, ...}}`, plus the `x-sume-request-id` header.

- 402 `insufficient_funds`: "details has required_usd and available_usd. Not charged."
- 409 `idempotency_conflict`: "The Idempotency-Key was used for a different request."
- 429 `queue_full`: "Not charged. Yes [retry], once a job ends, with the same Idempotency-Key"; also `rate_limited`.
- 502 `provider_submission_failed`: "The model could not start the job. Refunded."
- "Do not retry 401, 403, 404 or a 400 you have not fixed."
- Idempotency: "Send an Idempotency-Key on every generate request and reuse it on
  retry ... 1–255 printable ASCII characters ... The same key with the same body
  returns the original job with idempotency_hit: true, charged once."
- Jobs page: "A job still running past it keeps running; check it again later instead of resubmitting."
- Polling: "Wait next_poll_after_seconds between calls (also sent as x-sume-poll-after)."
  The docs' own poller retries 429 and 5xx after `retry-after`.

multix sends each generate POST once with a fresh Idempotency-Key (or the
caller's `--idempotency-key`) and never retries it. A cut-off connection, or a
5xx that is not a Sume error envelope, is reported as `UNKNOWN_REMOTE_STATE`
with the key, so the user can resubmit the same body with the same key (charged
once) or look the job up.

## Billing semantics

- Limits page: "You submit | The price is reserved from the workspace balance."
  "The job fails or is canceled | The reservation is refunded."
- Billing page: "A job's price is reserved from the balance when you submit it,
  and settled when it ends. A generation that fails is refunded to the balance."
- Generate response `data.usage`: "Credits this request is charged: what the
  reservation holds and capture settles ..."; `usd` is "rounded up to the cent".
  This is a hold at submit time, not a settled charge.
- `job.usage_summary` (OpenAPI, nullable): `status` reserved/captured/refunded,
  `reserved_credits`, `captured_credits` ("0 until captured"), `refunded_credits`,
  `released_credits`, optional `*_usd_cents` ("in whole US cents, rounded up"),
  `final` ("True once the Sume usage reservation has been captured or released").

multix maps: a final `usage_summary` settles the receipt with
`cost_usd = captured_usd_cents / 100` and `credits = captured_credits`; a
non-final summary and the submit-time `usage` quote are never reported as spend.
No credit-to-USD rate is published, so credits are never converted.

## Catalog fields multix relies on

Each model: `id`, `name`, `kind` (image/video/lipsync/captions), `modes`,
`pricing {currency, unit ("image"|"second"), options[{label, usd, usd_micros,
resolution?, quality?, audio?}], qualifier:"from"}`, `capabilities`,
`constraints[]`, and for 34 models `request_fields` (e.g. `prompt: {omit:true}`,
`duration: {required:true, min, max}`).

- Image capabilities: `text_to_image`, `image_edit`, `aspect_ratios`,
  `resolutions`, `qualities`, `max_images`, `output_formats`.
- Video capabilities: `text_to_video`, `image_to_video`, `end_frame`,
  `reference_images`, `reference_videos`, `reference_audios`, `video_to_video`,
  `audio`, `lipsync`, `captions`, `resolutions`, `duration_seconds{min,max}`,
  `duration_values`, `aspect_ratios`, `max_reference_images`, `routes`.

Example (`seedance-2.5`): options 480p $0.1028/s, 720p $0.2312/s, 1080p $0.5686/s;
`duration_seconds {min:4, max:30}`. The estimate probe for 720p and 5 s returned
$1.156 (= 5 x 0.2312). Catalog prices carry `qualifier: "from"` and constraints
such as "billed on the source clip's length, in 5 s steps" or "billed for at
least 60 s", so a catalog-only estimate is never a proven ceiling.

## Not supported, and why

- Remix models (`sume-remix-*`) use their own routes (`capabilities.routes`, e.g.
  `POST /v1/sume/remix/restyle/v1.0`): refused by `sume video`.
- Models whose `request_fields` require a field multix does not map
  (`captions.style`, `dubbing.target_language`, `preset_id`): refused with a
  schema-mismatch error instead of being sent.
- Webhooks, `mode: sync|subscribe`, `model_params`, `metadata`, batch: not used.
- Sume's hosted MCP server: not used; multix calls the REST API directly.
- `GET /v1/open/usage` answers 501 `billing_in_dashboard`; usage history comes
  from the jobs' own `usage_summary`.
