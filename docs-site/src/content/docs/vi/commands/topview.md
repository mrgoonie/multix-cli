---
title: Lệnh TopView
description: Tạo video marketing sản phẩm, avatar biết nói, video product avatar và ảnh sản phẩm bằng TopView Legacy API, đồng thời chạy các model của API Platform như Seedance, Wan và GPT Image 2.
---

TopView có hai API riêng biệt và multix hỗ trợ cả hai. Mỗi API dùng key và số
dư riêng; key của API này không dùng được cho API kia.

| | Legacy API | API Platform |
| --- | --- | --- |
| Host | `https://api.topview.ai` | `https://platform-backend.topview.ai` |
| Thông tin xác thực | `TOPVIEW_API_KEY` và `TOPVIEW_UID`, cả hai nằm trong mục API Settings tại [topview.ai/api-settings](https://www.topview.ai/api-settings) | `TOPVIEW_PLATFORM_API_KEY`, tạo trong mục API keys tại [platform.topview.ai](https://platform.topview.ai) |
| Tính phí | Credit của gói topview.ai | Số dư USD riêng |
| Lệnh | `url-to-video`, `materials-to-video`, `m2v-export`, `video-avatar`, `product-avatar`, `product-anyshoot`, `status`, `upload`, `credit` | `models`, `run`, `prediction` |

`TOPVIEW_BASE_URL` và `TOPVIEW_PLATFORM_BASE_URL` ghi đè địa chỉ gốc của API
để dùng với mock hoặc proxy. Chúng tuân theo cùng quy tắc tin cậy như các
thiết lập `*_BASE_URL` khác; xem
[Ghi đè base URL và độ tin cậy](/vi/reference/environment/#ghi-đè-base-url-và-độ-tin-cậy).

Cả hai API đều không có endpoint hủy, nên không có lệnh `topview cancel`. Task
đã gửi sẽ chạy đến khi xong và bị tính phí.

multix chỉ dùng các endpoint có trong tài liệu tham chiếu API của TopView.
Trang marketing của TopView còn nhắc đến `/v1/url2video`,
`/v1/materials2video`, `/v1/product_avatar/task/submit` và
`/v1/product_anyshoot/task/submit`. Các endpoint này không có trong tài liệu
tham chiếu API nên multix không bao giờ gọi chúng.

## Legacy API

### Video marketing từ URL sản phẩm hoặc tư liệu

```bash
# TopView tự đọc trang sản phẩm
multix topview url-to-video https://shop.example.com/p/mug \
  [--aspect-ratio 9:16] [--language en] [--video-length-type 1] \
  [--avatar-id <id>] [--voice-id <id>] [--caption-id <id>] \
  [--logo ./logo.png] [--music ./music.mp3] [--target-audience "..."]

# Từ ảnh và video của bạn (--file có thể lặp lại)
multix topview materials-to-video --file ./front.jpg --file ./demo.mp4 \
  --product-name "Cốc gốm" --product-description "Tráng men thủ công, 350 ml"
```

- `--aspect-ratio` là một trong `9:16` (mặc định), `3:4`, `1:1`, `4:3`,
  `16:9`.
- `--video-length-type` là `1` (30 đến 50 giây, mặc định), `2` (15 đến 30
  giây), `3` (30 đến 45 giây) hoặc `4` (45 đến 60 giây).
- `--product-name` và `--product-description` là tùy chọn với
  `url-to-video`. `materials-to-video` bắt buộc cả hai.
- `--preview` yêu cầu TopView tạo video xem trước. Xuất video bạn chọn bằng
  `multix topview m2v-export <taskId> <scriptId>`. TopView tính phí bước xuất
  (5 credit) sau khi xuất xong. Không có `--preview`, TopView trả thẳng video
  hoàn chỉnh.
- URL sản phẩm phải là `http://` hoặc `https://`. multix gửi nguyên URL và
  TopView tự tải trang đó.

### Video avatar biết nói

```bash
multix topview video-avatar --avatar-id <id> --tts-text "Chào mừng đến cửa hàng"
multix topview video-avatar --image ./face.jpg --audio ./speech.mp3
multix topview video-avatar --video ./me.mp4 --tts-text "..." --voice-id <id>
```

- Truyền đúng một nguồn avatar: `--video <file>`, `--image <file>` hoặc
  `--avatar-id <id>`. Mặc định là avatar công khai. Thêm `--custom-avatar` khi
  id là avatar tùy chỉnh của bạn.
- Truyền đúng một nguồn âm thanh: `--audio <file>`, hoặc `--tts-text <text>`
  kèm `--voice-id`. Avatar công khai (`--avatar-id`) có giọng mặc định nên
  không cần `--voice-id`. `--voice-speed` từ 0.8 đến 1.2.
- `--mode-type 0` là Avatar 1 (mặc định), `1` là Avatar 2. `--caption-id` chỉ
  áp dụng cho avatar công khai.

### Video product avatar (ba bước có tính phí)

`product-avatar` chạy chuỗi Product Avatar V3 của TopView. Mỗi bước là một task
riêng và bị tính phí riêng:

1. Xóa nền ảnh sản phẩm.
2. Ghép sản phẩm vào ảnh avatar (image replace).
3. Biến ảnh đó thành video biết nói (image to video).

```bash
multix topview product-avatar --product-image ./bottle.png \
  --avatar-id <id product avatar công khai> \
  --image-edit-prompt "Đặt chai vào tay phải của người mẫu" \
  --mode avatar4 --tts-text "Giới thiệu serum mới" --voice-id <id>
```

- Bước 2 cần đúng một avatar: `--avatar-id <id>` hoặc
  `--template-image <file>`. Chế độ mặc định `--generate-image-mode auto` bắt
  buộc có `--image-edit-prompt`. `--generate-image-mode manual` thì bắt buộc
  `--location` (xem [Vị trí đặt](#vị-trí-đặt---location)).
- Bước 3 bắt buộc `--mode avatar2|avatar4|avatar4Fast`. Với kịch bản, truyền
  `--tts-text` kèm `--voice-id`, hoặc `--audio <file>` (tối đa 28 giây với
  `avatar2`, 120 giây với các chế độ còn lại). `--caption-id` là tùy chọn.
- Lệnh luôn chờ từng bước xong rồi mới bắt đầu bước sau. `--wait-timeout` áp
  dụng riêng cho mỗi bước (mặc định 30 phút).
- Mỗi bước ghi log ID task và lệnh để tiếp tục từ bước sau. Khi có lỗi, hãy
  tiếp tục từ kết quả của bước thành công gần nhất thay vì chạy lại từ đầu:

```bash
multix topview status remove-bg <taskId> --wait          # hiện bgRemovedImageFileId
multix topview product-avatar --bg-removed-file-id <fileId> <cờ của bước 2 và 3>

multix topview status product-avatar-replace <taskId> --wait   # hiện các imageId
multix topview product-avatar --replace-image-id <imageId> <cờ của bước 3>
```

- multix không bao giờ tự gửi lại một bước. Nếu lệnh gửi thất bại theo cách mà
  task vẫn có thể đã được tạo (lỗi mạng, hết thời gian chờ, 5xx), chuỗi sẽ
  dừng. Hãy kiểm tra `multix topview credit` trước khi thử lại.
- Bước 2 có thể trả về nhiều ảnh. Với `avatar4` và `avatar4Fast`, multix dùng
  ảnh đầu tiên có khuôn mặt. Với ảnh không có khuôn mặt, TopView chỉ cho phép
  `avatar2`.

### Ảnh sản phẩm (AnyShoot)

```bash
# Người mẫu mặc hoặc cầm sản phẩm
multix topview product-anyshoot --mode try-on --product-image ./shirt.png \
  --template-id <id> --template-mask ./template-mask.png [--product-mask ./mask.png] [--count 4]

# Sản phẩm đã xóa nền đặt vào bối cảnh mới
multix topview product-anyshoot --mode background --product-image ./bottle-nobg.png \
  --prompt "trên mặt bàn đá cẩm thạch, ánh sáng buổi sáng" \
  --location "[[0.3,0.3],[0.7,0.3],[0.7,0.8],[0.3,0.8]]" [--aspect-ratio 1:1] [--similarity natural]
```

- `try-on` cần một template (`--template-id` hoặc `--template-image`) và
  `--template-mask`. `--count` từ 1 đến 4 ảnh (mặc định 1).
- `background` cần ảnh sản phẩm đã xóa nền, đúng một nguồn bối cảnh
  (`--template-id`, `--template-image` hoặc `--prompt`) và `--location`.
  `--similarity` là `natural` (mặc định) hoặc `creative`.
- `--product-file-id <fileId>` dùng lại file đã tải lên, ví dụ
  `bgRemovedImageFileId` của một task `remove-bg`.
- Cờ thuộc chế độ còn lại sẽ bị từ chối.

### Vị trí đặt (`--location`)

`--location` là mảng JSON gồm bốn điểm `[x, y]`, theo chiều kim đồng hồ bắt đầu
từ góc trên bên trái. Tọa độ được chuẩn hóa theo khung ảnh: `[0, 0]` là góc
trên bên trái và `[1, 1]` là góc dưới bên phải. Xem
[tài liệu tham số location](https://docs.topview.ai/reference/location-parameters-document-v3)
của TopView.

### Task bất đồng bộ, trạng thái và tiếp tục

Mọi lệnh Legacy trừ `product-avatar` đều trả về ngay khi task được tạo. Lệnh in
ID task cùng các lệnh để kiểm tra và tiếp tục:

```text
Task submitted: <taskId>
  Check:  multix topview status <kind> <taskId>
  Resume: multix topview status <kind> <taskId> --wait --download
  Cancel: not available (the Legacy API has no cancel endpoint; the task runs to completion and is billed)
```

`--wait` thăm dò đến khi task xong rồi tải kết quả về (`--no-download` in URL
thay vì tải). `--output`, `--download` và `--no-download` cần `--wait`.

```bash
multix topview status <kind> <taskId>                     # tóm tắt JSON một lần
multix topview status <kind> <taskId> --wait --download   # tiếp tục mà không tạo task mới
```

- Các kind gồm `m2v`, `video-avatar`, `remove-bg`, `product-avatar-replace`,
  `product-avatar-video`, `anyshoot-try-on` và `anyshoot-background`.
- `status` chỉ ghi kết quả ra stdout: bản tóm tắt JSON, hoặc danh sách file đã
  lưu khi có `--download`. Tiến độ, chi phí và gợi ý bước tiếp theo được ghi ra
  stderr. Task thất bại thoát với mã khác 0. Trạng thái không xác định được coi
  là vẫn đang chạy.
- Task được thăm dò mỗi 3 giây trở lên. Khi hết thời gian chờ, lệnh in lệnh
  tiếp tục và task vẫn chạy tiếp.

### Tải file lên và credit

```bash
multix topview upload ./product.png   # {"fileId": "...", "name": "product.png", "format": "png"}
multix topview credit                 # credit còn lại của gói và các task API gần đây (miễn phí)
```

- Task Legacy nhận file ID của TopView chứ không nhận URL, nên multix tải mọi
  cờ file lên qua quy trình tải lên bằng URL ký sẵn của TopView. URL tải lên
  phải là địa chỉ `https://` công khai. Header của TopView không bao giờ được
  gửi tới URL đó. Tải lên không bị tính phí.
- Cờ file nhận file cục bộ hoặc URL `https://` công khai. Với URL, multix tải
  về một thư mục tạm trước rồi mới tải lên. Lượt tải về này từ chối
  `localhost` và địa chỉ nội bộ ở mọi lần chuyển hướng, và dừng ở
  `MULTIX_MAX_DOWNLOAD_MB`. Định dạng được nhận: ảnh `png`, `jpg`, `jpeg`,
  `bmp`, `webp`; âm thanh `mp3`, `wav`, `m4a`; video `mp4`, `avi`, `mov`.
- `credit` hiện `remainCredit`, là số dư chứ không phải chi tiêu. Lệnh không
  hiện số dư API Platform.

## API Platform

### Model và giá

```bash
multix topview models            # các route đã xác minh kèm giá từ catalog trực tiếp
multix topview models --json
multix topview models --refresh  # tải lại catalog
```

`models` liệt kê các route dự đoán mà multix chấp nhận cho `topview run`, ghép
với catalog model công khai của TopView. Lệnh không cần key. Danh sách route
được duy trì thủ công theo tài liệu API Platform, mỗi route ghi lại URL nguồn
và ngày `verified_at`. Giá hiển thị đúng như TopView báo, bằng USD, kèm thời
điểm tải. Catalog được lưu đệm trong `~/.multix/cache/models/` (áp dụng
`MULTIX_CACHE_DIR` và `MULTIX_MODELS_TTL`). Nếu không tải được catalog, các
route vẫn được liệt kê nhưng không có giá.
[Trang giá của TopView](https://platform.topview.ai/pricing) là nguồn chính
xác nhất.

Các nhóm route đã xác minh ngày 2026-10-28:

| Model | Route | Body |
| --- | --- | --- |
| Wan 3.0 | `alibaba/wan-3.0/{image-to-video,text-to-video,reference-to-video}` | `{"input": {...}, "parameters": {...}}` |
| Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini | `bytedance/seedance-<version>/{image-to-video,text-to-video,omni-reference-to-video}` | `{"content": [...], ...}` |
| Topview T1 | `topview/topview-t1/{image-to-video,text-to-video,omni-reference-to-video}` | `{"content": [...], ...}` |
| MiniMax H3 | `minimax/minimax-h3/{image-to-video,text-to-video}` | `{"content": [...], ...}` |
| GPT Image 2 | `openai/gpt-image-2/{text-to-image,edit}` | `{"prompt": "...", ...}` |

### Chạy một dự đoán

```bash
multix topview run bytedance/seedance-2.0/text-to-video \
  --input '{"content":[{"type":"text","text":"một chiếc thuyền giấy trên phố mưa"}],"ratio":"16:9"}'

multix topview run openai/gpt-image-2/text-to-image --input @body.json --wait
```

- `--input` nhận body của request dưới dạng JSON trực tiếp hoặc `@đường-dẫn`
  tới file JSON. multix từ chối route chưa được xác minh, và body có cấu trúc
  cấp cao nhất không khớp với nhóm của route, trước khi gửi bất cứ thứ gì.
  TopView kiểm tra các trường.
- Mỗi lần gửi đều kèm `Idempotency-Key`, được tạo trước khi gửi request.
  multix dùng lại cùng key khi thử lại sau lỗi mạng, `429` hoặc `5xx` (tối đa
  hai lần, tôn trọng `Retry-After`). Nếu vẫn không rõ kết quả, hoặc lần chạy bị
  dừng (Ctrl-C, hết thời gian) khi đang gửi, multix in key đó. Hãy thử lại với
  cùng body và `--idempotency-key <key>` để nhận lại đúng dự đoán đó thay vì
  tạo dự đoán thứ hai.
- Không có `--wait`, lệnh in ID dự đoán, các lệnh để kiểm tra và tiếp tục, cùng
  idempotency key.

### Trạng thái dự đoán

```bash
multix topview prediction <id>                      # tóm tắt JSON một lần
multix topview prediction <id> --wait --download    # tiếp tục
```

- Các trạng thái là `created`, `processing`, `payment_required`, `completed`
  và `failed`. `payment_required` và `failed` thoát với mã khác 0.
- `payment_required` nghĩa là chi phí thực tế cao hơn khoản đã giữ trước. Hãy
  nạp thêm tiền vào đúng workspace đó tại
  [platform.topview.ai](https://platform.topview.ai). TopView tự thử thanh
  toán lại, nên đừng gửi lại; tiếp tục bằng `prediction <id> --wait`.
- Dự đoán được thăm dò mỗi 2 giây trở lên, có giãn cách tăng dần.

## Kết quả đầu ra

- File được lưu thành `topview-<id8>-NN.<ext>` trong `MULTIX_OUTPUT_DIR` (mặc
  định `./multix-output`). `--output <file>` lưu một kết quả vào đúng đường
  dẫn đó (nhiều kết quả thành `<file>-NN.<ext>`), còn `--output <dir>/` lưu vào
  một thư mục.
- URL kết quả của Legacy có hiệu lực 7 ngày. URL của API Platform có thể hết
  hạn sớm hơn, nên hãy tải về sớm. Ảnh đầu ra của API Platform cũng có thể là
  dữ liệu nhúng, được ghi thẳng ra file.
- Lượt tải chỉ dùng `https://`, từ chối `localhost` và địa chỉ nội bộ ở mọi lần
  chuyển hướng, và dừng ở `MULTIX_MAX_DOWNLOAD_MB`. Nếu tải thất bại, lệnh
  thoát với mã khác 0 và in cách thử lại.

## Chi phí và thử lại

- multix không ước tính chi phí TopView trước khi chạy. Sau khi chạy, multix ghi
  log số liệu TopView báo. Task Legacy báo `costCredit` theo credit của gói.
  Dự đoán API Platform báo `charged_usd` kèm `billing_state`: `RESERVED` là
  khoản giữ tạm, chưa phải chi tiêu cuối cùng; `CAPTURED` là khoản thu cuối
  cùng; `RELEASED` nghĩa là khoản giữ đã được hoàn lại.
- Lệnh gửi Legacy không có idempotency key, nên multix không bao giờ thử lại,
  kể cả khi gặp `429`. Sau `429`, lỗi mạng, hết thời gian chờ, `5xx` hoặc
  phản hồi thành công không đọc được, task vẫn có thể đã được tạo và tính phí.
  Hãy kiểm tra `multix topview credit` (các task gần đây) hoặc
  [bảng điều khiển TopView](https://www.topview.ai/dashboard/home) trước khi
  thử lại.

## Lỗi và quyền riêng tư

- Lỗi Legacy: `401` chỉ tới `TOPVIEW_API_KEY` và `TOPVIEW_UID`, `4100` là
  thiếu credit của gói (`multix topview credit`), `4007` là một task cùng loại
  trước đó vẫn đang chạy. Mã `400x` là tham số bị từ chối, mã `5xxx` là lỗi máy
  chủ TopView, còn `6001` là bị từ chối vì lý do bảo mật.
- Lỗi API Platform: `401` chỉ tới `TOPVIEW_PLATFORM_API_KEY`, `403` chỉ tới
  quyền của key (`models:generate` để gửi, `requests:read` để đọc kết quả),
  `402` là số dư của workspace. ID request của TopView được kèm theo khi TopView
  trả về.
- Key, URL ký sẵn để tải lên và tải về, prompt và body của request không bao
  giờ được ghi log. Bản tóm tắt in URL kết quả đã bỏ chuỗi truy vấn có chữ ký.
  Chỉ `--no-download` mới in URL đầy đủ.
