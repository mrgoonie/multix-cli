---
title: Cài đặt và cấu hình
description: Cài multix, cấu hình credential provider và kiểm tra CLI trước khi chạy workflow media.
---

## Cài đặt

Dùng Node.js 20 trở lên. Bạn có thể cài global hoặc chạy package bằng `npx`.

```bash
npm install -g @mrgoonie/multix
# hoặc
npx -p @mrgoonie/multix multix --help
```

Để xử lý media, cài `ffmpeg` và ImageMagick 7+ (`magick`) trên `PATH`.

## Thêm provider key

Tạo `.env` trong project hiện tại, hoặc dùng `~/.multix/.env`. Biến môi trường
có ưu tiên cao hơn cả hai file.

```bash
GEMINI_API_KEY=...
# hoặc OPENAI_API_KEY, OPENROUTER_API_KEY, MINIMAX_API_KEY,
# LEONARDO_API_KEY, BYTEPLUS_API_KEY, ELEVENLABS_API_KEY
```

Không commit file `.env`. Chạy setup check trước khi tạo media.

```bash
multix check
multix check --verbose
```

## Cập nhật multix

```bash
multix update --check
multix update
```

`multix update` tự nhận diện cách CLI được cài (npm, pnpm, yarn hoặc bun
global) và chạy đúng lệnh cài đặt tương ứng. `--check` chỉ so sánh version;
`--tag <tag>` cài một dist-tag cụ thể; `--dry-run` in lệnh thay vì chạy. Xem
[tổng quan lệnh](/vi/commands/) để biết đầy đủ các flag.
