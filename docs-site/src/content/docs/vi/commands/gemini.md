---
title: Lệnh Gemini
description: Dùng Gemini để phân tích đa phương thức, extract tài liệu, tạo ảnh/video và speech.
---

Lệnh Gemini cần `GEMINI_API_KEY`. Các key phụ `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, … được dùng khi một key hết quota; xem [Biến môi trường](/vi/reference/environment/#xoay-vòng-gemini-key). Chạy `multix gemini <command> --help` trước
khi tự động hóa workflow.

## Analyze, transcribe và extract

Truyền một hoặc nhiều file local bằng `--files`. Khi được hỗ trợ, chọn output
`text`, `json`, `csv` hoặc `markdown`. File lớn hơn 20 MB được stream từ ổ đĩa
lên Gemini Files API, vốn nhận file tối đa 2 GB (2.000.000.000 byte); file lớn
hơn sẽ bị từ chối trước khi upload. Thời gian chờ upload bằng thời gian gửi file
ở tốc độ 1 MB/s cộng thêm một phút (khoảng 35 phút cho file 2 GB).

```bash
multix gemini analyze --files photo.jpg clip.mp4 --prompt "Describe the scene"
multix gemini transcribe --files interview.mp3 --format markdown
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" --format json
```

Dùng `-` làm tên file để đọc dữ liệu pipe qua stdin. Định dạng được nhận diện từ
nội dung (các định dạng ảnh, audio, video, PDF và text UTF-8 phổ biến). Khi
không nhận diện được, lệnh dừng lại và yêu cầu `--stdin-ext`. `-` chỉ được xuất
hiện một lần, có thể dùng cùng file khác, và kết quả gắn nhãn `<stdin>`. Dữ liệu
pipe tối đa 2 GB. Dữ liệu được chép vào một file tạm riêng tư, bị xóa khi lệnh
kết thúc hoặc bị ngắt bằng Ctrl+C; nếu process bị kill cứng, file có thể còn lại
trong thư mục temp của hệ thống. Nếu stdin không có dữ liệu, một gợi ý được in ra
sau hai giây. Trên Windows PowerShell 5.1, pipe dữ liệu nhị phân giữa các chương
trình sẽ làm hỏng dữ liệu; hãy dùng PowerShell 7.4+, cmd hoặc Git Bash.

```bash
cat screenshot.png | multix gemini analyze --files - --prompt "What is shown?"
curl -s https://example.com/talk.mp3 | multix gemini transcribe --files - --stdin-ext mp3
```

## Ảnh và video

`generate` hỗ trợ `--model`, `--aspect-ratio`, `--num-images`, `--size` và
`--output`. `image-to-image` (alias `i2i`) nhận nhiều input `--ref`.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --aspect-ratio 16:9
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

Tạo video là experimental và có thể cần bật Google billing. Dùng
`--wait-timeout`, `--download`, `--output` hoặc `--no-thumb` khi phù hợp.

## Speech

Dùng `generate-speech` với `--text` hoặc `--prompt`; lặp `--speaker name:voice`
cho tối đa hai người nói.

```bash
multix gemini generate-speech --text "Welcome to multix." --voice Kore --output-format wav
```

Model TTS mặc định là `gemini-3.8-flash-lite-tts`. Các model khác được hỗ trợ:
`gemini-3.8-flash-tts`, `gemini-3.1-flash-tts-preview`,
`gemini-2.5-flash-preview-tts` và `gemini-2.5-pro-preview-tts` (ghi đè bằng
`--model` hoặc `GEMINI_TTS_MODEL`). Các model Gemini 3.8
(`gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`) đọc text nguyên văn và
nhận hướng dẫn cách đọc qua `--style` thay vì chèn chỉ dẫn vào text:

```bash
multix gemini generate-speech --text "Welcome to multix." \
  --model gemini-3.8-flash-tts --voice Kore --style "cheerful and friendly"
```

`--style` yêu cầu model Gemini 3.8 TTS và sẽ bị từ chối với model cũ hơn.
