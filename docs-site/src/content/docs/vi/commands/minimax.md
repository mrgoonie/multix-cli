---
title: Lệnh MiniMax
description: Tạo ảnh MiniMax, video Hailuo, speech và music.
---

Lệnh MiniMax cần `MINIMAX_API_KEY`. Trước khi tự động hóa, kiểm tra CLI đang
cài bằng `multix minimax <command> --help`.

## Ảnh

```bash
multix minimax generate --prompt "A cat in space" --aspect-ratio 1:1 --output cat.png
```

`image-to-image` (alias `i2i`) là giữ chủ thể, không phải chỉnh ảnh tự do. Nó
dùng duy nhất một `--ref` local hoặc URL làm tham chiếu nhân vật/khuôn mặt rồi
tạo scene mới theo `--prompt`; không chỉnh trực tiếp ảnh input.

```bash
multix minimax i2i \
  --ref ./hero.jpg \
  --prompt "the same character walking on a neon beach" \
  --output hero-beach.png
```

## Video

`generate-video` là bất đồng bộ; multix đợi video hoàn tất. Nếu dùng
`--first-frame`, giá trị phải là HTTP(S) URL.

```bash
multix minimax generate-video \
  --prompt "A dancer in a sunlit studio" \
  --duration 6 --resolution 1080P \
  --first-frame https://example.com/first-frame.jpg \
  --output dancer.mp4
```

## Speech và music

```bash
multix minimax generate-speech \
  --text "Welcome to multix." --voice English_expressive_narrator \
  --emotion happy --output-format mp3 --output welcome.mp3

multix minimax generate-music \
  --prompt "Dreamy synthwave instrumental" --output-format mp3 \
  --output synthwave.mp3
```

Music cần `--lyrics` hoặc `--prompt`; speech cần `--text` hoặc `--prompt`.
