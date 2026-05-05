# ElevenLabs API Surface Research Report

**Date:** 2026-05-05 | **Target:** multix elevenlabs subcommand design

---

## A. Feature Inventory

| Category | Feature | Endpoint | Key Parameters | Response | Output Format |
|----------|---------|----------|-----------------|----------|---|
| **TTS** | Text-to-Speech (Standard) | `POST /v1/text-to-speech/{voice_id}` | `text`, `model_id`, `voice_settings` (stability, similarity_boost, style) | Sync | MP3/WAV/PCM (configurable) |
| **TTS** | TTS Streaming | `POST /v1/text-to-speech/{voice_id}/stream` | Same + `stream=true` | Streaming (chunked) | Real-time audio chunks |
| **TTS** | TTS with Voice Guidance | `POST /v1/text-to-speech/{voice_id}` | `applied_voice_guidance_version`, guidance prompts | Sync | MP3/WAV/PCM |
| **Voice Cloning** | Instant Voice Cloning (IVC) | `POST /v1/voices/add` | Audio file (1-2 min), name, labels | Sync | Voice ID (string) |
| **Voice Cloning** | Professional Voice Cloning (PVC) | Studio UI only (no API) | High-quality samples | Async | Voice ID (string) |
| **Voices** | List Voices | `GET /v1/voices` | Category filter optional | Sync | JSON array (10k+ voices) |
| **Voices** | Get Voice | `GET /v1/voices/{voice_id}` | voice_id | Sync | Voice metadata + samples |
| **Voices** | Voice Design | `POST /v1/voice_generation/create_previews` | Text description, accent, age, gender, accents | Sync | Audio samples (5 variants) |
| **STT** | Speech-to-Text (Scribe) | `POST /v1/speech-to-text` | Audio file, language (optional), model (`scribe_v2`) | Sync | JSON {text, confidence} |
| **STT** | STT Realtime (WebSocket) | WebSocket `/v1/speech-to-text` | Stream audio chunks | Streaming/WebSocket | Real-time text chunks + confidence |
| **Speech-to-Speech** | Voice Changer | `POST /v1/speech-to-speech/{voice_id}` | Audio file, `model_id` (eleven_multilingual_v2) | Sync | MP3/WAV/PCM |
| **Sound Effects** | Generate SFX | `POST /v1/text-to-sound-effects` | `text` (description), `duration_seconds`, `prompt_influence`, `output_format` | Async/Polling | MP3/WAV (configurable) |
| **Music** | Generate Music | `POST /v1/music` | `composition_plan` OR `prompt` (text), `style_config` | Async/Polling | MP3 (33 sec default) |
| **Music** | Generate with Details | `POST /v1/music/compose/detailed` | Full `composition_plan` (sections, lyrics, duration) | Async/Polling | MP3 (per section) |
| **Dubbing** | Dub Audio/Video | `POST /v1/dubbing` | Source file (up to 1GB, 2.5h), `target_languages` (array), `num_speakers` (auto or manual) | Async/Polling | MP3/WAV (per language) |
| **Audio Cleanup** | Voice Isolator | `POST /v1/audio-isolation/convert` | Audio/video file (up to 500MB, 1h max), channels config | Async/Polling | MP3/WAV/cleaned audio |
| **Alignment** | Forced Alignment | `POST /v1/alignment` | Audio file, text transcript | Async/Polling | JSON {time, character, confidence} |
| **Models** | List Models | `GET /v1/models` | — | Sync | JSON array (TTS, STT, SFX, Music models) |
| **Account** | User Info | `GET /v1/user` | — | Sync | JSON {subscription_tier, character_count, usage} |
| **Account** | Subscription Info | `GET /v1/user/subscription` | — | Sync | JSON {tier, character_limit, reset_date} |

**Models Reference:**
- TTS: `eleven_flash_v2_5` (75ms, 32 lang, 0.5¢/k chars), `eleven_multilingual_v2` (1-2s, 29 lang, 1¢/k chars), `eleven_v3` (1-2s, 70+ lang), deprecated `eleven_v1`
- STT: `scribe_v2` (90+ languages, realtime capable)
- SFX: `sound_effect_v2`
- Music: `eleven_music` (no version suffix currently)

---

## B. Auth Model

**Method:** API Key in header  
**Header:** `xi-api-key: <YOUR_API_KEY>`  
**Base URL:** `https://api.elevenlabs.io`  
**Format:** Header-based only; no Bearer tokens or OAuth  

[Reference: ElevenLabs Cheat Sheet (2026)](https://www.webfuse.com/elevenlabs-cheat-sheet)

---

## C. Async vs Sync Patterns

**Sync (immediate return):**
- TTS (standard & streaming) — `POST /v1/text-to-speech/{voice_id}` returns MP3 immediately
- Voices (list, get, design) — return within seconds
- STT batch — `POST /v1/speech-to-text` returns text immediately
- Models list — returns immediately
- Account endpoints — return immediately

**Async (long-running, polling required):**
- **Sound Effects** — `POST /v1/text-to-sound-effects` returns job_id; poll `/v1/text-to-sound-effects/{job_id}` until status=`done`
- **Music** — `POST /v1/music` returns job_id; poll `/v1/music/{job_id}` until status=`done`
- **Dubbing** — `POST /v1/dubbing` returns dubbing_id; poll `/v1/dubbing/{dubbing_id}` until status=`done`
- **Voice Isolator** — `POST /v1/audio-isolation/convert` returns job_id; poll until status=`done`
- **Forced Alignment** — `POST /v1/alignment` returns job_id; poll until complete

**WebSocket (real-time streaming):**
- STT Realtime — `ws://api.elevenlabs.io/v1/speech-to-text` streams transcription as audio arrives (no polling needed)

[Reference: Text to Speech API](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [Streaming Guide](https://elevenlabs.io/docs/api/streaming)

---

## D. SDK Availability & Recommendation

**Official SDK:** `@elevenlabs/elevenlabs-js` (v2.45.0, published 2026-04-27)  
**Language:** TypeScript 99.9%, Node.js 15+, Vercel, Cloudflare Workers, Deno, Bun compatible  
**Repo:** https://github.com/elevenlabs/elevenlabs-js

**Key Methods:**
- `textToSpeech.convert()` — text → audio (sync)
- `textToSpeech.stream()` — streaming TTS
- `voices.search()` — voice list/search

**Recommendation: Use native fetch + zod validation (not SDK)**

**Rationale:**
- SDK is minimal (only TTS + voices exposed; no SFX, Music, Dubbing, STT in SDK yet)
- CLI already uses `undici` for HTTP
- Zod validation already in place for request/response schemas
- SDK abstracts async polling poorly for CLI use case (needs `--wait` flag control)
- Raw fetch gives full API coverage without SDK lag
- SDK adds 15-20KB bundle overhead unnecessary for CLI

[Reference: @elevenlabs/elevenlabs-js on npm](https://github.com/elevenlabs/elevenlabs-js)

---

## E. Recommended v1 Scope

**High Value / Low Cost → INCLUDE:**
1. **TTS** (text-to-speech) — core feature, sync, proven CLI pattern (matches Gemini Flash TTS in multix)
2. **Voices list/search** — prerequisite for TTS, lightweight
3. **Instant Voice Cloning** — 1-2 min audio → voice ID, simple REST call
4. **Speech-to-Text** (Scribe batch) — sync, pairs with TTS for round-trip workflows
5. **Voice Changer (Speech-to-Speech)** — sync, single audio file transformation

**Medium Value / Medium Cost → v1.1:**
6. **Sound Effects** — text → SFX (async polling), creative feature, moderate demand
7. **Dubbing** — language translation with voice preservation, async polling, but high character cost (billed per src minute)
8. **Voice Isolator** — audio cleanup, async polling, 1000 chars/min cost

**High Cost / Niche → DEFER (v2+):**
- **Music generation** — async, complex prompt engineering, separate billing model, overlaps with other services
- **Forced Alignment** — niche use case (audiobook/subtitle sync), low adoption signal
- **Agents/Conversational AI** — too complex for CLI (WebSocket, state management, tool integration)
- **Voice Design** — requires iterative UI, better in web app

**Rank by adoption risk & token efficiency:**
```
TTS > Voices > STT > Voice Cloning > Voice Changer > SFX > Dubbing > Isolator
(v1)  (v1)    (v1)  (v1)          (v1)           (v1.1) (v1.1)   (v1.1)
```

[Reference: ElevenLabs Capabilities Overview](https://elevenlabs.io/docs/overview/capabilities)

---

## F. CLI Command Shape Proposal

```bash
# Text-to-Speech (core)
multix elevenlabs tts \
  --text "Hello world" \
  --voice-id <VOICE_ID> \
  --model eleven_flash_v2_5 \
  --output out.mp3 \
  --format mp3 \
  [--stability 0.5] [--similarity-boost 0.75] [--style 0.0]

# Alternative: stdin + piping
echo "Hello" | multix elevenlabs tts --voice-id adam -o out.mp3

# Voices management
multix elevenlabs voices list [--filter category] [--search "female american"]
multix elevenlabs voices get <VOICE_ID>
multix elevenlabs voices design --description "friendly female" --accent american [--age young]

# Voice Cloning
multix elevenlabs clone \
  --audio sample.wav \
  --name "My Voice" \
  [--description "personal voiceover"]

# Speech-to-Text / Transcription
multix elevenlabs transcribe \
  --input audio.mp3 \
  [--language en] \
  [--format json|text] \
  [--output out.json]

# Voice Changer (Speech-to-Speech)
multix elevenlabs voice-changer \
  --input original.mp3 \
  --voice-id <VOICE_ID> \
  --output changed.mp3 \
  [--model eleven_multilingual_v2]

# Sound Effects (async)
multix elevenlabs sfx \
  --description "car engine starting" \
  [--duration-seconds 5] \
  [--prompt-influence 0.3] \
  --output sfx.mp3 \
  [--wait] [--poll-interval 2]

# Dubbing (async, future)
multix elevenlabs dub \
  --input english-video.mp4 \
  --languages es,fr,de \
  [--output-dir dubbed/] \
  [--wait] [--poll-interval 5]

# Voice Isolator (async, future)
multix elevenlabs isolate \
  --input noisy.mp3 \
  --output clean.mp3 \
  [--wait]

# Account info
multix elevenlabs account --show-usage
multix elevenlabs models list
```

**Common flags across all commands:**
- `--api-key <KEY>` — override env ELEVENLABS_API_KEY
- `--output <FILE>` — write to file (default: stdout for stream commands)
- `--format <FMT>` — output codec_sample_rate_bitrate (e.g., mp3_44100_128, pcm_24000)
- `--wait` — for async: block until completion, show progress
- `--poll-interval <SEC>` — polling cadence for async (default 2s)
- `--dry-run` — show request, don't execute

---

## G. Gotchas & Constraints

| Gotcha | Impact | Mitigation |
|--------|--------|-----------|
| **Character billing** | TTS costs per input char; SFX, Music, Dubbing, Isolator per output time | Show character/minute estimates before execution; add `--estimate-cost` flag |
| **Flash v2.5 = 0.5¢/k chars** | 50% cheaper than Multilingual v2 (1¢/k) | Default to Flash for v1; add `--model` to override |
| **Voice Isolator: 1000 chars/min audio** | 10-min audio = 10k character cost (~$0.06) | Warn users upfront; add cost estimate |
| **Dubbing: billed per source minute** | 10-min video = 10 character units (~$0.12 per lang) | Show per-language cost before dubbing |
| **Async jobs 24h TTL** | Job IDs expire; must poll or re-submit | Set default `--wait` for SFX/Music/Dub; cache job IDs in .elevenlabs/ |
| **File size: Dubbing max 1GB, Isolator max 500MB** | Large media rejected | Validate pre-upload; suggest chunking for Isolator |
| **Max audio: Isolator 1 hour** | Longer audio fails | Enforce 1h limit; suggest splitting if longer |
| **Supported audio formats** | MP3, WAV, FLAC, AAC, OGG, µ-law; Dubbing accepts video (MP4, MOV, MKV) | Auto-detect via ffmpeg; reject unsupported upfront |
| **TTS: 32 languages (Flash) vs 29 (Multilingual v2)** | Language coverage varies by model | Document language matrix in help text |
| **Music: no copyrighted material** | "Mentioning band/musician names" blocks generation | Warn: "Cannot use artist/band names in prompts" |
| **STT Realtime WebSocket** | No batch API; requires streaming connection | Batch STT (`POST /v1/speech-to-text`) is sync; use that for CLI |
| **Rate limits** | Not publicly documented; burst pricing for agents (3x, 2x cost) | Start with 10 concurrent, back off on 429; no CLI-specific burst needed |
| **Professional Voice Cloning (PVC)** | No API; studio-only workflow | Document as "Web UI only" in help; link to webapp |

[Reference: Pricing (2026)](https://elevenlabs.io/pricing/api), [Dubbing docs](https://elevenlabs.io/docs/overview/capabilities/dubbing), [Voice Isolator docs](https://elevenlabs.io/docs/overview/capabilities/voice-isolator)

---

## H. Implementation Architecture Notes

**File structure proposal:**
```
src/
├── providers/
│   └── elevenlabs/
│       ├── client.ts          # HTTP client + zod schemas
│       ├── types.ts           # Interfaces (Voice, Model, etc.)
│       ├── commands/
│       │   ├── index.ts       # registerElevenlabsCommands()
│       │   ├── tts.ts
│       │   ├── voices.ts
│       │   ├── clone.ts
│       │   ├── transcribe.ts
│       │   ├── voice-changer.ts
│       │   ├── sfx.ts         # async with polling
│       │   └── account.ts
│       ├── utils/
│       │   ├── polling.ts     # async job polling
│       │   ├── cost-calculator.ts
│       │   └── format-converter.ts
│       └── .env.example       # ELEVENLABS_API_KEY
```

**Async pattern (SFX, Music, Dub, Isolator):**
```ts
// Poll until done or timeout
async function waitForCompletion(jobId: string, type: 'sfx'|'music'|'dub'|'isolate') {
  const maxWait = 5 * 60 * 1000; // 5 min default
  const pollInterval = opts.pollInterval * 1000;
  let elapsed = 0;
  while (elapsed < maxWait) {
    const status = await getJobStatus(jobId);
    if (status === 'done') return getResult(jobId);
    if (status === 'failed') throw new Error(`Job failed: ${jobId}`);
    await sleep(pollInterval);
    elapsed += pollInterval;
  }
  throw new Error(`Timeout waiting for ${type} job`);
}
```

**Cost calculator (warn before execution):**
```ts
function estimateTtsCost(text: string, model: string): number {
  const charCount = text.length;
  const costPerK = model.includes('flash') ? 0.06 : 0.12;
  return (charCount / 1000) * costPerK;
}
// Display: "This will use ~150 characters (~$0.009). Continue? [Y/n]"
```

---

## Unresolved Questions

1. **Streaming TTS in CLI** — should `multix elevenlabs tts --stream` output raw PCM to stdout for piping to audio player, or buffer to file? (Recommendation: `--stream` → stdout PCM; `--output file.mp3` → sync buffer-and-save)

2. **Professional Voice Cloning (PVC)** — document as web-only or plan REST API integration later? (Recommendation: v1 skip; PVC is premium, web-first, low CLI demand)

3. **Async job caching** — should CLI cache job IDs locally (`./.elevenlabs/jobs.json`) to allow resume? (Recommendation: Yes, for robustness; add `multix elevenlabs jobs status <ID>`)

4. **Cost warnings interactive** — require user confirmation before any billable call, or add `--assume-yes` / `--no-confirm` flag? (Recommendation: Interactive by default; flag to suppress)

5. **Voice design iteration** — generate 5 samples, then user picks one to finalize. CLI support? (Recommendation: v2; requires interactive selection UI, less common)

6. **Default model selection** — Flash v2.5 by default (cheaper, fast) or Multilingual v2 (higher quality)? (Recommendation: Flash; document override in help)

---

## Summary

ElevenLabs has a mature, well-documented REST API covering TTS, STT, voice cloning, voice transformation, and creative generation (SFX, music, dubbing). **For multix v1, recommend:**

- **TTS** + **Voices** + **STT Batch** + **Voice Cloning** + **Voice Changer** = core 5 commands (sync, high demand)
- **SFX** + **Dubbing** + **Isolator** = v1.1 (async, polling required, good ecosystem fit)
- Defer **Music**, **Forced Alignment**, **Agents** to v2+

Use **native fetch + zod** (not SDK) for full API coverage. Implement **cost estimation** and **async polling** helpers to manage UX around long-running jobs.

---

**Sources:**
- [ElevenLabs Documentation Overview](https://elevenlabs.io/docs/overview/intro)
- [Text-to-Speech API Reference](https://elevenlabs.io/docs/overview/capabilities/text-to-speech)
- [Voice Cloning (Instant)](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning)
- [Speech-to-Text / Transcription](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
- [Sound Effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)
- [Music Generation API](https://elevenlabs.io/docs/overview/capabilities/music)
- [Dubbing Capability](https://elevenlabs.io/docs/overview/capabilities/dubbing)
- [Voice Isolator](https://elevenlabs.io/docs/overview/capabilities/voice-isolator)
- [ElevenLabs Pricing (2026)](https://elevenlabs.io/pricing/api)
- [ElevenLabs Cheat Sheet (2026)](https://www.webfuse.com/elevenlabs-cheat-sheet)
- [@elevenlabs/elevenlabs-js SDK](https://github.com/elevenlabs/elevenlabs-js)
- [Official ElevenLabs CLI](https://github.com/elevenlabs/cli)
- [ElevenLabs Pricing Breakdown (BIGVU)](https://bigvu.tv/blog/elevenlabs-pricing-2026-plans-credits-commercial-rights-api-costs)
- [ElevenLabs Rate Limits & Billing](https://flexprice.io/blog/elevenlabs-pricing-breakdown)
