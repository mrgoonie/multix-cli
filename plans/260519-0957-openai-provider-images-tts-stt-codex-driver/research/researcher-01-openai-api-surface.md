# Researcher 01: OpenAI API Surface

## Scope

Investigate current OpenAI API fit for `multix openai`: image generate/edit, TTS, STT, diarization.

## Findings

- Image API is best fit for one prompt -> one image generation/edit command. Official guide says Image API has generations and edits endpoints; Responses API is for conversational/multi-step image flows.
- `gpt-image-2` is current GPT Image model for generation/editing and supports text input plus image input/output. Plan should use it as default while keeping env override.
- GPT image models return base64 image data by default; URL output is not the stable path for GPT image models. Save `b64_json` bytes directly.
- TTS endpoint uses `gpt-4o-mini-tts` as newest/reliable TTS model. Voices list includes 13 voices; docs recommend `marin` or `cedar` for best quality.
- STT model compatibility matters:
  - `gpt-4o-transcribe`: API `response_format=json` only. CLI `--format text` can post-process JSON `.text`.
  - `gpt-4o-mini-transcribe`: API `response_format=json` only. CLI `--format text` can post-process JSON `.text`.
  - `gpt-4o-transcribe-diarize`: `json`, `text`, `diarized_json`
  - `whisper-1`: legacy broader formats such as `srt`, `vtt`, `verbose_json`
- Diarization requires `chunking_strategy` for audio longer than 30s; use `auto` when diarized model is selected and user did not specify one.
- Known speaker diarization requires paired `known_speaker_names[]` and `known_speaker_references[]` data URLs, max 4 speakers.

## Recommended Contract

- Image default: `OPENAI_IMAGE_MODEL ?? gpt-image-2`
- TTS default: `OPENAI_TTS_MODEL ?? gpt-4o-mini-tts`
- STT default: `OPENAI_STT_MODEL ?? gpt-4o-transcribe`
- Diarization opt-in only via model/format.
- Separate CLI output format from API `response_format` for transcription. Do not send unsupported API response formats.
- Do not implement streaming, Realtime, or Responses API in this pass.

## Sources

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/docs/models/gpt-image-2
- https://developers.openai.com/api/reference/resources/images
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create

## Unresolved Questions

None. User approved image-to-image, diarization recommendation, and release.
