---
title: Output and troubleshooting
description: Verify multix prerequisites, control generated files, and diagnose common CLI failures.
---

## Verify the local setup

```bash
multix check
multix check --verbose
```

`check` validates available credentials and local media tooling. Media commands
need `ffmpeg`; commands that use ImageMagick need `magick` on your `PATH`.

## Output files

Generated files default to `./multix-output`. Set `MULTIX_OUTPUT_DIR` to change
the default, or use the command's `--output` option when available.

```bash
multix media optimize --input source.mp4 --output optimized.mp4 --target-size 100
```

## Common fixes

- **No provider available:** set at least one supported provider key and rerun
  `multix check`.
- **Media command cannot start:** install `ffmpeg`, and ImageMagick 7+ when the
  command needs it.
- **Authentication error:** confirm the key is from the intended provider and
  that the process can see it (`multix check --verbose`).
- **Generation takes time:** video and some provider operations are async; use
  the matching status command where the provider exposes one.

Use `--help` on the exact command to inspect the current flags and defaults.
