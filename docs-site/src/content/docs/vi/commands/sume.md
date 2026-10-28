---
title: Lệnh Sume
description: Tạo ảnh và video (kể cả lip-sync và phụ đề) qua Sume API chỉ với một khóa, liệt kê danh mục model và giá của Sume, xem, tiếp tục hoặc hủy job, và lấy báo giá của Sume.
---

Lệnh Sume gọi Sume API (`https://api.sume.com`) và cần `SUME_API_KEY`, tạo
trong [ứng dụng Sume](https://app.sume.com). Một khóa dùng được cho mọi model
ảnh và video trong danh mục của Sume. Danh mục, chứ không phải CLI, quyết định
có những model nào và mỗi model nhận flag nào, nên multix kiểm tra từng flag
theo dòng danh mục của model và từ chối flag không được hỗ trợ trước khi tải
lên hay tính phí bất cứ thứ gì. Không có cơ chế chuyển sang model dự phòng.

| Biến | Mục đích |
| --- | --- |
| `SUME_API_KEY` | Khóa API (bắt buộc với `image`, `video`, `status`, `cancel` và `estimate`). |
| `SUME_IMAGE_MODEL` | Model mặc định của `sume image` khi không truyền `-m`. |
| `SUME_VIDEO_MODEL` | Model mặc định của `sume video` khi không truyền `-m`. |
| `SUME_BASE_URL` | Ghi đè địa chỉ gốc của API cho mock hoặc proxy; xem [Ghi đè base URL và độ tin cậy](/vi/reference/environment/#ghi-đè-base-url-và-độ-tin-cậy). |

CLI không có model mặc định sẵn: hãy truyền `-m <id>` hoặc đặt biến
`SUME_*_MODEL` tương ứng. Các ID model trên trang này chỉ là ví dụ; chạy
`multix sume models` để xem danh sách hiện tại.

## Model

```bash
multix sume models                  # mọi model, chế độ, khoảng giá và các flag được hỗ trợ
multix sume models --kind video     # một loại: image, video, lipsync, ...
multix sume models --refresh        # đọc danh mục từ Sume ngay thay vì bản đệm
multix sume models --json           # đầy đủ các dòng, kèm nguồn danh mục và thời điểm tải
```

`sume models` đọc danh mục công khai của Sume (`GET /v1/open/catalog`). Lệnh
không cần khóa và không tốn phí. Danh mục được lưu đệm trong thư mục cache của
multix trong `MULTIX_MODELS_TTL` giây (mặc định 24 giờ). Khi không kết nối được
Sume, lệnh hiển thị bản đệm cũ tối đa 7 ngày và đánh dấu là đã cũ.

Mỗi dòng cho biết các chế độ của model, khoảng giá niêm yết theo đơn vị (mỗi
ảnh hoặc mỗi giây) và những gì model hỗ trợ: đầu vào văn bản, chỉnh sửa ảnh,
khung hình đầu và cuối, ảnh tham chiếu, âm thanh tự tạo, thời lượng, độ phân
giải và tỉ lệ khung hình. Dòng có ghi `(special route; not supported by multix)`
dùng một endpoint Sume mà multix không gọi (ví dụ route restyle); `sume video`
từ chối các model này.

## Ảnh

```bash
multix sume image "a ceramic teapot on linen, studio light" -m nano-banana-2.1 \
  [--aspect-ratio 16:9] [--resolution 2K] [--quality <q>] [--image-size 1024x1024] \
  [--num-images 2] [--output-format webp]

# Chỉnh sửa: một hoặc nhiều ảnh đầu vào (tệp cục bộ được tải lên trước)
multix sume image "make it a watercolor" -m nano-banana-2.1 --image ./photo.png

# Chờ job xong rồi tải ảnh
multix sume image "a red fox in snow" -m nano-banana-2.1 --wait [--output fox.png]
```

- `--aspect-ratio`, `--resolution`, `--quality`, `--output-format` và
  `--num-images` phải là giá trị hoặc nằm trong khoảng mà dòng của model liệt
  kê. Flag không có trong dòng bị từ chối, kèm các giá trị được chấp nhận.
- `--image` dùng được nhiều lần. Model chỉ chỉnh sửa (ví dụ model tách lớp
  ảnh) cần ít nhất một ảnh.
- `--param key=value` đặt thêm một trường request mà dòng liệt kê (dùng được
  nhiều lần; khóa có dấu chấm sẽ lồng nhau, như `captions.style=bold`). Các
  trường do multix tự đặt (`model`, `prompt`, URL media) và trường đã có flag
  riêng bị từ chối.
- Prompt dài tối đa 20000 ký tự.

## Video

```bash
# Text-to-video
multix sume video "waves at dusk, slow pan" -m veo-3.1 \
  [--duration 8] [--resolution 1080p] [--aspect-ratio 16:9] [--generate-audio | --no-generate-audio]

# Image-to-video: khung hình đầu, khung hình cuối và ảnh tham chiếu (tùy chọn)
multix sume video "the camera orbits the statue" -m seedance-2 \
  --image ./first.png [--end-image ./last.png] [--reference-image ./style.png]

# Lip-sync: khuôn mặt (ảnh hoặc video) và lời nói; --duration là độ dài âm thanh
multix sume video -m kling-avatar-2.0 --image ./face.png --audio ./speech.mp3 --duration 12

# Chờ job xong rồi tải MP4
multix sume video "a lighthouse in a storm" -m veo-3.1 --wait [--wait-timeout <ms>] [--output clip.mp4]
```

- `--duration` là số giây nguyên mà dòng liệt kê, dưới dạng tập giá trị (như
  4, 6, 8) hoặc một khoảng.
- `--image` là khung hình đầu và chỉ nhận một giá trị; `--end-image` cần có
  `--image`; `--reference-image` dùng được nhiều lần, tối đa theo giới hạn của
  dòng.
- `--video` là video nguồn (video-to-video, lip-sync từ video, phụ đề).
- `--audio` chỉ dành cho model lip-sync; các model này cần `--audio` cùng với
  `--image` hoặc `--video` và `--duration`. `--generate-audio` bị từ chối với
  chúng và với model không tự tạo âm thanh.
- Model không tạo được video chỉ từ văn bản sẽ bị từ chối khi thiếu ảnh hoặc
  video đầu vào, kèm danh sách chế độ mà model hỗ trợ.

## Job: mặc định không chờ, xem trạng thái, tiếp tục và hủy

`sume image` và `sume video` mặc định không chờ. Lệnh gửi job, ghi lại số tiền
Sume đã tạm giữ, in job ID kèm các lệnh để xem, tiếp tục và hủy job, rồi thoát:

```text
Job submitted: <job_id>
  Check:  multix sume status <job_id>
  Resume: multix sume status <job_id> --wait --download
  Cancel: multix sume cancel <job_id>
```

`--wait` thăm dò đến khi job xong và tải kết quả về (`--no-download` in URL
kết quả thay vì tải). `--output`, `--download` và `--no-download` cần `--wait`.
`--wait-timeout <ms>` giới hạn thời gian thăm dò (mặc định: ảnh 5 phút, video
và `status` 15 phút). Khi hết thời gian, lệnh in lệnh tiếp tục; job vẫn tiếp
tục chạy. Việc thăm dò tuân theo `next_poll_after_seconds` của Sume và không
bao giờ nhanh hơn 2 giây một lần.

```bash
multix sume status <job_id>                      # tóm tắt JSON một lần
multix sume status <job_id> --wait --download    # tiếp tục mà không tạo job mới
multix sume cancel <job_id>                      # hủy trước khi bắt đầu tạo
```

- `status` in job ID, trạng thái, lỗi khi job thất bại và URL kết quả đã bỏ
  phần query string có chữ ký. Lệnh không bao giờ in prompt hay đầu vào. Chỉ
  `--no-download` mới in URL có chữ ký. Tiến độ và gợi ý được ghi ra stderr,
  nên `multix sume status <job_id> | jq` đọc được kết quả.
- Job `failed` và `canceled` thoát với mã khác 0, sau khi in phần tóm tắt.
- `cancel` chỉ có tác dụng khi job còn đang xếp hàng. Khi việc tạo đã bắt đầu,
  Sume từ chối hủy và job bị tính phí khi hoàn tất; job đã xong thì không hủy
  được.

## Đầu vào

`--image`, `--end-image`, `--reference-image`, `--video` và `--audio` nhận:

- URL `https://` công khai, không chứa thông tin đăng nhập, có host không phải
  `localhost` hay địa chỉ riêng tư hoặc loopback. Sume tự tải URL này;
- tệp cục bộ, được tải lên Sume trước (tối đa 2 GiB) qua một URL tải lên dùng
  một lần và không bao giờ thấy khóa của bạn. Ảnh: `.png`, `.jpg`, `.jpeg`,
  `.webp`, `.gif`; video: `.mp4`, `.mov`, `.webm`; âm thanh: `.mp3`, `.wav`,
  `.m4a`, `.aac`, `.ogg`, `.flac`. Loại tệp phải khớp với flag.

URI `data:` bị từ chối. Mọi đầu vào được kiểm tra trước lần tải lên đầu tiên,
nên một giá trị sai sẽ báo lỗi trước khi gửi bất cứ thứ gì.

## Kết quả

- Tệp được lưu với tên `sume-<id8>-NN.<ext>` trong `MULTIX_OUTPUT_DIR` (mặc
  định `./multix-output`), trong đó `<id8>` là 8 ký tự đầu sau `job_`.
- `--output <file>` lưu một kết quả duy nhất vào đường dẫn đó (nhiều kết quả
  thành `<file>-NN.<ext>`); `--output <dir>/` lưu vào một thư mục.
- Việc tải chỉ dùng `https://`, từ chối địa chỉ riêng tư và loopback, dừng ở
  `MULTIX_MAX_DOWNLOAD_MB`, và in `multix sume status <job_id> --download` để
  thử lại khi một tệp tải thất bại.

## Chi phí, hoàn tiền và giới hạn

Sume tính phí bằng USD. Khi gửi job, Sume tạm giữ giá của job, và CLI ghi lại
số tiền đó (`usage.usd`); đây là số tiền mà biên nhận chi phí của lần chạy báo
cáo. Job thất bại hoặc bị hủy được hoàn tiền. Các khoản tạm giữ, hoàn lại, giải
phóng và số dư tài khoản không bao giờ được tính là chi tiêu.

```bash
multix sume image "a fox" -m seedream-4-5-edit --num-images 2 --estimate     # ước tính trước, không gửi gì
multix sume video "waves" -m veo-3.1 --duration 8 --max-cost 2              # từ chối khi ước tính vượt $2
multix sume estimate "waves" -m veo-3.1 --duration 8                        # báo giá của chính Sume (không tính phí)
```

- `--estimate` và `--max-cost` tính giá request từ dòng danh mục trong bản
  đệm: phương án giá khớp nhân với số đơn vị tính phí (ảnh hoặc giây), làm tròn
  lên đến cent. Mức trần được chứng minh khi biết chính xác một phương án giá
  và số đơn vị; nếu không, đó là một khoảng ước tính.
- Ước tính là không xác định (không bao giờ là $0) khi chưa có danh mục trong
  bản đệm, bản đệm cũ hơn 24 giờ, model không có trong đó, hoặc có flag không
  hợp lệ. Chạy `multix sume models --refresh` để làm mới bản đệm.
- `sume estimate` hỏi Sume báo giá (`POST /v1/open/estimate`). Báo giá được
  hiển thị nguyên như Sume trả về và không được `--max-cost` sử dụng. Media
  phải là URL `https://`.
- Giá có thể thay đổi; [bảng giá API của Sume](https://www.sume.com/pricing/api)
  là nguồn chính thức.

## Idempotency và thử lại

Mỗi lần gửi job đều kèm `Idempotency-Key` (`multix-<uuid>` trừ khi bạn truyền
`--idempotency-key <key>`). Lần gửi bị cắt do lỗi mạng, hết thời gian hoặc lỗi
5xx được thử lại tối đa hai lần với cùng khóa, nên Sume trả về job đã tạo thay
vì tính phí hai lần. Nếu vẫn chưa rõ kết quả, hoặc lần chạy bị ngắt khi đang
gửi, CLI in khóa đó: chạy lại cùng lệnh với `--idempotency-key "<key>"` để lấy
lại job, hoặc kiểm tra các job trong [ứng dụng Sume](https://app.sume.com).
Các lỗi từ chối (400, 402, 403, 409, 422) không được thử lại.

## MCP do Sume vận hành và multix

Sume vận hành máy chủ MCP riêng: `https://mcp.sume.com/mcp` (OAuth) hoặc
`https://api.sume.com/mcp` (khóa API). Dùng máy chủ này khi một MCP client cần
gọi thẳng Sume. multix là con đường qua dòng lệnh (và cho agent): CLI bổ sung
việc kiểm tra flag theo danh mục trước khi trả phí, ước tính chi phí trước và
biên nhận chi phí, thử lại idempotent, gợi ý tiếp tục và tải kết quả. Lệnh
`sume mcp` chạy cục bộ chưa được phát hành.

## Lỗi và quyền riêng tư

- 401 chỉ đến `SUME_API_KEY`, 402 chỉ đến số dư, 403
  `api_key_spend_limit_exceeded` chỉ đến hạn mức chi tiêu của khóa, và 404 chỉ
  đến model hoặc job. Lỗi 409 `idempotency_conflict` nghĩa là khóa đã được dùng
  cho một request khác; thông báo nêu tên job đó.
- Khóa API, prompt và URL có chữ ký (kết quả và tải lên) không bao giờ được ghi
  vào log.
