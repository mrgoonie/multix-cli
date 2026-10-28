# Seedance video API list prices (BytePlus, Atlas Cloud, Leonardo, fal.ai)

Read on 2026-10-28 (UTC). All amounts are USD list prices, verbatim from the provider's own page.
"Not published" means the provider's public pages carry no figure. No number below is estimated.

## Bottom line

- **BytePlus**: per-million-token rates are published for Seedance 2.0 and 2.0 Fast. **`seedance-2.0-pro` does not exist on the price page; not published.**
- **Atlas Cloud**: the amount is $0.009, but **the unit is unclear**. The page says "per run"; the evidence points to per second.
- **Leonardo**: **not published** for Seedance 2.0 or 2.0 Fast. The calculator and pricing pages need a login or return 403.
- **fal.ai**: per-second and per-1K-token rates are published for Seedance 2.0, 2.0 Fast and 1.0 Pro Fast.

## 1. BytePlus ModelArk

Source: https://docs.byteplus.com/en/docs/ModelArk/model-pricing ("Pricing").
The page body is client-rendered, so the text was taken from the page's embedded document JSON.

Units, quoted from the page: "Token prices are USD per million tokens."

Formula, quoted from the page:

- "Estimated video price: Token unit price × token consumption"
- "Estimated token consumption: (Input video duration + output video duration) × output video width × output video height × output video frame rate / 1024"
- "Token consumption values are estimates. Actual consumption is determined by usage.completion_tokens in the API response."
- "You are only charged for successfully generated videos."
- "For the Dreamina Seedance 2.0 series ... minimum token consumption applies when the input includes video"

The minimum-consumption table was not extracted.

Online inference, USD per 1M tokens. The pricing table has no row for audio on or off.

| Model id (BytePlus) | Input | 480p and 720p | 1080p | 4K | Offline |
|---|---|---|---|---|---|
| dreamina-seedance-2-0-260128 | without video | $7.0 | $7.7 | $4.0 | Not supported |
| dreamina-seedance-2-0-260128 | with video | $4.3 | $4.7 | $2.4 | Not supported |
| dreamina-seedance-2-0-fast-260128 | without video | $5.6 | Not supported | Not supported | Not supported |
| dreamina-seedance-2-0-fast-260128 | with video | $3.3 | Not supported | Not supported | Not supported |
| seedance-1-0-pro-fast-251015 (reference) | — | $1 | (blank) | (blank) | $0.5 |

Published examples (16:9, 5 s output, no input video), quoted:

- "Dreamina Seedance 2.0 | $0.35 per video / $0.07 per second" (480p).
- 2.0 at 720p: "$0.76 per video / $0.15 per second".
- 2.0 at 1080p: "$1.87 per video / $0.37 per second".
- 2.0 at 4K: "$3.89 per video / $0.78 per second".
- "Dreamina Seedance 2.0 Fast | $0.28 per video / $0.06 per second" (480p).
- 2.0 Fast at 720p: "$0.60 per video / $0.12 per second".

Mapping to multix model ids:

- `seedance-2.0` maps to dreamina-seedance-2-0-260128.
- `seedance-2.0-fast` maps to dreamina-seedance-2-0-fast-260128.
- `seedance-2.0-pro` has **no BytePlus price; not published**. No such model appears on the price page.

## 2. Atlas Cloud

Sources:

- Catalog: `GET https://api.atlascloud.ai/api/v1/models` (public, no key).
- Model pages: https://www.atlascloud.ai/models/bytedance/seedance-v1-pro-fast/text-to-video and https://www.atlascloud.ai/models/bytedance/seedance-v1-pro-fast/image-to-video

| Model id | Mode | Amount | Unit as published |
|---|---|---|---|
| bytedance/seedance-v1-pro-fast/text-to-video | t2v | $0.009 (list $0.01, "discount":"90") | see below |
| bytedance/seedance-v1-pro-fast/image-to-video | i2v | $0.009 (list $0.01, "discount":"90") | see below |

What each source says:

- **Catalog JSON**: `"price": {"discount": "90", "actual": {"base_price": "0.009"}, "origin": {"base_price": "0.01"}}`. It states no unit.
- **Model page**: "Your request will cost $0.009 per run. For $10 you can run this model approximately 1111 times." It also carries `<meta name="pricing" content="0.009">`. The default schema is 480p, 5 s and 16:9; durations are 2–12 s; resolutions are 480p, 720p and 1080p.

Why the unit is unclear:

- The "per run" sentence comes from a generic UI template (`costPerRun`) that the site uses for every model.
- A sibling Atlas model shows the opposite pattern. seedance-v1.5-pro text-to-video-fast has `base_price` 0.018, and its family blurb on the same site says "from $0.018 per second".
- BytePlus lists 1.0 Pro Fast at $0.05 for a 480p 5 s video. That fits $0.009 per second (5 s comes to $0.045) better than $0.009 per run.
- **Verdict:** the amount is verified, but **the unit is not stated unambiguously**. Treat it as unverified, or confirm it from the cost of a real job.
- No per-resolution price is published. Only one price is shown.

## 3. Leonardo

Sources:

- https://docs.leonardo.ai/docs/seedance-20.md
- https://docs.leonardo.ai/docs/seedance-20-fast.md
- https://docs.leonardo.ai/docs/payg-guide.md
- https://docs.leonardo.ai/docs/pricing-and-plans-faq.md
- https://docs.leonardo.ai/docs/plan-with-the-pricing-calculator.md

| Model id | Mode | Price |
|---|---|---|
| seedance-2.0 | t2v / i2v | **not published** |
| seedance-2.0-fast | t2v / i2v | **not published** |

The model guides contain no credit or USD figures.

The pricing is behind a login or blocked:

- The calculator says it "helps you plan out how many API credits different generations use" and links to https://app.leonardo.ai/api-access/pricing-calculator, which needs a login.
- https://leonardo.ai/api/ and https://leonardo.ai/pricing/ returned HTTP 403.

The USD-per-credit rate is not published. The PAYG guide only says "Credits convert to dollars based on a standardised rate", with no figure.

The FAQ says: "Generation responses now include a `cost` object showing the amount charged and the unit (dollars or credits)". The real cost is therefore observable per job, but no list price is published.

## 4. fal.ai

Sources:

- https://fal.ai/models/<endpoint_id>. The quotes below come from each page's rendered pricing box.
- `https://api.fal.ai/v1/models/pricing?endpoint_id=…` returned 401 ("API key authentication required"), so it was not used.

| Endpoint id | Mode | Conditions | Price (quoted) |
|---|---|---|---|
| bytedance/seedance-2.0/text-to-video | t2v | 720p / 1080p | "For every second of 720p video you generated, you will be charged $0.3034/second and for 1080p you will be charged $0.682/second . Your request will cost $0.014 per 1,000 tokens for 480p, 720p and 1080p . Your request will cost $0.008 per 1,000 tokens for 4k . The number of tokens is given by (height of output video * width of output video * duration * 24) / 1024." |
| bytedance/seedance-2.0/image-to-video | i2v | same | Identical text to the t2v page. |
| bytedance/seedance-2.0/fast/text-to-video | t2v | 720p | "For every second of 720p video you generated, you will be charged $0.2419/second . Your request will cost $0.0112 per 1,000 tokens. The number of tokens is given by (height of output video * width of output video * duration * 24) / 1024." |
| bytedance/seedance-2.0/fast/image-to-video | i2v | 720p | Identical text to the fast t2v page. |
| fal-ai/bytedance/seedance/v1/pro/fast/text-to-video | t2v | 1080p 5 s; other resolutions | "Each 1080p 5 second video costs roughly $0.245 . For other resolutions, 1 million video tokens costs $1 . tokens(video) = (height x width x FPS x duration) / 1024." |
| fal-ai/bytedance/seedance/v1/pro/fast/image-to-video | i2v | 1080p 5 s; other resolutions | "Each 1080p 5 second video costs roughly $0.243 . For other resolutions, 1 million video tokens costs $1.00 . tokens(video) = (height x width x FPS x duration) / 1024." |

fal notes:

- **Audio:** the 2.0 readme sections on the same pages say "Audio generation is included at no extra cost regardless of the `generate_audio` setting". The 2.0 t2v readme labels its rows "720p with audio".
- **Readme conflict:** the fast i2v readme lists "Standard tier | $0.3024 / sec". The pricing box says $0.3034. **Use the box ($0.3034).**
- **Video inputs:** the pages also embed reference-to-video text: "If video inputs are provided the price is multiplied by 0.6". This applies to reference-to-video, which is not one of the four endpoints above.
- **US-hosted variant:** bytedance/seedance-2.0/us/text-to-video has its own price: "roughly $0.37/second" at 720p and "$0.1731/second" at 480p, "$0.0168 per 1000 tokens for 480p and 720p".

## Method and limitations

- **BytePlus**: tables were rebuilt from the page's embedded document JSON. Row and cell mapping was checked against the published example rows, which match the token rates (for example, 720p 5 s at $7/M gives about $0.76).
- **Not covered**:
  - BytePlus 2.0 minimum-token tables for video input, and draft mode.
  - Regional price differences on BytePlus.
  - Atlas or fal volume discounts.
  - Leonardo prices visible inside a logged-in account.
- **Prices change often.** Each figure is a reading taken on 2026-10-28.

## Unresolved questions

1. **Atlas unit:** is the $0.009 for v1-pro-fast per second or per run? Confirm it with one real job's billed cost.
2. **`seedance-2.0-pro`:** which BytePlus model id does multix's `seedance-2.0-pro` resolve to, if any? No price is published under that name.
3. **Leonardo:** is a logged-in pricing-calculator export, or the `cost` object from a test job, acceptable evidence for the price book?
