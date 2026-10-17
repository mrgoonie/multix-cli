---
title: Lệnh Runway
description: Tạo video Gen-4.5, Gen-4 Turbo và ảnh Gen-4 qua Runway API, đồng thời xem, tiếp tục hoặc hủy task theo ID.
---

Lệnh Runway gọi Runway API (`https://api.dev.runwayml.com`, phiên bản API
`2024-11-06`) và cần `RUNWAYML_API_SECRET`, tạo trong
[cổng nhà phát triển Runway](https://dev.runwayml.com/). Chỉ dòng Gen-4 của
chính Runway được hỗ trợ. Các model khác mà Runway API cung cấp, video-to-video,
upscale và âm thanh không nằm trong phạm vi; model không xác định bị từ chối
trước khi gửi bất cứ thứ gì, và không có cơ chế chuyển sang model dự phòng.

## Model

```bash
multix runway models          # model được hỗ trợ, tỉ lệ khung, thời lượng, giới hạn ảnh tham chiếu
multix runway models --json   # cùng nội dung dưới dạng JSON
```

`runway models` đọc danh sách model có sẵn trong CLI, nên chạy được khi không
có mạng và không cần `RUNWAYML_API_SECRET`. `default` đánh dấu model được dùng
khi không truyền `-m` (`RUNWAY_VIDEO_MODEL` / `RUNWAY_IMAGE_MODEL` nếu có đặt).

## Video

```bash
# Text-to-video (Gen-4.5)
multix runway video "a lighthouse in a storm, slow push-in" \
  [-m gen4.5] [--ratio 1280:720] [--duration 5] [--seed <n>]

# Image-to-video: ảnh là khung hình đầu tiên (Gen-4.5 hoặc Gen-4 Turbo)
multix runway video "the camera orbits the statue" --image ./statue.png
multix runway video -m gen4_turbo --image https://cdn.example.com/still.jpg

# Chờ task xong rồi tải MP4
multix runway video "waves at dusk" --wait [--wait-timeout <ms>] [--output clip.mp4]
```

| Model | Chế độ | Tỉ lệ (`--ratio`, mặc định `1280:720`) | Prompt |
| --- | --- | --- | --- |
| `gen4.5` (mặc định) | text-to-video, image-to-video | text: `1280:720`, `720:1280`; image thêm `1104:832`, `832:1104`, `960:960`, `1584:672` | Bắt buộc |
| `gen4_turbo` | chỉ image-to-video | `1280:720`, `720:1280`, `1104:832`, `832:1104`, `960:960`, `1584:672` | Tùy chọn |

- `--duration` là số giây nguyên từ 2 đến 10 (mặc định 5).
- `--seed` là số nguyên từ 0 đến 4294967295.
- Prompt dài tối đa 1000 ký tự.
- Đổi model mặc định bằng `-m` hoặc `RUNWAY_VIDEO_MODEL`.

`runway video` mặc định không chờ. Lệnh in task ID kèm các lệnh để xem, tiếp
tục và hủy task, rồi thoát:

```text
Task submitted: <id>
  Check:  multix runway status <id>
  Resume: multix runway status <id> --wait --download
  Cancel: multix runway cancel <id>
```

`--wait` poll đến khi task kết thúc rồi tải video (`--no-download` in URL
output thay vì tải). `--output`, `--download` và `--no-download` cần đi kèm
`--wait`; nếu không, hãy chạy `runway status <id> --wait --download` sau.

## Ảnh

```bash
multix runway image "a ceramic teapot on a linen tablecloth, studio light" \
  [-m gen4_image] [--ratio 1920:1080] [--seed <n>] [--output <path>]

# Ảnh tham chiếu, được nhắc đến trong prompt bằng tag
multix runway image "@hero standing in @place at sunset" \
  --reference ./hero.png --reference-tag hero \
  --reference https://cdn.example.com/street.jpg --reference-tag place

# Gen-4 Image Turbo cần ít nhất một ảnh tham chiếu
multix runway image "@subject as a watercolor" -m gen4_image_turbo \
  --reference ./subject.jpg --reference-tag subject
```

| Model | Ảnh tham chiếu | Ghi đè |
| --- | --- | --- |
| `gen4_image` (mặc định) | 0 đến 3 | `-m` hoặc `RUNWAY_IMAGE_MODEL` |
| `gen4_image_turbo` | 1 đến 3 | `-m` hoặc `RUNWAY_IMAGE_MODEL` |

- `--ratio` (mặc định `1280:720`) là một trong `1024:1024`, `1080:1080`,
  `1168:880`, `1360:768`, `1440:1080`, `1080:1440`, `1808:768`, `1920:1080`,
  `1080:1920`, `2112:912`, `1280:720`, `720:1280`, `720:720`, `960:720`,
  `720:960`, `1680:720`.
- `--reference` lặp lại được tối đa ba lần. `--reference-tag` cũng lặp lại được
  và ghép với ảnh tham chiếu ở cùng vị trí; tag gồm 3 đến 16 chữ cái, chữ số
  hoặc dấu gạch dưới và bắt đầu bằng chữ cái. Nhắc đến tag trong prompt dưới
  dạng `@tag`.
- `runway image` mặc định chờ và tải file. `--async` trả về task ID ngay và
  không dùng chung được với `--output` hoặc `--download`.
- Ảnh đã lưu được chuyển sang WebP như các lệnh ảnh khác; giữ định dạng gốc
  bằng `--image-format original`, `--no-webp`, `MULTIX_IMAGE_FORMAT=original`,
  hoặc `--output` có phần mở rộng khác `.webp`.

## Task: trạng thái, tiếp tục và hủy

```bash
multix runway status <id>                      # tóm tắt JSON một lần
multix runway status <id> --wait --download    # tiếp tục mà không tạo task mới
multix runway status <id> --download --json    # tóm tắt JSON kèm đường dẫn file đã lưu
multix runway cancel <id>                      # hủy task đang chờ hoặc đang chạy
multix runway cancel <id> --delete             # xóa task đã xong cùng output của nó
```

- `status` in task ID, trạng thái, tiến độ, `estimatedCost`, `cost`, `failure`
  và `failureCode` khi có, cùng URL output đã bỏ query string đã ký. Lệnh không
  bao giờ in prompt hay input. `status --wait` không kèm `--download` in cùng
  bản tóm tắt đó khi task kết thúc; chỉ `--no-download` trên `video --wait`
  hoặc `image` mới in URL đã ký.
- `status` chỉ ghi JSON ra stdout; tiến độ, chi phí và gợi ý tiếp tục đi ra
  stderr, nên `multix runway status <id> | jq .status` dùng được cả với task
  đang chạy. Khi có `--download`, stdout liệt kê file đã lưu, trừ khi thêm
  `--json` để in bản tóm tắt kèm mảng `files`.
- Trạng thái kết thúc gồm `SUCCEEDED`, `FAILED` và `CANCELLED`. `FAILED` và
  `CANCELLED` thoát với mã khác 0; lệnh `status` xem một lần với task đang chạy
  thoát với mã 0 và in lệnh để tiếp tục.
- `cancel` từ chối task đã kết thúc trừ khi bạn truyền `--delete`, vì xóa task
  đã kết thúc cũng xóa luôn output của nó. Runway không có lệnh chỉ-hủy, nên
  task kết thúc đúng lúc giữa bước kiểm tra trạng thái và bước hủy cũng bị xóa.
- `--wait-timeout <ms>` giới hạn thời gian poll (mặc định: video và `status`
  15 phút, image 5 phút). Khi hết giờ, CLI in lệnh để tiếp tục; task vẫn chạy.
  Task được poll cách nhau ít nhất 5 giây, theo yêu cầu của Runway.

## Đầu vào

`--image` và `--reference` nhận:

- URL `https://` công khai dùng tên miền (không phải địa chỉ IP hay
  `localhost`), tối đa 2048 ký tự. Runway tự tải URL này và không theo
  redirect;
- data URI `data:image/jpeg`, `data:image/png` hoặc `data:image/webp` tối đa
  5 MB;
- URI `runway://` từ một lần tải lên trước đó;
- file cục bộ `.jpg`, `.jpeg`, `.png` hoặc `.webp`. File được gửi inline dưới
  dạng data URI khi bản mã hóa vừa trong 5 MB, nếu không sẽ được tải lên Runway
  dưới dạng upload tạm thời (hiệu lực 24 giờ, nhỏ hơn 200 MB).

GIF và các định dạng khác bị từ chối.

## Kết quả

- File được lưu dạng `runway-<id8>-NN.<ext>` trong `MULTIX_OUTPUT_DIR` (mặc
  định `./multix-output`), trong đó `<id8>` là 8 ký tự đầu của task ID.
- `--output <file>` lưu một output vào đúng đường dẫn đó (nhiều output sẽ
  thành `<file>-NN.<ext>`); `--output <dir>/` lưu vào thư mục.
- URL output của Runway hết hạn trong vòng 24 đến 48 giờ, nên hãy tải sớm.
- Chỉ tải qua `https://`, từ chối `localhost` và địa chỉ private hoặc loopback
  (mọi redirect cũng được kiểm tra), dừng ở `MULTIX_MAX_DOWNLOAD_MB` (mặc định
  2048 MB), và ghi vào file `.part` rồi mới đổi tên khi tải xong.
- Nếu có output nào tải về thất bại, các file đã tải được vẫn được giữ, nhưng
  lệnh thoát với mã khác 0 và in `multix runway status <id> --download` để thử
  lại khi URL còn hiệu lực.

## Chi phí và thử lại

Runway tính phí theo credit (1 credit = 0,01 USD). Trước khi gửi, CLI ghi log
ước tính theo giá niêm yết để tham khảo: Gen-4.5 12 credit mỗi giây, Gen-4 Turbo
5 credit mỗi giây, Gen-4 Image từ 5 credit, Gen-4 Image Turbo 2 credit. Giá có
thể thay đổi; [trang giá của Runway](https://docs.dev.runwayml.com/guides/pricing/)
là nguồn chính xác. Sau khi task được tạo, CLI ghi log `estimatedCost` do
chính Runway trả về, và khi task kết thúc thì ghi `cost` thực tế bị tính.

Việc tạo task chỉ được thử lại khi gặp `429` (giới hạn tốc độ), lúc chưa có gì
được tạo. Nếu việc tạo task gặp lỗi mạng, hết thời gian chờ, lỗi 5xx hoặc
response thành công nhưng không đọc được, task vẫn có thể đã được tạo và bị
tính phí. Runway không có idempotency key, nên hãy kiểm tra task và mức sử dụng
trong [cổng nhà phát triển](https://dev.runwayml.com/) trước khi thử lại.

## Lỗi và quyền riêng tư

- Lỗi 401 chỉ ra vấn đề ở `RUNWAYML_API_SECRET`, 402 là thiếu credit, và 404
  chỉ ra model hoặc task (có thể thuộc tổ chức khác, hoặc đã bị hủy hay xóa).
- API secret không bao giờ được ghi log, và log không bao giờ chứa URL output
  đã ký.
- `RUNWAY_BASE_URL` ghi đè API root cho mock hoặc proxy và tuân theo cùng quy
  tắc tin cậy như các thiết lập `*_BASE_URL` khác; xem
  [Ghi đè base URL và độ tin cậy](/vi/reference/environment/#ghi-đè-base-url-và-độ-tin-cậy).
