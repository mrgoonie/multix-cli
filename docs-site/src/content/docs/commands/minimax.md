---
title: MiniMax commands
description: Generate MiniMax images, Hailuo video, speech, and music.
---

MiniMax commands require `MINIMAX_API_KEY`. Check the installed CLI before
automating: `multix minimax <command> --help`.

## Images

```bash
multix minimax generate --prompt "A cat in space" --aspect-ratio 1:1 --output cat.png
```

`image-to-image` (alias `i2i`) is subject preservation, not free-form editing.
It uses one local or URL `--ref` as a character/face reference and creates the
new scene described by `--prompt`; it cannot directly alter the input image.

```bash
multix minimax i2i \
  --ref ./hero.jpg \
  --prompt "the same character walking on a neon beach" \
  --output hero-beach.png
```

## Video

`generate-video` is asynchronous; multix waits for the completed video. A
first frame, when supplied, must be an HTTP(S) URL.

```bash
multix minimax generate-video \
  --prompt "A dancer in a sunlit studio" \
  --duration 6 --resolution 1080P \
  --first-frame https://example.com/first-frame.jpg \
  --output dancer.mp4
```

## Speech and music

```bash
multix minimax generate-speech \
  --text "Welcome to multix." --voice English_expressive_narrator \
  --emotion happy --output-format mp3 --output welcome.mp3

multix minimax generate-music \
  --prompt "Dreamy synthwave instrumental" --output-format mp3 \
  --output synthwave.mp3
```

Music requires either `--lyrics` or `--prompt`; speech requires `--text` or
`--prompt`.
