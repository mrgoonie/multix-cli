---
title: Output và xử lý lỗi
description: Kiểm tra prerequisite, kiểm soát file sinh ra và chẩn đoán lỗi thường gặp của multix.
---

## Kiểm tra máy local

```bash
multix check
multix check --verbose
```

`check` kiểm tra credential đang có và media tooling trên máy. Lệnh media cần
`ffmpeg`; các lệnh cần ImageMagick yêu cầu `magick` có trong `PATH`.

## File output

File sinh ra mặc định trong `./multix-output`. Đặt `MULTIX_OUTPUT_DIR` để đổi
mặc định, hoặc dùng `--output` tại lệnh hỗ trợ option này.

```bash
multix media optimize --input source.mp4 --output optimized.mp4 --target-size 100
```

## Định dạng ảnh

Các lệnh `generate` và `image-to-image` cho ảnh mặc định chuyển kết quả sang WebP (`cwebp -q 85 -m 6 -metadata none`), kiểm tra kích thước và độ trong suốt không đổi, và chỉ xóa file trung gian do CLI tạo. Giữ định dạng/chất lượng gốc của provider bằng `--image-format original`, `--no-webp`, `MULTIX_IMAGE_FORMAT=original`, hoặc `--output` có đuôi khác WebP như `hero.png`. Nếu không có `cwebp` trên `PATH`, CLI cảnh báo và giữ file gốc.

## Cách xử lý phổ biến

- **Không có provider khả dụng:** đặt ít nhất một API key được hỗ trợ rồi chạy
  lại `multix check`.
- **Lệnh media không chạy:** cài `ffmpeg`, và ImageMagick 7+ khi cần.
- **Lỗi xác thực:** kiểm tra key đúng provider và process nhìn thấy key bằng
  `multix check --verbose`.
- **Generation mất thời gian:** video và một số thao tác provider chạy async;
  dùng lệnh status tương ứng nếu provider có hỗ trợ.

Dùng `--help` tại chính lệnh cần chạy để xem flags và default mới nhất.
