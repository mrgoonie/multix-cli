---
title: Lệnh ToAPIs
description: Tạo ảnh và video qua nền tảng tổng hợp ToAPIs (Seedance, Veo, Kling, Wan, gpt-image, ảnh Gemini, Seedream, Flux và nhiều model khác) bằng một khóa, xem báo giá của ToAPIs, tiếp tục tác vụ và tải lên tệp tham chiếu.
---

Các lệnh ToAPIs gọi API [ToAPIs](https://toapis.com) (`https://toapis.com`)
và cần `TOAPIS_API_KEY`, tạo trong
[bảng điều khiển ToAPIs](https://toapis.com/dashboard/tokens). Một khóa và một
số dư dùng được cho model ảnh và video của nhiều nhà cung cấp.

ToAPIs là bên bán lại (nền tảng tổng hợp), không phải nhà phát triển model.
Giá là giá riêng của ToAPIs và có thể thấp hơn nhiều so với giá niêm yết của
nhà phát triển. Các biến thể ảnh và Veo rẻ nhất (ID model có `preview`, `vip`
hoặc tên tương tự) nhiều khả năng đi qua kênh không chính thức, nên có thể kém
ổn định hoặc bị ngừng. Hãy cân nhắc điều này khi chọn model.

| Biến | Mục đích |
| --- | --- |
| `TOAPIS_API_KEY` | Khóa API (bắt buộc cho mọi lệnh trừ `quote`). |
| `TOAPIS_IMAGE_MODEL` | Model mặc định cho `toapis image` (mặc định `doubao-seedream-4-5`). |
| `TOAPIS_VIDEO_MODEL` | Model mặc định cho `toapis video` (mặc định `seedance-2-fast`). |
| `TOAPIS_BASE_URL` | Ghi đè gốc API cho mock hoặc proxy; xem [Ghi đè base URL và độ tin cậy](/vi/reference/environment/#ghi-đè-base-url-và-độ-tin-cậy). |

## Model và báo giá

```bash
multix toapis models                       # model ảnh, video và audio mà khóa này dùng được (trực tiếp)
multix toapis models --type video          # một loại: image, video, audio hoặc all
multix toapis quote -m seedance-2-fast --resolution 720p --duration 5
multix toapis quote -m gpt-image-2 --resolution 2K -n 2
```

- `models` liệt kê trực tiếp từ ToAPIs các ID model mà khóa của bạn dùng được.
  Giá có trên [trang giá ToAPIs](https://toapis.com/pricing).
- `quote` hỏi endpoint giá công khai mà trang giá dùng. Lệnh không cần khóa và
  không tính phí. Lệnh in giá niêm yết, kiểu tính phí, và tổng ước tính khi
  biết thời lượng hoặc số ảnh. Với model tính theo token, lệnh in thêm ước tính
  theo giây của ToAPIs. Endpoint này không có trong tài liệu API của ToAPIs nên
  có thể thay đổi mà không báo trước.

## Ảnh

```bash
multix toapis image "a ceramic teapot on linen, studio light" \
  [-m doubao-seedream-4-5] [--aspect-ratio 16:9] [--resolution 2K] [-n 2] [--seed 7]

# Chỉnh sửa hoặc tham chiếu: tệp cục bộ được tải lên trước
multix toapis image "make it a watercolor" -m gpt-image-2 --image ./photo.png
```

## Video

```bash
# Văn bản thành video
multix toapis video "waves at dusk, slow pan" \
  [-m seedance-2-fast] [--duration 5] [--resolution 720p] [--aspect-ratio 16:9] [--audio | --no-audio]

# Ảnh thành video: khung đầu, khung cuối tùy chọn
multix toapis video "the camera orbits the statue" --first-frame ./first.png [--last-frame ./last.png]

# Ảnh tham chiếu
multix toapis video "the product spins on a turntable" --image ./ref1.png --image ./ref2.png
```

- ToAPIs giữ nguyên tên trường của từng nhà phát triển, nên cùng một cờ sẽ vào
  trường khác nhau tùy họ model. multix tự ánh xạ `--aspect-ratio`,
  `--resolution`, `--duration`, `--audio`, `--negative` và các cờ ảnh (ví dụ
  `--resolution 1080p` thành chế độ `pro` của Kling).
- `--param key=value` gửi nguyên trạng bất kỳ trường nào khác (lặp lại được;
  khóa có dấu chấm sẽ lồng nhau, như `metadata.watermark=false`; giá trị JSON
  như số và boolean được phân tích). Cờ này áp dụng sau cùng và có thể ghi đè
  trường đã ánh xạ, trừ các trường tính giá (`model`, `prompt`, `n`,
  `duration`, `seconds`, `resolution`, `mode`, `metadata.resolution`): chúng bị
  từ chối để ước tính chi phí khớp với lần chạy, hãy dùng flag tương ứng.
- Seedance 2.x nhận khung đầu/cuối hoặc ảnh tham chiếu, không nhận cả hai
  trong một yêu cầu.
- Giá trị nào model chấp nhận (thời lượng, độ phân giải, số lượng) do ToAPIs và
  model quyết định; xem trang của model trong
  [tài liệu ToAPIs](https://docs.toapis.com).

## Tác vụ, chờ và tiếp tục

Mỗi lần tạo là một tác vụ bất đồng bộ của ToAPIs. Mặc định `image` và `video`
chờ tác vụ (`--wait-timeout`, mặc định 5 phút cho ảnh và 15 phút cho video) rồi
tải kết quả về. `--async` gửi tác vụ, in ID tác vụ rồi thoát.

```bash
multix toapis video "a lighthouse in a storm" --async
multix toapis status <taskId>                      # xem trạng thái một lần (mặc định là video)
multix toapis status <taskId> --kind image --wait  # chờ rồi tải về
```

Với tác vụ ảnh, `status` cần `--kind image`. Khi hết thời gian chờ, lệnh in
câu lệnh `status ... --wait` để tiếp tục; tác vụ vẫn chạy.

## Đầu vào và tải lên

`--image`, `--first-frame` và `--last-frame` nhận URL `http(s)://` công khai
(gửi nguyên trạng) hoặc tệp cục bộ. ToAPIs không nhận base64 hay URI `data:`,
nên tệp cục bộ được tải lên ToAPIs trước và gửi bằng URL công khai trả về.

```bash
multix toapis upload ./photo.png      # in URL công khai
```

Chỉ tệp media được tải lên: ảnh (`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, tối
đa 30 MB), video (`.mp4`, `.webm`, `.mov`, tối đa 50 MB) và audio (`.mp3`,
`.wav`, `.m4a`, tối đa 50 MB). Tệp khác bị từ chối trước khi rời máy. Ai có URL
của tệp đã tải lên đều truy cập được tệp đó.

## Kết quả

- ToAPIs giữ kết quả trong 30 ngày, nên multix tải về ngay khi tác vụ xong.
  `--no-download` in URL kết quả thay vì tải về.
- Tệp được lưu thành `toapis-<kind>-<id8>-<stamp>.<ext>` trong
  `MULTIX_OUTPUT_DIR` (mặc định `./multix-output`). `--output <file>` lưu một
  kết quả duy nhất vào đường dẫn đó; ngoài ra `--output` là thư mục.
- Lệnh in ID tác vụ và chi phí đã quyết toán.

## Chi phí

```bash
multix toapis video "waves" -m seedance-2-mini --resolution 480p --duration 4 --estimate
multix toapis image "a fox" -m gpt-image-2 --resolution 1K --max-cost 0.05
```

- `--estimate` và `--max-cost` tính giá ngoại tuyến từ giá niêm yết ToAPIs mà
  multix ghi lại kèm ngày kiểm tra
  ([`src/providers/toapis/cost.ts`](https://github.com/mrgoonie/multix-cli/blob/main/src/providers/toapis/cost.ts)).
  Model chưa có giá ghi lại là "unknown", không bao giờ là $0; hãy dùng `quote`
  cho model đó.
- Model tính theo ảnh hoặc theo giây có mức trần chắc chắn khi đã đặt độ phân
  giải, số lượng hoặc thời lượng.
- Seedance 2.x tính phí theo `usage.total_tokens` = rộng × cao × (24 × số giây
  + 1) / 1024 của video đầu ra. Một lần chạy `seedance-2-mini` 480p 4 giây bị
  tính 40.594 token, $0,076642, khớp công thức. Mức trần của nó là ước tính,
  không chắc chắn: tỷ lệ khung hình khác và video tham chiếu làm thay đổi số
  token. Không có `--resolution` thì multix gửi và tính giá ở 720p; không có `--duration` thì
  tính trong khoảng 4-15 giây.
- Biên nhận ghi khoản phí ToAPIs quyết toán (`billing.cost_usd`).
- Không có lệnh xem số dư: khóa API không đọc được số dư tài khoản. Hãy xem
  trong [bảng điều khiển ToAPIs](https://toapis.com/dashboard/tokens).

## Quyền riêng tư

Khóa API không bao giờ được ghi log, và `--verbose` ghi URL tệp đã tải lên ở
dạng đã che. `--no-download` cố ý in đầy đủ URL kết quả.
