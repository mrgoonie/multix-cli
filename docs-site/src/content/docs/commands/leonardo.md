---
title: Leonardo commands
description: Generate Leonardo images and video, inspect jobs, and use existing image IDs for image workflows.
---

Leonardo commands require `LEONARDO_API_KEY`. Start with account and model
discovery when choosing IDs:

```bash
multix leonardo me
multix leonardo models --limit 20
multix leonardo video-models
```

## Images

```bash
multix leonardo generate "A cyberpunk cat" \
  --width 1024 --height 1024 --output cat.png
```

`image-to-image` (alias `i2i`) accepts an existing Leonardo image ID in
`--ref`, not a local file. Set `--image-type UPLOADED` only when that ID refers
to an uploaded Leonardo image.

```bash
multix leonardo i2i \
  --ref <imageId> --prompt "Make it watercolor" \
  --init-strength 0.5 --output watercolor.png
```

## Video and status

`video` starts text-to-video. `image-to-video` (alias `i2v`) similarly requires
an existing Leonardo image ID. Both can return a job immediately, or wait and
download with `--download` (which implies `--wait`).

```bash
multix leonardo video "A dancer in a studio" --model MOTION2
multix leonardo i2v <imageId> --prompt "Camera pans left" --download --output dancer.mp4
multix leonardo status <generationId> --download --output ./assets
```

Use `upscale <generatedImageId>` to start an upscaling variation and
`variation <variationId>` to retrieve its result.
