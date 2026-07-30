---
title: Provider khác
description: Lệnh tham chiếu cho MiniMax, OpenRouter, Leonardo, BytePlus và ElevenLabs.
---

## MiniMax

```bash
multix minimax generate --prompt "A cat in space" --model image-01 --aspect-ratio 1:1
multix minimax i2i --prompt "the same character on a beach" --ref ./hero.jpg
multix minimax generate-video --prompt "A dancer" --duration 6 --resolution 1080P
multix minimax generate-speech --text "Hello" --voice <id> --output-format mp3
multix minimax generate-music --prompt "dreamy synthwave" --output-format mp3
```

`i2i` của MiniMax giữ chủ thể trong scene mới, không phải API chỉnh ảnh tự do.

## OpenRouter

```bash
multix openrouter generate --prompt "Retro robot" --model google/gemini-3.1-flash-image-preview
multix openrouter i2i --prompt "make it cyberpunk" --ref ./photo.jpg --strength 0.7
multix openrouter i2v --prompt "camera pans left" --image-url https://example.com/photo.jpg
multix openrouter video-status <jobId> --download
multix openrouter video-models
```

Video input là URL. `OPENROUTER_FALLBACK_MODELS` áp dụng cho generate và i2i.

## Leonardo

```bash
multix leonardo me
multix leonardo models --limit 20
multix leonardo video-models
multix leonardo generate "a cyberpunk cat" --output ./cat.png
multix leonardo image-to-image --prompt "make it watercolor" --ref <imageId>
multix leonardo video "a dancer" --model MOTION2
multix leonardo image-to-video <imageId> --prompt "camera pans left"
multix leonardo upscale <imageId>
multix leonardo variation <variationId>
multix leonardo status <generationId>
```

Leonardo image-to-image cần image ID đã có trên Leonardo, không nhận local file.

## BytePlus

```bash
multix byteplus generate --prompt "Studio product photo" --size 2K --aspect-ratio 16:9
multix byteplus image-to-image --prompt "make it cyberpunk" --ref ./photo.jpg
multix byteplus video --prompt "Ocean waves" --resolution 1080p --duration 8
multix byteplus image-to-video ./photo.jpg --prompt "camera pans left"
multix byteplus reference-to-video --prompt "A product reveal" --ref-image ./hero.jpg:subject
multix byteplus generate-3d --input-image ./front.png ./side.png --prompt "Generate a 3D asset"
multix byteplus status <taskId> --wait --download
```

## ElevenLabs

```bash
multix elevenlabs voices list
multix elevenlabs voices get <voiceId>
multix elevenlabs voices search --search "warm narrator"
multix elevenlabs voices design --description "friendly narrator" --auto-text
multix elevenlabs voices create-from-preview --generated-voice-id <id> --name "Narrator" --description "Friendly voice"
multix elevenlabs voices delete <voiceId>
multix elevenlabs tts --text "Welcome" --voice <voiceId>
multix elevenlabs clone --name "My Voice" --files sample1.wav sample2.wav
multix elevenlabs transcribe --input audio.mp3 --diarize --format srt
multix elevenlabs voice-changer --input source.wav --voice <voiceId>
multix elevenlabs music --prompt "dreamy synthwave loop"
multix elevenlabs sfx --text "car engine starting" --duration-seconds 5
multix elevenlabs dub --input video.mp4 --target-lang es --async
multix elevenlabs dub-status <dubbingId> --download es
multix elevenlabs isolate --input noisy.wav
multix elevenlabs align --input narration.mp3 --text "Transcript"
multix elevenlabs account
multix elevenlabs models
```

Các alias như `i2i`, `i2v`, và `3d` được hỗ trợ ở nơi CLI có khai báo. Dùng
`--help` cho đúng lệnh để xem toàn bộ option và default hiện tại.
