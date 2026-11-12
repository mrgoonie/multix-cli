---
title: WaveSpeedAI 3D
description: Tạo mô hình 3D bằng Seed3D 2.0, Tripo H3.1, Hunyuan3D Rapid và Meshy.
---

WaveSpeedAI là nhà cung cấp API tạo 3D bất đồng bộ, có Seed3D 2.0 độc lập với Atlas Cloud.

## Thiết lập

Thêm `WAVESPEED_API_KEY` vào shell hoặc `~/.multix/.env`, sau đó chạy `multix check`. Lấy khóa tại [WaveSpeedAI](https://wavespeed.ai/accesskey).

## Tạo 3D từ ảnh

```sh
multix wavespeed 3d --ref ./object.png --model bytedance/seed3d-2.0/image-to-3d
multix wavespeed 3d --ref ./object.png --model tripo3d/h3.1/image-to-3d
multix wavespeed 3d --ref ./object.png --model wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid
multix wavespeed 3d --ref ./front.png --ref ./left.png --model tripo3d/h3.1/multiview-to-3d
multix wavespeed 3d --ref ./object.png --model meshy/v7.1/image-to-3d
```

Meshy multi-image chấp nhận 1–4 ảnh; Tripo multiview yêu cầu 2–4 ảnh (ảnh mặt trước ở vị trí đầu tiên). Xem danh sách: `multix wavespeed models`.

## Tạo 3D từ mô tả

```sh
multix wavespeed 3d "a wooden chest" --model tripo3d/h3.1/text-to-3d
```

## Chế độ bất đồng bộ và tải kết quả

```sh
multix wavespeed 3d --ref ./object.png --detach
multix wavespeed status PREDICTION_ID --wait
```

Không tự động gọi lại POST khi không biết tác vụ đã được nhận hay chưa, để tránh bị tính tiền hai lần. Có thể tiếp tục truy vấn bằng `status`.

## Các model qua fal.ai

```sh
multix fal 3d --ref ./object.png --model hitem3d/hi3d/v3.0/image-to-3d --input '{"resolution":"2048quality"}'
multix fal 3d --ref ./object.png --model hitem3d/hi3d/image-to-3d --input '{"model":"hitem3dv2.1","resolution":"1536pro"}'
multix fal 3d --ref ./object.png --model fal-ai/hunyuan-3d/v3.1/pro/image-to-3d
multix fal 3d --ref ./object.png --model meshy/v7.1/image-to-3d
```

Tùy chọn nâng cao dùng JSON trong `--input` theo schema của từng model. Giá niêm yết theo đơn vị có thể khác chi phí hoàn thành thực tế.

**Tài liệu:** [WaveSpeed API upload](https://wavespeed.ai/docs/upload-files-api), [API polling](https://wavespeed.ai/docs/get-result), [fal Hi3D](https://fal.ai/models/hitem3d/hi3d/v3.0/image-to-3d/api).
