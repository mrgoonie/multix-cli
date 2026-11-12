---
name: 3d-generation
description: Generate 3D models with multix through WaveSpeedAI Seed3D/Tripo/Hunyuan/Meshy, fal.ai Hi3D/Tripo/Hunyuan/Meshy, BytePlus and Atlas Cloud. Use when the user asks for a 3D model, mesh or asset from views or a description.
version: 1.28.0 # x-release-please-version
license: MIT
metadata:
  tasks: 3d
---

# multix 3D generation

Check verified model capabilities before picking a model: `multix models --task 3d --ready` lists each command with its default model and whether its key is set, and `multix models --model <id>` shows a verified model's inputs and example. The capability registry is authoritative; do not rely on a static model list. Agent protocol, keys and output dir: [../SKILL.md](../SKILL.md). Atlas Cloud 3D (`multix atlas 3d`) and its async/resume rules are in [../SKILL.md](../SKILL.md#atlas-cloud).

## When to use

- Generate 3D models through WaveSpeedAI, fal.ai, Atlas Cloud and BytePlus

## BytePlus Hyper3D / Hitem3d

```bash
multix byteplus 3d --input-image ./front.png ./side.png --prompt "Generate from these views"
```

The default model is set by `BYTEPLUS_3D_MODEL` (see the environment table in [../SKILL.md](../SKILL.md#environment-variables-selected)).

## WaveSpeedAI và fal.ai (3D)

Thiết lập `WAVESPEED_API_KEY` hoặc `FAL_KEY` rồi chạy `multix check`. Chọn model theo tác vụ với `multix models --task 3d --ready`.

```bash
multix wavespeed models
multix wavespeed 3d --ref ./object.png --model bytedance/seed3d-2.0/image-to-3d
multix wavespeed 3d --ref ./front.png --ref ./side.png --model tripo3d/h3.1/multiview-to-3d
multix wavespeed 3d --ref ./object.png --model meshy/v7.1/image-to-3d --detach
multix wavespeed status PREDICTION_ID --wait
multix fal 3d --ref ./object.png --model hitem3d/hi3d/v3.0/image-to-3d --input '{"resolution":"2048quality"}'
multix fal 3d --ref ./object.png --model fal-ai/hunyuan-3d/v3.1/pro/image-to-3d
```

Tripo multiview cần 2–4 ảnh (mặt trước trước); Meshy multi-image cho phép 1–4 ảnh. Hi3D v2.1 được chọn bằng `--model hitem3d/hi3d/image-to-3d --input '{"model":"hitem3dv2.1","resolution":"1536pro"}'`. Các tùy chọn PBR/texture/geometry truyền qua JSON `--input` theo schema của model.

Không tự động gọi lại POST tạo job có tính phí khi phản hồi không rõ trạng thái; tiếp tục bằng `wavespeed status` hoặc `fal status`/`fal result`. Giá theo đơn vị không được coi là giá phải trả cuối cùng cho mỗi lượt.
