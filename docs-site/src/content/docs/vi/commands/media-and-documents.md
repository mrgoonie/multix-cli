---
title: Media và tài liệu
description: Tối ưu, kiểm tra và xác minh media bằng tool local, chuyển tài liệu sang Markdown với Gemini.
---

## Điều kiện tiên quyết

Lệnh media chạy executable local: `ffmpeg` xử lý audio/video, còn lệnh
`magick` của ImageMagick 7 xử lý ảnh. Cài cả hai trước khi chạy `multix media`.

### macOS (Homebrew)

```bash
brew install ffmpeg imagemagick
```

### Ubuntu hoặc Debian

```bash
sudo apt update
sudo apt install -y ffmpeg imagemagick
```

Một số distro Linux đóng gói ImageMagick 6, chỉ có `convert` thay vì executable
`magick` bắt buộc. Nếu bước kiểm tra bên dưới không tìm thấy `magick`, hãy cài
ImageMagick 7 theo [hướng dẫn download chính thức](https://imagemagick.org/download/).

### Windows (winget)

```powershell
winget install -e --id Gyan.FFmpeg.Shared
winget install -e --id ImageMagick.ImageMagick
```

Mở terminal mới sau khi cài, sau đó kiểm tra hai tool và multix:

```bash
ffmpeg -version
magick -version
multix check
```

Với hệ điều hành hoặc package manager khác, dùng [trang download FFmpeg](https://ffmpeg.org/download.html) và [trang download ImageMagick](https://imagemagick.org/download/), sau đó bảo đảm `ffmpeg` và `magick` có trên `PATH`.

## Tiện ích media

`multix media` chọn flow ffmpeg hoặc ImageMagick theo loại input. Dùng output
rõ ràng để không đụng tới file gốc.

Audio được encode lại thành mono 16 kHz với codec khớp đuôi file output:
`.mp3` (MP3), `.m4a`/`.aac`/`.mp4`/`.mka`/`.mkv`/`.mov` (AAC), `.opus`/`.ogg`
(Opus), `.wav`/`.aiff` (PCM) hoặc `.flac` (FLAC). `--bitrate` chỉ áp dụng cho
các định dạng lossy. Đuôi output khác sẽ bị từ chối trước khi chạy ffmpeg. Ảnh
bìa nhúng trong file bị bỏ, nên output chỉ chứa audio.

```bash
multix media optimize --input video.mp4 --output optimized.mp4 --target-size 100
multix media optimize --input voice.wav --output voice.mp3 --bitrate 64k
multix media optimize --input photo.png --output photo.webp --quality 85 --max-width 1920
multix media split --input long-video.mp4 --chunk-duration 3600
multix media batch --input-dir ./source --output-dir ./optimized
```

## Kiểm tra và xác minh media

`media inspect`, `verify`, `frames`, `check-receipt` và `profiles` chạy
offline: không upload gì, không gọi provider nào và không cần API key. Các
lệnh này cần `ffmpeg` và `ffprobe` trên `PATH` (không dùng ImageMagick); nếu
thiếu, lệnh dừng với `BINARY_MISSING` kèm gợi ý cài đặt. Input phải là đường
dẫn local: URL và giao thức ffmpeg như `concat:` hay `pipe:` bị từ chối, còn
symlink được đi theo và ghi lại trong báo cáo.

```bash
multix media inspect clip.mp4 --decode
multix media profiles
multix media verify clip.mp4 --profile motion-graphics --expect-aspect 16:9 \
  --allow-black 0-1 --receipt-out clip.receipt.json
multix media frames clip.mp4 --output-dir ./frames --count 9 --sheet
multix media check-receipt clip.receipt.json clip.mp4
```

### Inspect

`media inspect` chỉ đọc. Lệnh báo cáo sha256 và kích thước file, container
nhận diện từ magic bytes và đuôi file có khớp hay không, các stream, và với
video stream đầu tiên: codec, kích thước, kích thước hiển thị sau khi áp dụng
rotation và tỉ lệ khung điểm ảnh (SAR), góc xoay, frame rate dạng phân số,
time base và frame rate có thay đổi hay không. Giá trị không xác định là
`null`. File văn bản (trang lỗi hoặc playlist lưu với đuôi media) được báo
đúng là văn bản và không bao giờ được đưa vào `ffprobe`. Với WAV, `wav_data`
so số byte mẫu mà chunk `data` khai báo với số byte thực có và đánh dấu
`truncated` khi file ngắn hơn; lỗi này cũng nằm trong `errors` và khiến lệnh
thoát với mã khác 0 (`null` với định dạng khác và với WAV không khai báo độ
dài). `--decode` giải mã toàn bộ file và đếm số lỗi giải mã.

### Verify

`media verify` kiểm tra file theo một profile có phiên bản và in ra biên nhận
(`multix.media-verify/v1`) gắn với sha256 của file, với trạng thái `pass`,
`fail` hoặc `incomplete`. Lệnh thoát với mã khác 0 trừ khi trạng thái là
`pass`; với `--json`, biên nhận nằm trong `data` của envelope kết quả.
`--receipt-out` ghi thêm biên nhận ra file.

Các profile có sẵn (liệt kê bằng `multix media profiles`):

| Profile | Media | Đánh giá |
|---|---|---|
| `motion-graphics` | video | Khoảng đen bị fail; chỉ cảnh đứng yên dài mới cảnh báo |
| `camera-footage` | video | Khoảng đen và khung hình đứng yên trên 1 giây bị fail; thiếu audio và khoảng lặng dài thì cảnh báo |
| `thumbnail` | ảnh | Phải giải mã được và không được trống |
| `audio` | audio | Bắt buộc có audio stream; true peak từ 0 dBTP trở lên bị fail; khoảng lặng dài thì cảnh báo |

Các check gồm loại media, tính toàn vẹn khi giải mã và file bị cắt cụt, khoảng
đen và đứng hình, ảnh trống, khoảng lặng, clipping và (với profile video) hình
kết thúc trước tiếng, cùng các kỳ vọng bạn truyền vào: `--expect-duration` (`--duration-tolerance`), `--expect-aspect` như
`16:9`, `9:16` hoặc `1:1` (`--aspect-tolerance`), và `--loudness`
(`--loudness-tolerance`). Loudness chỉ được kiểm tra khi bạn truyền mục tiêu;
không có sẵn mục tiêu của nền tảng nào. Mỗi check ghi lại ngưỡng, giá trị đo
được và các phát hiện kèm `start_s`/`end_s`.

Check `decode` fail khi file giải mã ra ngắn hơn độ dài container khai báo.
ffprobe tính độ dài WAV từ số byte có trong file, nên với WAV check này so số
byte mẫu mà header của chunk `data` khai báo với số byte thực có
(`measured.declared_data_bytes` và `present_data_bytes`); kích thước RIFF cũng
phải vượt quá file, nên header chỉ đếm sai kích thước data không làm fail một
file đầy đủ. Các stream thô không
khai báo độ dài, như ac3 hoặc AAC thô và mp3 không có header Xing, có thời
lượng do ffprobe ước tính từ bitrate; biên nhận ghi rõ điều này bằng
`measured.declared_duration_estimated: true`, và không thể phát hiện việc bị
cắt đúng ranh giới frame ở những stream đó. WAV ghi qua pipe hoặc stream (kích
thước 0, 0xFFFFFFFF hoặc 0x7FFFF000) cũng không khai báo độ dài.

Khai báo các đoạn fade, giữ hình và khoảng lặng có chủ ý bằng các khoảng lặp
lại được `--allow-black`, `--allow-freeze` và `--allow-silence <start-end>`
(tính bằng giây). Phát hiện nằm trong các khoảng này được ghi là có chủ ý thay
vì bị fail. Đoạn giữ màn hình đen cũng là hình đứng yên, nên `--allow-black`
đồng thời che luôn phần đứng hình mà nó gây ra.

Biên nhận không bao giờ khẳng định nhiều hơn những gì đã đo. `--timeout`, một
check không đo được hoặc file bị thay đổi trong lúc chạy sẽ cho kết quả
`incomplete`, không bao giờ là `pass`. Ctrl-C (hoặc SIGTERM, hoặc đóng
terminal) dừng lần chạy, xoá file tạm và thoát với mã 130 (143, 129) mà không
ghi biên nhận. `coverage.model_reviewed` luôn
là `false`, và `not_measured` liệt kê những gì không được kiểm tra, như đồng
bộ audio/video và tính đúng đắn của nội dung.

Profile tùy chỉnh là một file JSON truyền bằng `--profile-file`:

```json
{
  "id": "short-promo",
  "version": 1,
  "extends": "camera-footage",
  "checks": { "freeze": null, "audio_required": "error" }
}
```

`extends` chỉ định một profile có sẵn mà các check của nó được ghi đè từng cái
một; `null` tắt một check. Nếu không có `extends`, hãy đặt `media` (`video`,
`audio` hoặc `image`).

`--rule <script>` (lặp lại được) thêm một check xác định của riêng bạn. Script
đọc JSON `multix.media-rule-input/v1` từ stdin và in
`{id, version, status, message?, findings?}` ra stdout, trong đó `status` là
`pass`, `fail`, `warn` hoặc `unknown`. `.js`/`.mjs`/`.cjs` chạy bằng Node,
`.py` bằng `python3 -I`, `.sh` bằng `sh`, các file khác được chạy trực tiếp.
Rule chạy không qua shell, môi trường chỉ có `PATH` (không có API key), trong
một thư mục tạm rỗng được xoá sau khi chạy, với `--rule-timeout` (mặc định
30 giây) và giới hạn output 1 MB. Rule bị crash, quá thời gian hoặc in output
không hợp lệ sẽ thành check `unknown` và biên nhận là `incomplete`.

`--cache-dir <dir>` dùng lại biên nhận theo khoá gồm phiên bản engine verify
và ffmpeg, sha256 của file nguồn, profile, các kỳ vọng và các script rule.
Biên nhận `incomplete` không bao giờ được cache; xoá thư mục để làm sạch cache.
Chỉ file của chính rule được băm: sau khi sửa một module mà rule import, hãy
xoá cache. Hãy coi thư mục cache là trạng thái cục bộ đáng tin cậy, không dùng
chung.

### Frames

`media frames` trích `--count` khung hình (mặc định 9) tại điểm giữa của các
đoạn bằng nhau ra `frame-NNN.png`, tùy chọn thêm contact sheet `sheet.png`, và
manifest `frames.json` gồm sha256 của file nguồn, time base và frame rate của
stream, cùng timestamp và sha256 của từng khung hình. Lệnh từ chối thư mục
output đã có sẵn các file này. Trích khung hình không phải là review: để một
model xem chúng, hãy tự truyền chúng vào `multix gemini analyze`.

### Kiểm tra biên nhận

`media check-receipt <receipt> <file>` băm lại file và chỉ thành công khi đó
đúng là các byte mà biên nhận đã đánh giá và biên nhận có trạng thái `pass`.
Lệnh nhận biên nhận thuần hoặc envelope `--json`. File đã transcode, remux hoặc
finalize có byte mới, nên hãy verify chính file cuối cùng trước khi kiểm tra
biên nhận của nó. Kết quả ghi engine verify đã tạo biên nhận và engine hiện
tại (`engine.receipt`, `engine.current`, `engine.current_matches`). Biên nhận
từ một engine khác (ví dụ engine cũ hơn) vẫn thành công vì nó ghi lại lần chạy
đó, nhưng lệnh in cảnh báo ra stderr (và vào `warnings` khi dùng `--json`): hãy
chạy lại `media verify` để áp dụng các check hiện tại, vốn có thể bắt được lỗi
mà engine cũ bỏ sót. Biên nhận không được ký: nó ghi lại một lần chạy
cục bộ, nên chỉ tin nó ở mức bạn tin nguồn gốc của nó.

Trên [remote MCP server](/vi/guides/mcp-server/), `--rule`, `--cache-dir` và
`--receipt-out` không được hỗ trợ.

## Chuyển tài liệu

`multix doc convert` upload tài liệu được hỗ trợ lên Gemini và ghi Markdown.
Dùng `--output` cho đường dẫn xác định hoặc `--auto-name` cho tên tự tạo.

```bash
multix doc convert --input report.pdf --output report.md
multix doc convert --input presentation.pptx --auto-name
```

Truyền `-` làm input để đọc tài liệu được pipe vào stdin. PDF, ảnh và văn bản
được nhận diện tự động; khi không nhận diện được định dạng, hãy truyền
`--stdin-ext` (ví dụ `--stdin-ext pdf`). Chỉ được truyền `-` một lần mỗi lệnh;
để chuyển đổi một file thật tên là `-`, hãy viết `./-`.
Input từ pipe được ghi nhãn `<stdin>` trong kết quả và thông báo lỗi,
`--auto-name` ghi ra `stdin-extraction.md`, và bản tạm được xoá khi lệnh kết
thúc. Nếu không có `--output` hay `--auto-name`, kết quả được ghi vào
`document-extraction.md` trong thư mục output, giống như với file thường.

```bash
cat report.pdf | multix doc convert --input - --output report.md
```
