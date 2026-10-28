---
title: Lệnh TopView
description: TopView tạo video marketing từ link sản phẩm hoặc tư liệu của bạn, avatar nói, product avatar và ảnh sản phẩm (legacy API, credit của gói web), cùng các model video và ảnh của API Platform (số dư USD).
---

TopView có **hai API tách biệt**, mỗi API có key riêng và tiền riêng. multix
giữ chúng tách rời: mỗi lệnh chỉ dùng đúng một API, key của API này không bao
giờ được dùng thay cho API kia, và credit không bao giờ chuyển qua lại.

| API | Key | Trả bằng | Lệnh |
| --- | --- | --- | --- |
| Legacy API (`https://api.topview.ai`) | `TOPVIEW_API_KEY` **và** `TOPVIEW_UID` | Credit của gói web topview.ai | `url-to-video`, `materials-to-video`, `export`, `video-avatar`, `product-avatar`, `product-anyshoot`, `upload --api legacy` |
| API Platform (`https://platform-backend.topview.ai`) | `TOPVIEW_API_PLATFORM_KEY` | Số dư USD trả theo mức dùng, tách riêng | `generate`, `upload --api platform` |

Lấy key và UID của legacy API trong **API Settings** tại
[topview.ai](https://www.topview.ai/dashboard/home). Tạo key Platform tại
[platform.topview.ai](https://platform.topview.ai). `multix check` hiển thị cả hai.

:::caution[Thanh toán]
- Legacy API tiêu credit của gói topview.ai ("API credits are shared with the
  credits in your topview.ai web account"; không dùng được Ultra credit).
  TopView công bố quy tắc trừ điểm theo từng tác vụ nhưng không có giá USD, nên
  multix chỉ báo số credit mà tác vụ cho biết đã dùng (`costCredit`), không bao
  giờ quy ra đô la.
- API Platform trừ vào số dư USD riêng. Giá ước tính của nó "is not a cap", nên
  multix chỉ ghi `charged_usd` đã chốt khi billing ở trạng thái `CAPTURED` hoặc
  `RELEASED`. Khoản giữ `RESERVED` không phải chi tiêu.
- Không API nào cho biết trước giới hạn trên của chi phí, nên `--max-cost` từ
  chối mọi lệnh tác vụ TopView (`BUDGET_UNPROVEN`) thay vì đoán.
- Số dư còn lại không bao giờ được báo là chi tiêu.
:::

## Video marketing (legacy API)

```bash
# Từ trang sản phẩm: TopView tự đọc ảnh và nội dung
multix topview url-to-video --product-link https://shop.example.com/p/123 \
  [--product-name "Mug"] [--aspect-ratio 9:16] [--language vi] [--video-length 1] \
  [--avatar-id <id>] [--voice-id <id>] [--caption-id <id>] [--preview]

# Từ ảnh/video của bạn (được upload trước) hoặc file đã upload
multix topview materials-to-video --file ./shot1.jpg --file asset:<fileId> \
  --product-name "Mug" [--product-description "..."]

# Đã gửi với --preview? Xuất một kịch bản
multix topview export <taskId> --script-id <id>
```

- `--aspect-ratio`: `9:16` (mặc định), `3:4`, `1:1`, `4:3`, `16:9`.
- `--video-length`: `1` 30-50 s (mặc định), `2` 15-30 s, `3` 30-45 s, `4` 45-60 s.
- `--extra <json>` thêm các trường khác có trong tài liệu; trường mà một flag đã
  đặt sẽ bị từ chối thay vì bị ghi đè.
- Không có `--preview`, video đã xuất được trả về trực tiếp. Có `--preview`,
  tác vụ trả về video xem trước; `export` sẽ chờ đến khi có video đã xuất.

## Avatar và ảnh sản phẩm (legacy API)

```bash
# Avatar nói: văn bản TTS hoặc audio của bạn
multix topview video-avatar --avatar-source 1 --avatar-id <id> --tts-text "Xin chào!" --voice-id <id>
multix topview video-avatar --avatar-source 3 --avatar-id <id> --image ./face.png --audio ./vo.mp3

# Product avatar: bước 1 đặt sản phẩm vào ảnh avatar, bước 2 tạo video từ ảnh đó
multix topview product-avatar image --product ./mug.png --avatar-id <id> [--prompt "..."]
multix topview product-avatar video --image-id <imageId> --mode avatar4 --tts-text "..." --voice-id <id>

# Ảnh sản phẩm: cùng người mẫu, hoặc trong bối cảnh mới
multix topview product-anyshoot model --product ./mug.png --template-mask ./mask.png --template-id <id> [--count 4]
multix topview product-anyshoot background --product ./mug.png --mode prompt --prompt "bếp đá cẩm thạch"
```

Các option file nhận file cục bộ (upload qua URL ký sẵn của TopView) hoặc
`asset:<fileId>` từ `multix topview upload <file> --api legacy`. Không nhận URL
cho file. Chỉ upload phần mở rộng media (`png`, `jpg`, `jpeg`, `bmp`, `webp`,
`mp3`, `wav`, `m4a`, `mp4`, `avi`, `mov`).

## Model của API Platform

```bash
multix topview models            # các route đã xác minh, kèm nguồn và ngày
multix topview models --live     # đánh dấu thêm model trong index công khai mà multix chưa xác minh
multix topview generate bytedance/seedance-2.0-mini/text-to-video \
  --input '{"content":[{"type":"text","text":"sóng biển lúc hoàng hôn"}]}'
multix topview generate openai/gpt-image-2/text-to-image --input @body.json
multix topview upload ./ref.png --api platform   # in JSON của asset (reference)
```

`generate` chỉ nhận các route có trong tài liệu TopView (`topview models`). Body
là JSON gốc của model; Platform tự kiểm tra. Mỗi request gửi một
`Idempotency-Key` (key ngẫu nhiên mới, trừ khi bạn truyền `--idempotency-key`).

## Vòng đời tác vụ

Mỗi lệnh tác vụ gửi **đúng một lần**, rồi chờ (mặc định 30 phút; 15 phút với
`product-anyshoot`) và lưu kết quả thành `topview-<taskId>-NN.<ext>` trong thư
mục output.

```bash
multix topview url-to-video --product-link https://shop.example.com/p/1 --async   # in task id
multix topview status <taskId> --task m2v                  # đọc một lần, in JSON
multix topview status <taskId> --task m2v --wait           # chờ đến khi xong
multix topview status <taskId> --task m2v --download       # chờ và lưu; file đã lưu được giữ nguyên
multix topview status <predictionId> --task platform --download
```

- `--task` là một trong `m2v`, `video-avatar`, `product-avatar-image`,
  `product-avatar-video`, `anyshoot-model`, `anyshoot-background`, `platform`.
  Tác vụ export được đọc bằng `m2v`.
- `--no-download` in URL kết quả thay vì tải. URL kết quả của legacy API chỉ
  dùng được trong 7 ngày.
- Khi việc chờ dừng lại (hết giờ hoặc Ctrl-C), tác vụ vẫn chạy và lệnh in ra
  câu `status ... --download` để tiếp tục.
- Khi chờ, lỗi mạng, 5xx, mã "busy" của TopView và 429 (tôn trọng `Retry-After`)
  được thử lại.
- Lệnh gửi không bao giờ được thử lại. Khi không rõ kết quả (mất kết nối sau khi
  gửi, lỗi gateway, hết giờ), lệnh báo `UNKNOWN_REMOTE_STATE`. Hãy kiểm tra danh
  sách tác vụ trước khi gửi lại. Với Platform, gửi lại cùng input với
  `--idempotency-key` mà thông báo lỗi nêu để nhận lại đúng tác vụ cũ thay vì
  tạo tác vụ thứ hai.
- TopView không có endpoint hủy trên cả hai API, nên không có lệnh `cancel`.
- Tác vụ thất bại thoát với mã khác 0 kèm lý do của TopView. Từ chối vì thiếu
  credit (mã legacy 4100, Platform HTTP 402) là `QUOTA_EXCEEDED`; sai key hoặc
  UID là `INVALID_KEY`.

## Biến môi trường

| Biến | Dùng cho |
| --- | --- |
| `TOPVIEW_API_KEY` | Key legacy API (credit gói topview.ai) |
| `TOPVIEW_UID` | User id của legacy API, gửi dưới dạng `Topview-Uid` cùng key |
| `TOPVIEW_API_PLATFORM_KEY` | Key API Platform (số dư USD riêng) |
| `TOPVIEW_BASE_URL` | Ghi đè base legacy API cho proxy/test (mặc định `https://api.topview.ai`) |
| `TOPVIEW_PLATFORM_BASE_URL` | Ghi đè base Platform (mặc định `https://platform-backend.topview.ai`) |

URL ghi đè phải là `https://` (chỉ cho phép `http://` trên localhost).
