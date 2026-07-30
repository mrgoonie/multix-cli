---
title: BytePlus commands
description: Use BytePlus ModelArk for Seedream images, Seedance video, reference video, and 3D assets.
---

BytePlus commands require `BYTEPLUS_API_KEY` (or its `ARK_API_KEY` fallback).

## Seedream images

```bash
multix byteplus generate \
  --prompt "Studio product photo" --size 2K --aspect-ratio 16:9 \
  --output product.png

multix byteplus i2i \
  --prompt "Make it cyberpunk" --ref ./photo.jpg --output cyberpunk.png
```

Both image commands accept repeated local-path or URL image references where
their `--input-image` or `--ref` options are exposed.

## Seedance video

Text-to-video, image-to-video, and reference-to-video can run to completion or
submit a task with `--async`. Preserve the task ID, then use `status` to poll
or fetch the MP4.

```bash
multix byteplus video --prompt "Ocean waves" --resolution 1080p --duration 8 --async
multix byteplus i2v ./photo.jpg --prompt "Camera pans left" --async

multix byteplus r2v \
  --prompt "A product reveal" \
  --ref-image ./hero.jpg:subject \
  --ref-video ./motion.mp4:reference --async

multix byteplus status <taskId> --wait --download --output reveal.mp4
```

Reference video accepts up to nine image references, three video references,
and three audio references, with at most twelve references total. Use
`path:role` syntax and escape a literal colon as `\:`.

## 3D

```bash
multix byteplus 3d \
  --input-image ./front.png ./side.png \
  --prompt "Generate a 3D asset" --async
```

`generate-3d` (alias `3d`) accepts one to five local or URL reference images;
the command prints a task ID when submitted asynchronously.
