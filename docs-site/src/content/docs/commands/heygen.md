---
title: HeyGen commands
description: HeyGen v3 Video Agent prompt-to-video, scripted avatar videos, translation, lipsync, TTS, templates, and the HeyGen Video model.
---

HeyGen commands require `HEYGEN_API_KEY` (create one at
[app.heygen.com/developers/api](https://app.heygen.com/developers/api)). The
provider uses the HeyGen **v3** API only and authenticates with the
`X-Api-Key` header.

:::caution[Billing]
HeyGen API usage is billed separately from HeyGen web/app subscriptions. A web
plan does not include API credits. Check your API balance with
`multix heygen me` or at
[app.heygen.com/developers/usage](https://app.heygen.com/developers/usage).
:::

## Choose the right command

| You want | Command | Who writes the script |
| --- | --- | --- |
| A finished video from an idea or brief | `heygen video-agent "<prompt>"` | HeyGen Video Agent: it writes the script and picks avatar, voice, scenes, and B-roll |
| An avatar that says exactly your words | `heygen video "<script>" --avatar <look-id>` | You. You choose the avatar look, voice, and exact script, or supply recorded audio |
| A short cinematic clip (no avatar) | `heygen model-video "<prompt>"` | The HeyGen Video model (`heygen-video-1`), 5-15 s with audio |
| An existing video in other languages | `heygen translate <source> --languages ...` | Translation keeps the speaker's voice and lip-syncs |
| An existing video with new audio | `heygen lipsync --video <ref> --audio <ref>` | Your audio |
| A Studio template filled with values | `heygen template <id> --input vars.json` | Your template |

**Video Agent** (`video-agent`) is prompt-to-video: describe the video and the
agent plans it. **Scripted avatar videos** (`video`) are deterministic: the
avatar speaks your script word for word. Use `video-agent` for drafts and
explainers from a brief; use `video` when the wording, avatar, and voice must
be exact.

## Video Agent (prompt-to-video)

```bash
multix heygen video-agent "A 45-second product explainer for our note app, upbeat tone" \
  [--avatar <look-id>] [--voice <voice-id>] [--style <style-id>] \
  [--orientation landscape|portrait] [--file <ref>]... \
  [--brand-kit <id>] [--brand-glossary <id>] \
  [--callback-url <https-url>] [--callback-id <id>]
```

- The prompt can be up to 10,000 characters. `--file` attaches up to 20
  reference files (slides, images, footage).
- The agent runs in generate mode: a session (`session_id`) is created, the
  agent plans the video, and a `video_id` is assigned once rendering starts.
  The CLI follows the session to its video, waits, and downloads the MP4 and
  thumbnail.
- If the session stops for input or fails before rendering, the command exits
  non-zero with the reason.
- List styles with `multix heygen styles [--tag cinematic]`.

## Scripted avatar video

```bash
multix heygen video "Hi, I'm Anna. Here's what's new this week." --avatar <look-id> \
  [--voice <voice-id>] [--aspect-ratio 16:9|9:16|4:5|5:4|1:1|auto] \
  [--resolution 4k|1080p|720p] [--engine avatar_iv|avatar_v|avatar_iii] \
  [--background-color "#ffffff" | --background-image <ref>] [--remove-background] \
  [--output-format mp4|webm] [--burn-captions] [--captions] \
  [--speed 0.5-1.5] [--pitch -50..50] [--volume 0-1] [--locale en-US] \
  [--motion-prompt <text>] [--expressiveness high|medium|low] [--reference-look <look-id>] \
  [--title <text>] [--folder <id>] [--brand-glossary <id>]

# Lip-sync the avatar to recorded audio instead of a script
multix heygen video --avatar <look-id> --audio ./voiceover.mp3
```

- `--avatar` takes a **look** ID from `multix heygen avatars` (not a group ID).
  The script can be up to 5,000 characters.
- Use either a script or `--audio`, not both. `--voice` and voice settings
  apply only to scripts.
- `--resolution 4k` requires `--engine avatar_iii` (digital twins and studio
  avatars). `--reference-look` requires `--engine avatar_v`.
  `--expressiveness` is Avatar IV only. `--motion-prompt` is not available with
  Avatar III.
- `--output-format webm` renders a transparent background, so it cannot be
  combined with `--background-*`.
- A subtitle file is always produced when captions are requested.
  `--burn-captions` also burns them into the video and downloads that
  captioned render (`captioned_video_url`); the command fails if HeyGen
  returns no captioned render. `--captions` downloads the subtitle file next
  to the video.
- Other `POST /v3/videos` variants (image, cinematic avatar, studio) are
  available through `heygen run video --input <json>`.

## HeyGen Video model

```bash
multix heygen model-video "A drone shot over a misty forest at sunrise" \
  [--mode text_to_video|image_to_video|reference_to_video] \
  [--image <ref>] [--reference-image <ref>]... [--reference-video <ref>]... [--reference-audio <ref>]... \
  [--duration 5-15] [--resolution 480p|768p|1080p|2k] \
  [--aspect-ratio 21:9|16:9|4:3|1:1|3:4|9:16|adaptive] \
  [--prompt-enhancement turbo|quality|disabled] [--seed <n>]
```

The mode is inferred: `--image` selects image-to-video, any `--reference-*`
selects reference-to-video, and otherwise the mode is text-to-video.
`adaptive` aspect ratio is only valid for reference-to-video. Image-to-video
follows the first frame, so it takes no aspect ratio. Up to 9 reference
images, 3 videos, and 3 audio files, with at most 12 reference files in total.

## Translation and lipsync

```bash
multix heygen languages
multix heygen translate ./talk.mp4 --languages "Spanish, French, Chinese (Cantonese, Traditional)" \
  [--mode speed|precision] [--input-language <code>] [--audio-only] [--audio <ref>] \
  [--speakers <n>] [--keep-format] [--no-dynamic-duration] [--disable-music] [--enhance-speech] \
  [--start <s>] [--end <s>] [--brand-glossary <id>] [--captions] [--output <dir>]

multix heygen lipsync --video <ref> --audio <ref> [--mode speed|precision] [--start <s>] [--end <s>]
```

- `--languages` takes language **names** from `heygen languages`. Commas inside
  parentheses are kept, so `Chinese (Cantonese, Traditional)` stays one
  language.
- One translation job is created per language. The CLI waits for all of them,
  downloads every successful output (`--output` is treated as a directory when
  there are several), and exits non-zero if any language or download failed.
  A failed download does not stop the remaining languages from downloading.

## Text-to-speech

```bash
multix heygen tts "Welcome to the show." --voice <voice-id> \
  [--ssml] [--speed 0.5-2] [--language en] [--locale en-US] \
  [--engine starfish|orca|elevenlabs] [--output hello.mp3] [--no-download] [--json]
```

Speech is synchronous (up to 5,000 characters) and the audio file is
downloaded immediately.

## Catalog and account

```bash
multix heygen avatars [--groups] [--group <group-id>] [--type studio_avatar|digital_twin|photo_avatar] \
  [--ownership public|private] [--limit 1-50] [--cursor <token>] [--json]
multix heygen voices [--language English] [--gender male|female] [--engine <e>] \
  [--type public|private] [--limit 1-100] [--cursor <token>] [--json]
multix heygen styles [--tag <tag>] [--limit <n>] [--cursor <token>] [--json]
multix heygen me
```

Lists are paginated. When more results exist, table output ends with
`More results: --cursor <token>`, and `--json` prints
`{ data, has_more, next_token }`.

## Templates and raw operations

```bash
multix heygen template <template-id> --input '{"name":{"type":"text","properties":{"content":"Duy"}}}' [--title <text>]
multix heygen run <operation> --input <json|@file.json>
```

`template` accepts a bare variables map or the full request body. `run` sends
a raw v3 payload verbatim to a documented create operation: `video-agent`,
`video`, `video-translation`, `lipsync`, `model-video`, or `speech`. It then
waits for and downloads the result like the dedicated commands. `run` does not
upload local files; use URLs or `asset_id` inputs.

## Media references and uploads

Wherever a command takes a `<ref>` (`--audio`, `--file`, `--image`,
`--background-image`, translation/lipsync sources), you can pass:

- `https://...`: a public URL, sent as `{ "type": "url" }`.
- `asset:<asset_id>`: an asset already uploaded to HeyGen.
- A local path: uploaded first via `POST /v3/assets` (multipart, **32 MB
  maximum**; png, jpg, mp4, webm, mp3, wav, pdf, srt). For larger files, host
  them at a public HTTPS URL instead.

## Async jobs, status, and resume

All generation commands wait for completion and download outputs by default.
They accept the same set of flags:

- `--async` prints the job IDs and a resume command without waiting.
- `--wait-timeout <ms>` sets the deadline (default 30 minutes).
- `--poll-interval <ms>` sets the first interval (default 10 s), which backs
  off to 30 s.
- `--no-download` prints the output URL instead of downloading it. With
  `--json`, the summary includes the usable `output_url` (and `caption_url`).
  These URLs are signed, so treat the output as sensitive.
- An existing file at the destination is only replaced after a download
  completes; a failed download leaves it untouched.
- `--output`, `--captions`, `--no-thumb`, and `--json` work as their names
  suggest.

```bash
multix heygen status <id> --type agent|video|translation|lipsync|model-video [--wait] [--download] [--burn-captions] [--json] [--raw]
```

- `--burn-captions` reads the burned-in caption render of a video, as the
  resume command printed by `heygen video --burn-captions` does.

- `--type agent` takes a Video Agent `session_id` and follows it to the video.
  The other types take the ID that the matching command printed.
- Status is resumable at any time because the job state lives on HeyGen. A
  timeout prints the exact `multix heygen status ... --wait --download`
  command to continue.
- Output URLs are signed and expire. If a download fails with 403/404/410,
  re-run `status ... --download` to get a fresh URL.

## Webhooks

`--callback-url` (HTTPS only) asks HeyGen to notify your endpoint when a job
completes or fails. HeyGen signs the raw request body with HMAC-SHA256 using
the endpoint secret and sends the hex digest in the `signature` header.

The published `multix-cli` package does not export a webhook verifier. The
repository source has one at
`src/providers/heygen/webhook.ts` (`verifyHeygenWebhookSignature`, Web Crypto,
works in Node 20+ and Cloudflare Workers) that you can copy into your receiver.
In Node, the check is:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
```

Verify the raw body exactly as received, not re-serialized JSON.

## Errors and limits

Failures exit with code 1 and an actionable message. The CLI never reports a
failed or cancelled job as success.

| Status | Meaning | What to do |
| --- | --- | --- |
| 401 | Invalid or missing key | Check `HEYGEN_API_KEY` |
| 402 | `insufficient_credit` / `plan_upgrade_required` | Add API credits; API billing is separate from web plans |
| 403 | Missing scope or entitlement | Use a key with the required scopes; some avatar features need Enterprise |
| 404 | Unknown ID | Check the ID and that `--type` matches it |
| 429 | Rate/concurrency limit or `quota_exceeded` | The CLI honours `Retry-After`; reduce parallel jobs |

- Rate-limited (429) create requests are retried after `Retry-After`. Server
  errors are retried only on endpoints that document an `Idempotency-Key`
  (videos, translations, lipsyncs, templates, assets, model videos), which the
  CLI sends automatically. Video Agent and speech creates are never replayed.
- Pay-as-you-go API accounts can run about 10 concurrent workflows. HeyGen
  recommends polling every 10-30 s, which the default backoff respects.
- Logs never include the API key or signed URL query strings, and prompts are
  not logged.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `HEYGEN_API_KEY` | For HeyGen | API key, sent as `X-Api-Key` |
| `HEYGEN_BASE_URL` | No | Override the API base (default `https://api.heygen.com`), for proxies and tests |

Digital-twin creation and voice cloning are not part of this provider.
