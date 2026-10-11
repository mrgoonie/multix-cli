---
title: Lệnh Atlas Cloud
description: Tạo ảnh, video, âm thanh và 3D với bất kỳ model Atlas Cloud nào, kèm prediction bất đồng bộ có thể tiếp tục sau.
---

Lệnh Atlas Cloud cần `ATLASCLOUD_API_KEY` (tạo key trong
[Atlas Cloud console](https://www.atlascloud.ai/console/api-keys)). Nhóm lệnh
dùng được dưới hai tên `multix atlas` và `multix atlascloud`.

Mỗi job là một prediction bất đồng bộ. Mặc định lệnh sẽ submit, chờ tối đa
`--wait-timeout`, rồi tải kết quả về `./multix-output/`. Truyền `--async` để
submit rồi thoát ngay.

```bash
multix atlas image "a red fox in the snow"
multix atlas image "a red fox in the snow" --async
multix atlas status <predictionId> --wait --download
```

## Ảnh

```bash
multix atlas image "<prompt>" \
  [-m <model>] [--size <size>] [--aspect-ratio 1:1] [--resolution 2k] \
  [-n <count>] [--seed <n>] [--negative-prompt <text>] \
  [--output <path>] [--image-format webp|original] [--no-webp]

multix atlas image-to-image --prompt "make it dusk" --ref photo.png [--ref https://...] \
  [-m <model>] [--size <size>] [...các tùy chọn tương tự]
```

- `image` mặc định dùng `black-forest-labs/flux-schnell` (ghi đè bằng `-m` hoặc
  `ATLASCLOUD_IMAGE_MODEL`).
- `image-to-image` mặc định dùng `openai/gpt-image-1-mini/edit` (ghi đè bằng
  `ATLASCLOUD_IMAGE_EDIT_MODEL`).
- `--ref` nhận file cục bộ hoặc URL `https://`. File cục bộ được upload lên
  Atlas Cloud trước, rồi URL tạm thời nhận được sẽ được truyền cho model.

## Video

```bash
multix atlas video "<prompt>" \
  [-m <model>] [--duration <s>] [--resolution 720p] [--aspect-ratio 16:9] \
  [--negative-prompt <text>] [--seed <n>] [--wait-timeout 900000] [--no-thumb]

multix atlas image-to-video --ref first-frame.png [--prompt "slow pan"] [-m <model>] [...]
```

- `video` mặc định dùng `bytedance/seedance-v1-pro-fast/text-to-video`
  (ghi đè bằng `ATLASCLOUD_VIDEO_MODEL`).
- `image-to-video` mặc định dùng `bytedance/seedance-v1-pro-fast/image-to-video`
  (ghi đè bằng `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL`).

## Âm thanh

```bash
# Chuyển văn bản thành giọng nói
multix atlas audio "Hello from multix" [-m <model>] [--voice <id>] [--format mp3] [--language en]

# Chuyển giọng nói thành văn bản: truyền --audio; bản ghi được in ra (và lưu khi có --output)
multix atlas audio --audio meeting.mp3 [-m <model>] [--language en] [--output transcript.txt]
```

- Chuyển văn bản thành giọng nói mặc định dùng `xai/tts-v1` (ghi đè bằng
  `ATLASCLOUD_TTS_MODEL`).
- Khi có `--audio`, model mặc định là `bytedance/seed-asr-2.0`
  (ghi đè bằng `ATLASCLOUD_STT_MODEL`).
- Một số model âm thanh trả về văn bản thay vì media, ví dụ model phiên âm hay
  model viết lời bài hát. multix in kết quả văn bản ra stdout thay vì cố tải về.
  Với model nhạc trả về cả âm thanh lẫn văn bản, multix lưu file âm thanh và in
  phần văn bản.

## 3D

```bash
multix atlas 3d "a low-poly treasure chest" [-m <model>] [--format GLB] [--seed <n>]
multix atlas 3d --ref object.png [-m <model>]
```

`generate-3d` là tên thay thế. Model văn bản sang 3D mặc định là
`tencent/hunyuan3d-rapid/text-to-3d` (`ATLASCLOUD_TEXT_TO_3D_MODEL`). Khi truyền
`--ref`, model mặc định là `tencent/hunyuan3d-rapid/image-to-3d`
(`ATLASCLOUD_IMAGE_TO_3D_MODEL`). Atlas Cloud phục vụ model 3D qua endpoint ảnh,
và multix đọc đúng endpoint từ schema của từng model.

## Mọi model: `run`

```bash
multix atlas run <modelId> --input '{"prompt":"a cat"}' [--type image|video|audio]
multix atlas run <modelId> --input @input.json [--async] [--wait-timeout 600000] [--output <path>]
```

`--input` nhận JSON inline hoặc `@path/to/file.json`, dùng đúng tên field trong
tài liệu của model. multix tự thêm field `model`. Endpoint (`image`, `video` hoặc
`audio`) được lấy từ schema công khai của model. Chỉ cần truyền `--type` cho
model không có schema công khai.

## Trạng thái và tiếp tục

```bash
multix atlas status <predictionId>                       # in JSON của prediction
multix atlas status <predictionId> --wait                # poll đến khi xong
multix atlas status <predictionId> --download [--output <path>]
```

`--async` chỉ in prediction id ra stdout để script có thể lấy giá trị này. Lệnh
cũng in một lệnh tiếp tục ra stderr. Khi việc chờ bị hết thời gian, thông báo lỗi
kèm cùng lệnh tiếp tục đó. Prediction kết thúc ở trạng thái `failed` làm lệnh
thoát với mã khác 0. Atlas Cloud không có endpoint hủy, nên multix không cung cấp
lệnh hủy.

## Upload

```bash
multix atlas upload photo.png
```

Lệnh này in một URL tạm thời cho file, có thể dùng trong payload của `run`. Atlas
Cloud có thể dọn dẹp file đã upload định kỳ, nên hãy dùng URL sớm và đừng dựa vào
nó để lưu trữ.

## Kết quả

- File được lưu vào `./multix-output/` (hoặc `MULTIX_OUTPUT_DIR`) với tên
  `atlas-<8 ký tự đầu của prediction id>-NN.<ext>`.
- `--output` kết thúc bằng dấu gạch chéo, không có phần mở rộng, hoặc là thư mục
  đã tồn tại sẽ được dùng làm thư mục kết quả. Đường dẫn file được dùng nguyên
  vẹn khi chỉ có một kết quả, và làm phần gốc của tên `<name>-NN.<ext>` khi có
  nhiều kết quả.
- Ảnh được chuyển sang WebP khi đã cài `cwebp`. Truyền `--image-format original`
  hoặc `--no-webp` để giữ định dạng gốc của nhà cung cấp.
- `--no-download` in URL kết quả thay vì lưu file. Các URL này có chữ ký và chỉ
  dùng tạm, nên hãy giữ bí mật như thông tin nhạy cảm.

## Kiểm tra đầu vào

Mỗi model Atlas Cloud có bộ field đầu vào riêng. Trước khi submit, multix tải
schema công khai của model từ catalog. Sau đó multix ánh xạ từng flag vào đúng
field mà model dùng, ví dụ `size` hay `image_size`, hoặc `images[]` hay `image`.
multix cũng kiểm tra enum, khoảng giá trị và field bắt buộc. Flag không được hỗ
trợ hoặc giá trị không hợp lệ sẽ báo lỗi trước khi bị tính phí, và thông báo lỗi
liệt kê các giá trị model chấp nhận.
Dùng `--no-validate` để bỏ qua bước này, ví dụ khi không truy cập được catalog.
Nếu không tải được schema, multix cảnh báo rồi vẫn submit.

## Ghi chú

- Xác thực dùng `Authorization: Bearer <ATLASCLOUD_API_KEY>`. Base của media API
  là `https://api.atlascloud.ai/api/v1` (ghi đè bằng `ATLASCLOUD_BASE_URL`).
- Khi poll, multix tự thử lại khi bị giới hạn tốc độ (tôn trọng `Retry-After`),
  khi gặp phản hồi 5xx và lỗi mạng, cho đến khi hết `--wait-timeout`.
- multix không bao giờ ghi log API key, URL kết quả có chữ ký hay prompt. Log
  debug (`-v`) hiển thị URL kết quả đã che phần query string.
- Danh mục model kèm giá có tại
  [atlascloud.ai/models](https://www.atlascloud.ai/models).
