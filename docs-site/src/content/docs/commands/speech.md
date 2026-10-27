---
title: Speech commands
description: Text-to-speech across Gemini, OpenAI, ElevenLabs, MiniMax, Atlas Cloud, Fish Audio, OpenRouter, and fal.ai with one request shape and explicit routing.
---

`multix speech` puts the text-to-speech models of several providers behind one
set of flags. It does not replace the provider commands (`gemini
generate-speech`, `openai generate-speech`, `elevenlabs tts`, `minimax
generate-speech`, `atlas audio`, `fish tts`, `openrouter tts`, `fal tts`); those keep working as before. Use `speech`
when you want to compare providers, pick a model by language, or let an agent
choose without learning each provider's flags.

Providers: `gemini`, `openai`, `elevenlabs`, `minimax`, `atlas`, `fish`, `openrouter`,
`fal`. Each needs its
own key (see [Environment variables](/reference/environment/)); no new key is
introduced.

## Find a model

```bash
multix speech models                     # every speech model, grouped by provider
multix speech models --language vi       # only models that document Vietnamese
multix speech models -p minimax --json   # one provider, as a JSON array
multix speech models --ready             # only providers whose key is set
```

Each row shows the model's documented languages, audio formats, whether it
takes `--style`, its named emotions, how many speakers it can voice, async
support, how voices are named (and the command that lists them), the
provider-specific `--extra` keys, how the provider bills, and the source and
date the facts were checked against. The provider default model is marked.
`--language` hides models whose provider publishes no language list; the table
output names the ones it hid.

The rows come from the CLI's own catalog (`src/speech/speech-catalog.ts`); treat the
installed `multix speech models` output as current, not this page.

## Generate speech

```bash
multix speech generate --provider openai --text "Welcome to multix." --output welcome.mp3
multix speech generate --provider elevenlabs --model eleven_v3 --language vi \
  --text-file intro.txt --output intro.mp3
```

Run `multix speech generate --help` for the full flag list. The main ones:

| Flag | Meaning |
| --- | --- |
| `--provider <name>` | The provider to run on. |
| `--model <id>` | Model id; default is the provider's own TTS default. |
| `--text <str>` / `--text-file <path>` | The text, inline or from a UTF-8 file (one of them, not both). |
| `--voice <id>` | A voice of the chosen provider; default is that provider's default voice. |
| `--speaker <name:voice>` | Multi-speaker dialogue (repeatable; Gemini, up to 2). Each text line starts with `name:`. |
| `--language <code>` | Language code (e.g. `vi`, `fil`), checked against the model's documented list. |
| `--style <text>` | Delivery direction, for models with style support. |
| `--emotion <name>` | Named emotion, for models with an emotion parameter (MiniMax). |
| `--format <fmt>` | Audio container; otherwise taken from the `--output` extension or the model's first format. |
| `--output <path>` | Copy the audio to this path. |
| `--async` | Submit and print a job id and resume command (models with async support, such as Atlas Cloud and fal). |
| `--fallback <route>` | Opt-in fallback route `provider[:model[:voice]]` (repeatable); see below. |
| `--extra <provider.key=value>` | Provider-specific option, for example `elevenlabs.stability=0.4` (repeatable). |

The whole request is validated before any provider is called, and every
problem is reported at once: a voice that belongs to another provider, a
language the model does not document, `--style` or `--emotion` on a model
without them, a format the model cannot write, `--async` on a synchronous
model, or an `--extra` key the provider does not take.

### Vietnamese dialogue (Gemini, two speakers)

```bash
cat > scene.txt <<'EOF'
Lan: Chào anh Minh, hôm nay anh khỏe không?
Minh: Chào Lan, anh khỏe lắm, cảm ơn em!
EOF

multix speech generate --provider gemini --language vi \
  --text-file scene.txt \
  --speaker "Lan:Kore" --speaker "Minh:Puck" \
  --output scene.wav
```

### Vietnamese with an emotion (MiniMax)

```bash
multix speech generate --provider minimax --language vi --emotion happy \
  --text "Xin chào các bạn, chào mừng đến với multix!" --output hello.mp3
```

MiniMax receives `--language` as its `language_boost` value; the
`multix speech models` row says which request field each provider uses.

### Fish Audio

```bash
multix speech generate --provider fish --model drama-3 \
  --text "Welcome to multix." --extra fish.speed=1.1 --output welcome.mp3
```

The route sends the same native request as
[`multix fish tts`](/commands/fish/), with the default voice Adrian unless
`--voice` names another. It sends one voice; for multi-speaker dialogue use
`multix fish tts --turns-file`. `--extra` takes `fish.temperature`,
`fish.top_p`, `fish.speed`, `fish.volume`, `fish.chunk_length`,
`fish.normalize`, and `fish.latency`.

### OpenRouter

```bash
multix speech generate --provider openrouter --model elevenlabs/eleven-v4 \
  --voice sarah --text "Welcome to multix." --extra openrouter.speed=1.1 --output welcome.mp3
```

The route sends the same request as
[`multix openrouter tts`](/commands/openrouter/) with one `OPENROUTER_API_KEY`.
`speech models` lists the OpenRouter speech models whose formats and voices
were checked; any other id from `multix openrouter speech-models` is accepted
too. Before the paid request, the route reads OpenRouter's live speech model
list and stops if the model or voice is not on it. Voices are OpenRouter's
per-model ids. Without `--voice` the route sends the voice listed for the model
in `speech models` (`Kore` for Gemini, `sarah` for ElevenLabs); for a model with
no row it sends none and OpenRouter picks one. `--extra` takes `openrouter.speed`, `openrouter.zdr`,
and `openrouter.deny_data_collection`. Gemini models return raw PCM, which is
saved as WAV unless you ask for `--format pcm`.

### fal.ai

```bash
multix speech generate --provider fal --model elevenlabs/tts/eleven-v4 \
  --language vi --text "Xin chào" --format mp3 --output hello.mp3
multix speech generate --provider fal --text "Welcome to multix." --async
```

The route submits to the fal queue with the same input mapping as
[`multix fal tts`](/commands/fal/) and `FAL_KEY`. It accepts the fal endpoints
listed by `speech models -p fal` (Gemini 3.8 Flash and Flash-Lite TTS,
ElevenLabs v4 and v4 Turbo); voices are each endpoint's own names
(`multix fal voices`). Without `--async` it waits for the result and saves the
audio; with `--async` it prints the request id and the `multix fal result`
command that resumes it, and keeps a receipt in `~/.multix/fal/requests`
(`--output` is refused with `--async`; the resume command saves the file). A
submit whose outcome is unknown is reported, never sent again.

`--language` is sent only to models with a language field (the fal ElevenLabs
endpoints, as `language_code`); on the other OpenRouter and fal models it is
rejected rather than dropped.

`google/gemini-3.8-flash-tts` is served by both `openrouter` and `fal`, so that
model needs `--provider`. `--estimate` prices the OpenRouter route; the fal
route has no price table yet and reports `unknown`.

## Routing rules

Speech is billed differently by every provider and the voices are not
interchangeable, so routing is explicit:

- **No silent provider switching.** You choose the provider with `--provider`.
  Without it, `--model` alone is accepted only when exactly one provider serves
  that model id; the result then records `provider_inferred: true`. With
  neither, the command stops and points to `multix speech models`.
- **Fallback is opt-in.** A `--fallback` route is used only when every route
  before it cannot start because its API key is missing. That check happens
  before any paid request, and every fallback route is validated up front like
  the primary. A fallback on another provider uses its own default voice
  unless the route names one (`minimax::<voice-id>`); `--voice` is never
  carried across providers.
- **Too-long text is rejected, not cut.** Models with a documented character
  limit (`max_chars` in `speech models`) refuse longer text before any request.
- **No paid request twice.** Once a provider has been called, a failure is
  reported as is; it is never sent again on another route.
- **The switch is visible.** When a fallback is taken, a warning on stderr
  names both routes, the missing key, the voice change, the new provider's
  billing, and any format change; with `--json` the same details are in
  `data.fallback`.

```bash
multix speech generate --provider elevenlabs --model eleven_v3 --language vi \
  --text "Xin chào" --fallback openai:gpt-4o-mini-tts:nova --output hello.mp3
```

## Agent mode

The global `--json` and `--dry-run` flags work as on every command
([For AI agents](/reference/for-ai-agents/)).

- `--dry-run` validates the request, resolves the route, and shows the first
  provider request instead of sending it. Atlas Cloud reads the model's
  input schema first, so its dry run shows that lookup, not the submit. The
  OpenRouter route skips its live model check on a dry run and shows the
  speech request; the fal route shows the queue submit.
- With `--json`, `data` holds a `multix.speech.result/v1` object: `request`
  (schema `multix.speech.request/v1`; the text is recorded only as
  `text_chars` and `text_sha256`; a dry run's `request.body` still shows it), `route` (provider, model,
  voice, format), `fallback` when one was taken, and the files or async `job`.
- `multix models --task speech` lists `multix speech generate` beside the
  provider commands.

```bash
multix speech models --language vi --json
multix speech generate --provider gemini --language vi --text-file scene.txt \
  --speaker "Lan:Kore" --speaker "Minh:Puck" --output scene.wav --dry-run --json
```

## Remote MCP server

On the [remote MCP server](/guides/mcp-server/), `speech generate` requires
`--provider`, and the job receives only the keys of the providers named by
`--provider` and `--fallback`. Pass `--text-file` as an `https://` URL in
`inputs`. `speech models --ready` is not available remotely; `multix_catalog`
reports which provider keys you saved.
