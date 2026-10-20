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
ở tốc độ 1 MB/s cộng thêm một phút (khoảng 35 phút cho file 2 GB). Với đường truyền
chậm hơn, đặt `MULTIX_UPLOAD_MIN_KBPS` bằng tốc độ cần cho phép, tính theo kilobyte
mỗi giây (ví dụ `500` cho 0,5 MB/s).

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

## Ảnh

`generate` hỗ trợ `--model`, `--aspect-ratio`, `--num-images`, `--size` và
`--output`. `image-to-image` (alias `i2i`) nhận nhiều input `--ref`.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
```

## Video

Model video mặc định là `gemini-omni-1.1-flash` (Gemini Omni Flash), chạy qua
Gemini Interactions API. `VIDEO_GEN_MODEL` hoặc `--model` ghi đè model này.
Model id dạng `veo-*` vẫn dùng pipeline Veo; mọi họ model khác bị từ chối thay
vì bị đoán. Video Omni có giá khoảng $0,10 cho mỗi giây video 720p; xem
[trang giá của Google](https://ai.google.dev/gemini-api/docs/pricing) trước khi
chạy số lượng lớn. Veo cần bật Google billing.

```bash
multix gemini generate-video --prompt "Ocean waves at sunset"
multix gemini generate-video --prompt "The cat walks through the garden" \
  --reference-images ./cat.png ./garden.png --aspect-ratio 9:16
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

- `generate-video`: với Omni, `--reference-images` là ảnh tham chiếu chủ thể
  hoặc phong cách (reference-to-video). Với Veo, ảnh đầu tiên là khung hình mở
  đầu và ảnh thứ hai là khung hình kết thúc.
- `image-to-video` (alias `i2v`): ảnh truyền vào là khung hình bắt đầu;
  `--last-frame` thêm khung hình kết thúc để nội suy tới.
- `--output` chép video tới đường dẫn bạn chọn; bản gốc vẫn nằm trong thư mục
  output.

### Tùy chọn Omni

| Cờ | Giá trị | Ghi chú |
|---|---|---|
| `--resolution` | `360p`, `720p` (mặc định), `1080p`, `4k` | `1080p` và `4k` là bản upscale. |
| `--aspect-ratio` | `16:9` (mặc định), `9:16` | |
| `--delivery` | `uri` (mặc định), `inline` | Video lớn hơn khoảng 4 MB cần `uri`. |
| `--task` | `text_to_video`, `image_to_video`, `reference_to_video`, `edit`, `extend` | Model thường tự suy ra tác vụ; chỉ dùng khi prompt chưa đủ. |
| `--no-store` | | Interaction không được lưu, nên không thể chỉnh sửa, kéo dài hay tiếp tục lấy kết quả sau này. Không dùng chung được với `--background`. |
| `--background` | bật, trừ khi có `--no-store` | Server chạy request bất đồng bộ và CLI poll theo interaction id, nên id được lưu trước khi video xong. |
| `--timeout` | 30–7200 giây (mặc định 900) | Tổng thời gian chờ cho lượt chạy. |

`--delivery`, `--task`, `--no-store`, `--background` và `--timeout` bị từ chối
với model `veo-*`. Veo nhận `--resolution 720p|1080p` (mặc định `1080p`) và mặc
định `16:9`; `--no-thumb` chỉ áp dụng cho Veo.

### File session

Mỗi lượt chạy Omni được lưu sẽ ghi file `<video>.interaction.json` cạnh video,
với quyền file 0600. File ghi interaction id, interaction id cha (khi chỉnh sửa
hoặc kéo dài), model, tên biến môi trường của key (không bao giờ ghi giá trị
key), trạng thái, usage và đường dẫn output. Truyền file này cho `edit-video`,
`extend-video` hoặc `video-status` bằng `--session`.

### Chỉnh sửa và kéo dài

`edit-video` thay đổi video theo một chỉ dẫn bằng văn bản; `extend-video` thêm
3–10 giây (kéo dài nhiều lần đạt tổng cộng khoảng 40 giây). Cả hai lệnh nhận
`--prompt` và đúng một nguồn:

- `--session <file>`: file session từ một lệnh Omni trước đó. File này cố định
  key (và do đó cả Google Cloud project) đã tạo interaction; ghi đè bằng
  `--key-env GEMINI_API_KEY_2`.
- `--interaction-id <id>`: một interaction đã được lưu.
- `--video <path>`: một clip local dài tối đa 10 giây, được upload trước. Chỉnh
  sửa hoặc kéo dài video upload không khả dụng ở EEA, Thụy Sĩ và Vương quốc
  Anh.

`--reference-images` thêm ảnh mà bạn có thể gọi trong prompt là
`<IMAGE_REF_0>`, `<IMAGE_REF_1>`, v.v. Interaction tạo bằng `--no-store` không
thể tiếp tục.

```bash
multix gemini edit-video --session ./multix-output/omni_generated_1760000000000.interaction.json \
  --prompt "Make it night time"
multix gemini extend-video --session ./multix-output/omni_generated_1760000000000.interaction.json \
  --prompt "The camera rises above the clouds"
multix gemini edit-video --video ./clip.mp4 --reference-images ./hat.png \
  --prompt "Put the hat in <IMAGE_REF_0> on the person"
```

### Kiểm tra hoặc khôi phục lượt chạy

`video-status` nhận một interaction id hoặc `--session <file>` và in một object
JSON ra stdout (trạng thái, model, usage; không có URL và không có dữ liệu
video). `--wait` poll tới khi interaction kết thúc, `--download` lưu video đã
hoàn tất vào thư mục output và cập nhật file session, còn `--output` chép video
tới nơi khác. Dùng lệnh này để khôi phục một lượt chạy bị timeout ở máy local mà
không phải trả tiền cho lần tạo thứ hai:

```bash
multix gemini video-status --session ./multix-output/omni_generated_1760000000000.interaction.json --wait --download
```

### An toàn cho request tính phí

- Các lần chạy có lưu interaction mặc định dùng `--background`, nên interaction
  id được ghi vào session file ngay và mất kết nối cũng không làm mất video đã
  tính phí; lấy lại bằng `video-status`.
- Khi request tạo video gặp lỗi mạng, lỗi 5xx hoặc phản hồi không đọc được sau
  khi đã được gửi đi, CLI không gửi lại, vì request đó vẫn có thể hoàn tất và
  bị tính phí.
- Key chỉ xoay vòng khi gặp 429 hoặc `RESOURCE_EXHAUSTED` trước khi request
  được nhận. Polling, download và các lệnh tiếp nối dùng đúng key đã tạo
  interaction; xem [Xoay vòng Gemini key](/vi/reference/environment/#xoay-vòng-gemini-key).
- Bước download chờ tới khi Files API báo video ở trạng thái `ACTIVE`. API key
  chỉ được gửi tới `generativelanguage.googleapis.com`; URL video khác được tải
  mà không kèm credential.

### Remote MCP server

Qua [remote MCP server](/vi/guides/mcp-server/), `multix_run` cũng nhận
`gemini edit-video`, `gemini extend-video` và `gemini video-status`.
`--session`, `--video` và `--reference-images` được truyền dưới dạng file input.
`--resolution` phải nằm trong danh sách cho phép của người vận hành, mặc định từ
chối `360p` và `4k`.

### Model video bị ngừng hỗ trợ

Dùng một trong các model này sẽ in cảnh báo; request vẫn được gửi đúng như yêu
cầu, không bao giờ bị chuyển sang model khác.

| Model | Ngày ngừng hoạt động |
|---|---|
| `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview`, `gemini-omni-flash-preview` | 2026-10-22 |
| `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`, `veo-2.0-generate-001` | 2026-06-30 |
| `veo-3.0-generate-preview`, `veo-3.0-fast-generate-preview` | 2025-11-12 |

Để chuyển đổi, bỏ `--model` (và mọi `VIDEO_GEN_MODEL` đang trỏ tới model Veo)
để dùng model Omni mặc định. Omni mặc định 720p, nên hãy truyền `--resolution`
rõ ràng nếu muốn giữ độ phân giải cao hơn:

```bash
# Trước
multix gemini generate-video --model veo-3.1-generate-preview --prompt "Ocean waves" --resolution 1080p
# Sau
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p
```

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
