---
title: Lệnh Runway
description: Tạo video Gen-4.5 và ảnh Gen-4 bằng Runway API, kiểm tra, tiếp tục hoặc hủy task theo ID.
---

Lệnh Runway gọi Runway Dev API (`https://api.dev.runwayml.com`) và cần
`RUNWAYML_API_SECRET`, tạo tại [dev.runwayml.com](https://dev.runwayml.com/).
Runway tính phí bằng credit ($0.01 mỗi credit).

Chỉ hỗ trợ các model Gen-4 của chính Runway. Model ID không xác định bị từ
chối trước khi gửi bất kỳ request tính phí nào. `multix runway models` liệt kê
các model, tỉ lệ khung hình, thời lượng và giới hạn ảnh tham chiếu được hỗ
trợ mà không gọi API và không cần key:

```bash
multix runway models          # hoặc --json
```

| Lệnh | Model mặc định | Ghi đè |
| --- | --- | --- |
| `video` | `gen4.5` (text-to-video, hoặc image-to-video khi có `--image`); `gen4_turbo` chỉ hỗ trợ image-to-video | `-m` hoặc `RUNWAY_VIDEO_MODEL` |
| `image` | `gen4_image` (0–3 ảnh tham chiếu); `gen4_image_turbo` cần 1–3 ảnh tham chiếu | `-m` hoặc `RUNWAY_IMAGE_MODEL` |

## Video

```bash
# Text-to-video (gen4.5)
multix runway video "a slow dolly shot through a neon market at night"

# Image-to-video: ảnh được dùng làm khung hình đầu tiên
multix runway video "the camera pushes in" --image ./frame.png --ratio 960:960

multix runway video "<prompt>" [-m gen4.5|gen4_turbo] [--image <path|url>] \
  [--duration 5] [--ratio 1280:720] [--seed <n>] \
  [--public-figure-threshold auto|low] [--wait] [--no-download] [--json]
```

- Text-to-video nhận `1280:720` và `720:1280`. Image-to-video nhận thêm
  `1104:832`, `832:1104`, `960:960` và `1584:672`.
- `--duration` là số giây nguyên từ 2 đến 10 (mặc định 5).
- Prompt là bắt buộc, trừ khi dùng image-to-video với `gen4_turbo`.

Video được tính phí theo giây, nên `runway video` mặc định không chờ. Lệnh gửi
task rồi in ID của task cùng các lệnh để kiểm tra, tiếp tục và hủy task đó.
`--wait` (hoặc `--download`) poll đến khi task kết thúc rồi lưu video.

## Ảnh

```bash
multix runway image "a ceramic teapot on a linen tablecloth" --ratio 1024:1024

# Ảnh tham chiếu: tag=path cho phép prompt nhắc đến ảnh bằng @tag
multix runway image "@hero standing in @place at golden hour" \
  --ref hero=./person.png --ref place=https://example.com/street.jpg

multix runway image "<prompt>" [-m gen4_image|gen4_image_turbo] [--ratio 1280:720] \
  [--ref [tag=]<path|url>]... [--seed <n>] [--public-figure-threshold auto|low] \
  [--async] [--image-format webp|original] [--no-webp] [--output <path>] [--json]
```

- `--ref` lặp lại tối đa ba lần. Tag dài 3–16 ký tự gồm chữ cái, chữ số hoặc
  dấu gạch dưới, và bắt đầu bằng chữ cái.
- `--ratio` nhận 16 kích thước output do `multix runway models` liệt kê.
- Lệnh ảnh mặc định chờ và tải file; `--async` chỉ gửi task và in task ID.
- Ảnh đã lưu được chuyển sang WebP giống các lệnh ảnh khác.
  `--image-format original`, `--no-webp`, `MULTIX_IMAGE_FORMAT=original` hoặc
  `--output` với phần mở rộng khác `.webp` giữ nguyên định dạng của Runway.

## Ảnh đầu vào

`--image` và `--ref` nhận file cục bộ, URL `https://`, data URI `data:`, hoặc
URI `runway://` từ một lần tải lên trước đó.

- File JPEG, PNG hoặc WebP cục bộ được gửi inline khi data URI không quá
  5 MB. File lớn hơn, tối đa 200 MB, được tải lên bộ nhớ tạm của Runway, nơi
  file được giữ trong 24 giờ.
- URL phải dùng `https://` với tên miền công khai (không phải địa chỉ IP hay
  host cục bộ) và dài tối đa 2048 ký tự, vì Runway tự tải các URL này.
  `http://` bị từ chối.

## Task: trạng thái, tiếp tục và hủy

```bash
multix runway video "a slow pan over mountains"
# Task submitted: <id>
#   Estimated cost: up to … credits (≈ $…); the final billed amount may be lower

multix runway status <id>                      # xem trạng thái một lần (JSON)
multix runway status <id> --wait --download    # tiếp tục mà không trả phí lần nữa
multix runway status <id> --download           # tải lại task đã xong bằng URL mới
multix runway cancel <id>                      # chỉ với task đang chờ hoặc đang chạy
multix runway cancel <id> --delete             # xóa luôn task đã xong và output của nó
```

- Khi tạo task, CLI in chi phí tối đa ước tính của Runway; khi tải xong, CLI
  in số credit đã bị tính.
- CLI chờ ít nhất 5 giây giữa các lần poll, theo yêu cầu của Runway.
  `--wait-timeout <ms>` giới hạn thời gian poll (mặc định: video và status
  15 phút, image 5 phút). Khi hết giờ, CLI in lệnh để tiếp tục; task vẫn chạy.
- Task `FAILED` và `CANCELLED` thoát với mã khác 0 kèm lý do lỗi từ Runway.
  Lệnh `status` xem một lần với task đang chạy thoát với mã 0.
- `cancel` từ chối task đã kết thúc trừ khi bạn truyền `--delete`, vì cùng một
  endpoint của Runway sẽ xóa task đã kết thúc và output của nó. Runway không có
  endpoint chỉ để hủy, nên task nào kết thúc đúng vào khoảng giữa lúc kiểm tra
  trạng thái và lúc gửi lệnh hủy cũng sẽ bị xóa.
- Nếu việc chờ thất bại vì bất kỳ lý do gì sau khi task đã được tạo, thông báo
  lỗi nêu ID task và lệnh tiếp tục, nên bạn không cần gửi lại task.
- Request tạo task chỉ được thử lại khi gặp 429. Nếu việc gửi task gặp lỗi
  mạng, hết thời gian chờ, lỗi 5xx hoặc response không đọc được, task vẫn có
  thể đã được tạo và bị tính phí (Runway không có idempotency key), nên hãy
  kiểm tra [developer portal](https://dev.runwayml.com/) trước khi thử lại.

## Kết quả

- File được lưu dạng `runway-<id8>-NN.<ext>` trong `MULTIX_OUTPUT_DIR` (mặc
  định `./multix-output`). `--output <file>` lưu một output vào đúng đường dẫn
  đó; `--output <dir>/` lưu vào thư mục.
- URL output được ký và hết hạn sau 24–48 giờ. Mỗi lần đọc `status` nhận URL
  mới, nên `multix runway status <id> --download` khôi phục được lượt tải thất
  bại hoặc tải muộn. `--no-download` in URL đã ký thay vì lưu file.
- Việc tải file theo cùng chính sách với các provider khác: chỉ `https://`,
  không tới địa chỉ cục bộ hay private (kiểm tra ở mọi redirect), tối đa
  `MULTIX_MAX_DOWNLOAD_MB` mỗi file, và ghi qua file `.part`. Nội dung dạng
  text, HTML và JSON bị từ chối vì là trang lỗi.
- `--json` in bản tóm tắt ra stdout (thông báo tiến trình ra stderr). URL output
  trong bản tóm tắt bị loại bỏ query string đã ký, kể cả `status --wait` không
  có `--download`; chỉ khi truyền rõ `--no-download` thì URL đã ký mới được in.
  Secret không bao giờ được ghi log.

## MCP server từ xa

Trên [MCP server từ xa](/vi/guides/mcp-server/), group `runway` dùng
`RUNWAYML_API_SECRET` đã lưu trong dashboard. `runway video --image` và
`runway image --ref` nhận file qua `inputs`; ảnh tham chiếu từ xa không thể
kèm tiền tố `tag=`. Thời lượng video bị giới hạn theo mức trần video của
server. Đặt option `wait` cho `runway video` nếu muốn job trả về video thay vì
chỉ task ID.
