---
title: Media và tài liệu
description: Tối ưu media bằng tool local và chuyển tài liệu sang Markdown với Gemini.
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

```bash
multix media optimize --input video.mp4 --output optimized.mp4 --target-size 100
multix media optimize --input photo.png --output photo.webp --quality 85 --max-width 1920
multix media split --input long-video.mp4 --chunk-duration 3600
multix media batch --input-dir ./source --output-dir ./optimized
```

## Chuyển tài liệu

`multix doc convert` upload tài liệu được hỗ trợ lên Gemini và ghi Markdown.
Dùng `--output` cho đường dẫn xác định hoặc `--auto-name` cho tên tự tạo.

```bash
multix doc convert --input report.pdf --output report.md
multix doc convert --input presentation.pptx --auto-name
```
