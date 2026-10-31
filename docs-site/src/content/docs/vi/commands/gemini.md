---
title: Lệnh Gemini
description: Dùng Gemini để phân tích đa phương thức, extract tài liệu, tạo ảnh/video, speech và nhạc Lyria.
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
`--output`. Model mặc định là `gemini-3.1-flash-image` (Nano Banana 2, GA);
có thể chọn `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` hoặc
`gemini-nano-banana-2.1`. Imagen 4 không còn chạy trên Gemini API, và các id ảnh
`-preview` đã qua ngày ngừng hoạt động sớm nhất mà Google công bố và có thể bị
tắt bất cứ lúc nào. Với `--num-images` lớn hơn 1, ảnh được yêu cầu lần lượt;
nếu một request sau bị lỗi, các ảnh đã lưu được giữ lại (và chép sang
`--output`), và lỗi gợi ý lần chạy với `--num-images` bằng số còn thiếu.
`image-to-image` (alias `i2i`) nhận nhiều input `--ref`.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
```

## Video

`generate-video` và `image-to-video` (alias `i2v`) mặc định dùng Gemini Omni
Flash (`gemini-omni-1.1-flash`) qua Interactions API. Tạo video cần key đã bật
billing.

```bash
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --duration 8
multix gemini generate-video --prompt "A cat walks in" --reference-images ./first.png ./last.png
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

- `--resolution` nhận `360p`, `720p` (mặc định), `1080p` hoặc `4k`;
  `--aspect-ratio` nhận `16:9` (mặc định) hoặc `9:16`; `--duration` nhận 3–10
  giây, nếu bỏ trống thì model tự chọn độ dài.
- `--reference-images` với một hoặc hai ảnh sẽ đặt khung hình đầu và cuối;
  nhiều ảnh hơn được dùng làm ảnh tham chiếu chủ thể. `i2v --last-frame` gửi
  ảnh mở đầu trước và ảnh kết thúc sau, nên video bắt đầu ở ảnh thứ nhất và
  kết thúc ở ảnh thứ hai.
- Mỗi request được lưu trữ và chạy nền. Interaction id được ghi vào
  `gemini_omni_<timestamp>-<random>.json` trong thư mục output trước khi bắt đầu
  polling. Khi thành công, stdout in `Generated video: <path>` và
  `Interaction ID: <id>`.
- `--no-wait` gửi request, in JSON `{interaction_id, status, session}` rồi
  thoát. `--wait-timeout <ms>` (mặc định 15 phút) là một deadline chung cho
  cả lần chạy đến khi video hoàn tất: upload, gửi request và polling đều trừ
  vào đó, và khi hết hạn thì không gửi request nào. Một request đã bắt đầu gửi
  vẫn có tối đa 2 phút, để job đã được chấp nhận (đã tính phí) không bao giờ
  mất id. Việc lưu video đã hoàn tất có ngân sách riêng (tối đa 5 phút chờ
  file sẵn sàng, rồi tối đa 10 phút để tải về).
- Video trả về inline chỉ được đọc tối đa bằng kích thước base64 của
  `MULTIX_MAX_DOWNLOAD_MB` cộng 64 MB cho JSON, và không quá 384 MB; video lớn
  hơn sẽ báo lỗi ngay kèm lệnh `video-status` để tiếp tục, thay vì bị tải lại
  ở mỗi lần polling.
- `--no-store` gửi một request đồng bộ mà Google không lưu lại: kết quả không
  thể chỉnh sửa, nối dài hay tiếp tục, và không dùng chung được với `--no-wait`.
- `--upload-timeout` đã ngừng hỗ trợ và bị bỏ qua; `--no-thumb` chỉ áp dụng
  cho Veo.

### Chỉnh sửa và nối dài

`edit-video` thay đổi một video có sẵn theo prompt; `extend-video` nối thêm
một đoạn tiếp theo dài 3–10 giây vào cuối video (tổng cộng tối đa 40 giây).
Nguồn là một interaction đã lưu (`--interaction-id`) hoặc một clip local dài
tối đa 10 giây (`--video`), được upload lên Files API. Video nối dài gồm clip
gốc và đoạn tiếp theo (clip 3 giây nối thêm 3 giây sẽ trả về video 6 giây).

```bash
multix gemini edit-video --prompt "make it night time" --interaction-id <id>
multix gemini edit-video --prompt "add falling snow" --video ./clip.mp4 --reference-images ./snow.png
multix gemini extend-video --prompt "the camera follows the ball out the door" \
  --interaction-id <id> --duration 6
```

Nếu không truyền `--resolution` hoặc `--aspect-ratio`, kết quả giữ nguyên định
dạng của video nguồn. `extend-video --video` không nhận `--aspect-ratio` (API
từ chối tham số này khi nối dài); đoạn tiếp theo giữ khung hình của video
nguồn. Chỉ interaction đã hoàn tất mới được chỉnh sửa hoặc nối
dài. Chỉnh sửa hoặc nối dài video upload không khả dụng ở EEA, Thụy Sĩ và Vương
quốc Anh; chỉnh sửa video đã tạo bằng `--interaction-id` vẫn dùng được ở đó.
Interaction đã lưu và file đã upload sẽ hết hạn (file trên Files API sau khoảng
48 giờ).

Với `--video`, request ghi rõ tác vụ (`edit` hoặc `extend`). Với
`--interaction-id`, API không nhận tác vụ, nên multix thêm `Edit this video:`
hoặc `Extend this video:` vào đầu prompt, trừ khi prompt đã có sẵn. Nếu không,
model tự đoán theo câu chữ: "the ball turns blue" gửi để nối dài lại bị hiểu
thành chỉnh sửa.

### Trạng thái, tiếp tục và hủy

```bash
multix gemini video-status <id>                      # bản tóm tắt JSON
multix gemini video-status <id> --download --output ./clip.mp4
multix gemini video-cancel <id>
```

`video-status` chỉ in JSON (hoặc đường dẫn đã lưu khi có `--download`) ra
stdout, không bao giờ in URI file hay dữ liệu media; tiến trình được ghi ra
stderr, nên có thể pipe kết quả sang `jq`. Lệnh trả mã thoát khác 0 khi
interaction thất bại, bị hủy hoặc chưa hoàn chỉnh. `--wait` poll cho đến khi
xong; `--download` lưu video đã hoàn tất. `video-cancel` đọc interaction trước
và để nguyên interaction đã kết thúc.

### Key và chi phí

Khi có nhiều key trong [nhóm xoay vòng](/vi/reference/environment/#xoay-vòng-gemini-key),
chỉ bước submit được xoay vòng, và chỉ khi bị giới hạn tốc độ. Key đã nhận
request được dùng cho polling và download, còn các lệnh tiếp nối dùng key thuộc
project đang giữ interaction. Lỗi mạng khi submit không được thử lại, vì video
có thể đã bắt đầu tạo và bị tính phí.

Omni chỉ dùng được ở gói trả phí. Session record chứa ước tính chi phí dựa trên
lượng token được báo cáo (video output $17,50, input $1,50, text và thought
output $9 cho mỗi 1M token; khoảng $0,10 mỗi giây ở 720p). Số tiền thực tế là
số Google tính.

### Chuyển từ Veo

Google ngừng các model Veo 3.1 preview trên Gemini API vào ngày 2026-10-22;
các model Veo 3.0 đã ngừng từ ngày 2026-06-30. `gemini-omni-flash-preview`
cũng ngừng vào ngày 2026-10-22, vì vậy hãy dùng `gemini-omni-1.1-flash`.

```bash
# Trước: Veo, mặc định 1080p
multix gemini generate-video --prompt "Ocean waves" --model veo-3.1-generate-preview
# Sau: Omni Flash, mặc định 720p
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p
```

Truyền rõ `--model veo-*` (hoặc `VIDEO_GEN_MODEL=veo-*`) vẫn chạy luồng Veo,
kèm cảnh báo ngừng hoạt động với các model preview. Veo hỗ trợ `720p` và
`1080p` (mặc định `1080p`); `--duration`, `--no-store` và `--no-wait` báo lỗi
khi dùng với Veo. Model không phải Omni hay Veo sẽ bị từ chối.

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

## Music

`generate-music` tạo nhạc bằng Google Lyria qua Interactions API. Model mặc
định `lyria-3-clip-preview` trả về một đoạn MP3 dài 30 giây; `lyria-3.5` trả về
một bài hát hoàn chỉnh dài khoảng vài phút, dạng MP3 hoặc WAV khi dùng
`--output-format wav`. Ghi đè model mặc định bằng `--model` hoặc
`GEMINI_MUSIC_MODEL`.

```bash
multix gemini generate-music --prompt "upbeat synthwave with a driving bassline"
multix gemini generate-music --model lyria-3.5 --output-format wav \
  --prompt "warm acoustic folk ballad, female vocals" --lyrics-file lyrics.txt
multix gemini generate-music --prompt "a soundtrack for this scene" --image scene.png
```

- `--lyrics` hoặc `--lyrics-file` (UTF-8, tối đa 64 KB) thêm lời bài hát vào
  prompt; các thẻ đoạn như `[Verse]`, `[Chorus]` và mốc thời gian như
  `[0:00 - 0:15] Intro` định hướng cấu trúc bài.
- `--image` (lặp lại được, tối đa 10 ảnh PNG, JPEG, WebP hoặc HEIC) định hướng
  cảm xúc của bài.
- Bài hát được lưu thành `gemini_music_<stamp>.mp3` (hoặc `.wav`). Lời hoặc cấu
  trúc bài mà model trả về được lưu cạnh đó thành `gemini_music_<stamp>.txt`.
- Lyria tính phí theo bài (US$0,04 cho một đoạn clip, US$0,08 cho một bài
  `lyria-3.5`, không có free tier), nên `--estimate` và `--max-cost` dùng được.
  Request chỉ gửi một lần: khi timeout hoặc mất kết nối, request không được gửi
  lại vì Google có thể đã tạo và tính phí bài hát; lỗi trả về là
  `UNKNOWN_REMOTE_STATE` và không retry được. Chỉ khi bị giới hạn tốc độ
  (rate limit) thì mới chuyển sang key `GEMINI_API_KEY_<n>` kế tiếp.

### Lyria RealTime

`music-live` ghi một phiên nhạc không lời từ Lyria RealTime
(`lyria-realtime-exp`, thử nghiệm) ra file WAV stereo 48 kHz, 16-bit. Phiên
chạy qua WebSocket nên cần Node.js 22 trở lên.

```bash
multix gemini music-live --prompt "minimal techno" --prompt "rain" --weight 1 --weight 0.4 \
  --bpm 124 --density 0.6 --duration 60
multix gemini music-live --prompts-file session.json --duration 120 --output live.wav
```

- Lặp `--prompt` cùng `--weight` tương ứng (mặc định 1.0) để pha trộn phong
  cách.
- Tham số điều khiển: `--bpm` (60–200), `--density` và `--brightness` (0–1),
  `--guidance` (0–6), `--temperature` (0–3), `--top-k` (1–1000), `--seed`,
  `--scale` (ví dụ `C_MAJOR_A_MINOR`), `--mode`
  (`QUALITY|DIVERSITY|VOCALIZATION`), `--mute-bass`, `--mute-drums` và
  `--only-bass-and-drums`. Đổi BPM hoặc scale sẽ reset ngữ cảnh của model, tạo
  ra một đoạn chuyển nghe rõ.
- `--prompts-file` nhận JSON gồm `prompts`, `config` tùy chọn (các flag ghi đè
  lên nó) và `changes` tùy chọn để áp dụng prompt hoặc config mới tại một thời
  điểm trong bản ghi:

  ```json
  {
    "prompts": [{ "text": "lo-fi hip hop", "weight": 1 }],
    "config": { "bpm": 80, "density": 0.4 },
    "changes": [{ "at": 30, "prompts": [{ "text": "jazz piano", "weight": 1 }] }]
  }
  ```

- `--duration` (1–600 giây, mặc định 30) là độ dài âm thanh cần ghi. Ctrl-C
  dừng ghi sớm, vẫn ghi ra file WAV hợp lệ (sao chép sang `--output` nếu có) và
  thoát với mã 130. Nếu server kết thúc phiên sớm,
  phần đã ghi được giữ lại, lệnh thoát với mã 1 và phiên không được khởi động
  lại.
- Đầu ra chỉ có nhạc không lời. Google chưa công bố giá cho Lyria RealTime, nên
  `--estimate` báo không rõ giá và `--max-cost` từ chối chạy. `--dry-run` in các
  message của phiên mà không kết nối.
- Remote MCP server không chạy `music-live`.
