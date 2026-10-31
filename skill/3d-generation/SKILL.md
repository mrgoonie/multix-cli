---
name: 3d-generation
description: Generate 3D models with multix from reference images and a prompt on BytePlus Hyper3D / Hitem3d, or from text or an image through Atlas Cloud. Use when the user asks for a 3D model, mesh or asset from views or a description.
version: 1.26.0 # x-release-please-version
license: MIT
metadata:
  tasks: 3d
---

# multix 3D generation

Check verified model capabilities before picking a model: `multix models --task 3d --ready` lists each command with its default model and whether its key is set, and `multix models --model <id>` shows a verified model's inputs and example. The capability registry is authoritative; do not rely on a static model list. Agent protocol, keys and output dir: [../SKILL.md](../SKILL.md). Atlas Cloud 3D (`multix atlas 3d`) and its async/resume rules are in [../SKILL.md](../SKILL.md#atlas-cloud).

## When to use

- Generate 3D models (BytePlus Hyper3D / Hitem3d)

## BytePlus Hyper3D / Hitem3d

```bash
multix byteplus 3d --input-image ./front.png ./side.png --prompt "Generate from these views"
```

The default model is set by `BYTEPLUS_3D_MODEL` (see the environment table in [../SKILL.md](../SKILL.md#environment-variables-selected)).
