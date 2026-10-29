# Native Sume and TopView providers (issue #413)

Status: in progress on `claude/gracious-heisenberg-1rzwbn` (base `dev`)

## Outcome

- `multix sume`: public catalog discovery (`sume models`), `sume image`,
  `sume video`, `sume status`, `sume cancel`, `sume estimate` (provider quote),
  local-file upload, async jobs with resume, idempotent submit.
- `multix topview`: two separate surfaces with separate keys and balances.
  - Legacy API (`TOPVIEW_API_KEY` + `TOPVIEW_UID`, web-plan credits):
    url-to-video, materials-to-video, video-avatar, product-avatar (V3 chain),
    product-anyshoot, upload, credit, status.
  - API Platform (`TOPVIEW_PLATFORM_API_KEY`, USD balance): models, run on a
    verified route allowlist with `Idempotency-Key`, prediction status.
- Registration: `multix check`, setup hints, `.env.example`, capability
  registry, Worker command policy and provider-key dashboard, catalog, README,
  skill, docs EN + VI.

## Decisions

- Endpoints come from the official docs only. The marketing-page paths
  (`/v1/url2video`, `/v1/materials2video`, `/v1/product_avatar/task/submit`,
  `/v1/product_anyshoot/task/submit`) are not in TopView's reference docs and
  cannot be checked without a key, so the documented `/v1/m2v`, `/v3/...`
  endpoints are used instead.
- Sume pre-flight price: catalog pricing option x units from the cached public
  catalog. No cache, a stale cache, or several candidate options give
  `unknown` or an `estimated` (not proven) ceiling; `--max-cost` fails closed.
- TopView pre-flight price: `unknown` (credits have no published USD rate;
  Platform prices use per-family units). Actual cost is reported from
  `costCredit` / `charged_usd`.
- Sume and TopView Platform submits reuse one `Idempotency-Key` across
  retries. TopView legacy submits have no idempotency and are never retried
  after an ambiguous failure.
- No cross-provider fallback; no default model (Sume needs `--model` or an env
  default).

## Research

- `plans/reports/researcher-261028-0902-sume-api.md`
- `plans/reports/researcher-261028-0902-topview-api.md`

## Acceptance

See issue #413. Offline tests only; no live key available, so no paid smoke run.
