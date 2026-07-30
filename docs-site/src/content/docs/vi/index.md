---
title: Tài liệu multix CLI
description: Tạo và phân tích media bằng một CLI thống nhất, có nhận biết provider.
template: splash
hero:
  title: multix
  tagline: AI multimodal CLI cho ảnh, video, giọng nói, nhạc, tài liệu và công cụ media.
  actions:
    - text: Cài multix
      link: /vi/getting-started/
      icon: right-arrow
    - text: GitHub
      link: https://github.com/mrgoonie/multix-cli
      icon: external
---

## Một CLI cho workflow media thực tế

`multix` hỗ trợ OpenAI, Gemini, MiniMax, OpenRouter, Leonardo, BytePlus và
ElevenLabs mà không biến credential provider thành framework phức tạp.

```bash
npm install -g @mrgoonie/multix
multix check
multix gemini generate --prompt "A sunrise over layered mountains" --aspect-ratio 16:9
```

Bắt đầu tại [cài đặt và cấu hình](/vi/getting-started/), sau đó chọn workflow
phù hợp từ thanh điều hướng.
