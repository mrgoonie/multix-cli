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
- Mỗi `--ref` nhận một giá trị; lặp lại flag này khi cần nhiều ảnh tham chiếu
  (`--ref a.png --ref b.png`). Mỗi giá trị là file cục bộ, URL `http(s)://` hoặc
  URI `data:`. File cục bộ được upload lên Atlas Cloud trước (xem giới hạn ở mục
  [Upload](#upload)), rồi URL tạm thời nhận được sẽ được truyền cho model.

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
`audio`) được lấy từ schema công khai của model. Hãy truyền `--type` khi model
không có schema công khai, và mỗi khi dùng `--no-validate`, vì khi đó schema hoàn
toàn không được tải.

## Trạng thái và tiếp tục

```bash
multix atlas status <predictionId>                       # in JSON của prediction
multix atlas status <predictionId> --wait                # poll đến khi xong
multix atlas status <predictionId> --download [--output <path>]
```

`--async` chỉ in prediction id ra stdout để script có thể lấy giá trị này bằng
`id=$(multix atlas video "waves" --async)`. Các dòng tiến trình và lệnh tiếp tục
được in ra stderr. Khi việc chờ bị hết thời gian, dù trong lệnh tạo nội dung hay
`status --wait`, thông báo lỗi kèm cùng lệnh tiếp tục đó, có cả `--output` nếu bạn
đã truyền, để file được lưu vào đúng chỗ cũ. Prediction kết thúc ở
trạng thái `failed` làm lệnh thoát với mã khác 0. Atlas Cloud không có endpoint
hủy, nên multix không cung cấp lệnh hủy.

## Upload

```bash
multix atlas upload photo.png
```

Lệnh này chỉ in một URL tạm thời cho file ra stdout, có thể dùng trong payload
của `run`. Atlas Cloud có thể dọn dẹp file đã upload định kỳ, nên hãy dùng URL
sớm và đừng dựa vào nó để lưu trữ.

Việc upload, kể cả file cục bộ truyền qua `--ref` và `--audio`, chỉ nhận file
ảnh, video và âm thanh (ví dụ `png`, `jpg`, `webp`, `mp4`, `mov`, `mp3`, `wav`).
Mọi file khác bị từ chối trước khi gửi bất cứ thứ gì. File lớn hơn 200 MB cũng bị
từ chối; đặt `ATLASCLOUD_MAX_UPLOAD_MB` để đổi giới hạn này. File được truyền dạng
luồng, không nạp toàn bộ vào bộ nhớ.

## Kết quả

- File được lưu vào `./multix-output/` (hoặc `MULTIX_OUTPUT_DIR`) với tên
  `atlas-<prediction id>-NN.<ext>`. Id có ký tự khác chữ cái, chữ số, `_` và `-`,
  hoặc dài hơn 64 ký tự, sẽ được rút gọn và thêm một mã băm ngắn của id đầy đủ,
  nên hai prediction không bao giờ trùng tên. Mỗi kết quả của một prediction luôn có cùng
  một tên, nên khi chạy lại `multix atlas status <id> --wait --download`, các
  file đã lưu ở lần trước được giữ nguyên (ghi là "already saved", với bất kỳ
  phần mở rộng nào, ví dụ sau khi chuyển sang WebP) và chỉ những kết quả còn
  thiếu được tải. Không có file nào bị trùng lặp. File rỗng không được tính là đã lưu.
- `--output` kết thúc bằng dấu gạch chéo, không có phần mở rộng, hoặc là thư mục
  đã tồn tại sẽ được dùng làm thư mục kết quả, với cùng cách đặt tên. Đường dẫn
  file được dùng nguyên vẹn khi chỉ có một kết quả và sẽ bị ghi đè. Khi có nhiều
  kết quả, đường dẫn file là phần gốc của tên `<name>-NN.<ext>`; các tên này
  không bao giờ ghi đè file đã có (với bất kỳ phần mở rộng nào): multix thêm
  `-1`, `-2`, ... vào tên.
- URL kết quả đến từ phản hồi của API, nên multix kiểm tra trước khi tải: chỉ tải
  URL `https://`, và từ chối `localhost` hoặc địa chỉ IP loopback, private,
  link-local hay địa chỉ dùng cho mục đích đặc biệt khác. Mọi lần redirect đều
  được kiểm tra như vậy, nên lượt tải không thể bị chuyển hướng sang `http://`
  hay sang địa chỉ nội bộ. Tên miền không được phân giải. Kết quả `data:` nhúng
  sẵn vẫn được lưu.
- Mỗi file tải về bị giới hạn 2048 MB; đặt `MULTIX_MAX_DOWNLOAD_MB` để thay đổi
  giới hạn. Lượt tải lớn hơn sẽ bị dừng và file tạm bị xóa.
- Thumbnail của video chỉ được lưu khi phần kết quả (outputs) của prediction có
  thumbnail. Các phần khác của payload, vốn có thể lặp lại đầu vào của bạn như
  ảnh tham chiếu, bị bỏ qua. Việc tải thumbnail tuân theo cùng quy tắc như kết
  quả. Truyền `--no-thumb` để bỏ qua.
- URL kết quả không có phần mở rộng sẽ được đặt tên theo `Content-Type` của lần
  tải, nên job tiếp tục sau cũng có cùng tên, kể cả đuôi `.mp4` hay `.png`, như
  job chờ trực tiếp.
- Mỗi file được tải vào một file tạm `.part` rồi đổi tên khi hoàn tất, nên lần tải
  thất bại không bao giờ ghi đè hay xóa file đã có. File `.part` cũng giữ chỗ
  cho tên: lần chạy thứ hai gặp cùng kết quả trong lúc đang tải sẽ dừng với lỗi
  thay vì ghi file hai lần. File khóa `.part` ghi lại tiến trình đang giữ nó. Nếu
  tiến trình đó không còn chạy (Ctrl+C, đóng terminal, bị crash), lần chạy sau sẽ
  tiếp quản tên đó và xóa các file tải dở nó để lại, nên chỉ cần chạy lại. Khi
  nhấn Ctrl+C, multix cũng xóa các file `.part` của chính nó trước khi thoát.
- URL kết quả có phần mở rộng không phải loại media đã biết (ví dụ `.php`) sẽ được
  đặt tên theo `Content-Type` của lần tải.
- Nếu một số kết quả tải thất bại, multix liệt kê các file đã lưu, in lệnh tiếp
  tục và thoát với mã khác 0.
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
Nếu không tải được schema trong 15 giây, multix cảnh báo rồi vẫn submit, dùng tên
field và kiểu dữ liệu thông thường của từng flag (ví dụ `image` là một chuỗi, còn
`seed` và `duration` là số).

## Ghi chú

- Xác thực dùng `Authorization: Bearer <ATLASCLOUD_API_KEY>`. Base của media API
  là `https://api.atlascloud.ai/api/v1` (ghi đè bằng `ATLASCLOUD_BASE_URL`).
  Giá trị ghi đè phải dùng `https://`, vì API key được gửi kèm mọi request.
  `http://` thường chỉ được chấp nhận cho `localhost`, `127.0.0.1` và `[::1]`,
  dành cho mock server cục bộ.
- Khi poll, multix tự thử lại khi bị giới hạn tốc độ (tôn trọng `Retry-After`),
  khi gặp phản hồi 408, 5xx và lỗi mạng, cho đến khi hết `--wait-timeout`. Mỗi request
  poll chỉ được dùng phần thời gian còn lại. Atlas báo một số job thất bại bằng
  HTTP 5xx có body chứa `data.status: "failed"`; chỉ dạng này mới kết thúc việc
  poll như một lỗi.
- multix không bao giờ ghi log API key, URL kết quả có chữ ký hay prompt. Log
  debug (`-v`) hiển thị URL kết quả đã che phần query string.
- Danh mục model kèm giá có tại
  [atlascloud.ai/models](https://www.atlascloud.ai/models).
