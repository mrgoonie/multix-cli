---
title: Lệnh scene (audio hội thoại)
description: Render hội thoại nhiều nhân vật theo từng câu thoại, với voice profile cho mỗi nhân vật, take được cache, duyệt take và xuất stem.
---

`multix scene` biến kịch bản dạng văn bản thuần thành audio hội thoại, mỗi câu
thoại một file. Mỗi nhân vật có một voice profile, nên một người nói giữ nguyên
provider, model và giọng qua mọi scene. Mỗi câu thoại đã render được lưu thành
một take. Sửa một câu thì chỉ câu đó được render lại. Bạn duyệt các take mình
muốn rồi xuất chúng thành stem cho phần mềm dựng audio hoặc video.

Phần đọc giọng dùng các client Gemini, OpenAI và ElevenLabs sẵn có, và cần key
của từng provider mà profile sử dụng: `GEMINI_API_KEY`, `OPENAI_API_KEY` hoặc
`ELEVENLABS_API_KEY`.

## Cấu trúc project

Một scene project là một thư mục local. Mặc định là thư mục hiện tại; truyền
`--project <dir>` để dùng thư mục khác. multix ghi các file sau:

| Đường dẫn | Nội dung |
| --- | --- |
| `voices/<id>.json` | Mỗi nhân vật một voice profile (`multix.voice/v1`). |
| `multix-scene.json` | Scene manifest (`multix.scene/v1`): mọi câu thoại, request, cache key, các take và trạng thái. |
| `takes/<scene>/` | Audio đã render, mỗi take một file. |
| `<out>/scene-export.json` | Manifest xuất (`multix.scene-export/v1`), do `export` ghi cạnh các stem. |

Đường dẫn kịch bản trong manifest là đường dẫn tương đối so với project, nên
bạn có thể di chuyển thư mục.

## Voice profile

```bash
multix scene voice add hiro --provider openai --model gpt-4o-mini-tts \
  --voice cedar --style "trầm, điềm tĩnh"
multix scene voice add mai --provider elevenlabs --model eleven_flash_v2_5 \
  --voice kdmDKE6EkgrWrrykO9Qt --language vi-VN --setting stability=0.5 --alias "Mai"
multix scene voice list
multix scene voice validate
```

- `--provider` là `gemini`, `openai` hoặc `elevenlabs`. Model, giọng và
  `--format` được kiểm tra theo provider đó. Nếu bỏ `--format`, mặc định là
  `wav` cho Gemini, `mp3` cho OpenAI và `mp3_44100_128` cho ElevenLabs.
- Tên người nói trong kịch bản khớp với profile qua id, `--name` hoặc bất kỳ
  `--alias` nào, không phân biệt hoa thường. Id của profile gồm chữ thường, chữ
  số, `_` và `-`.
- `--setting key=value` có thể lặp lại và chỉ nhận các setting mà provider hỗ
  trợ (xem [giới hạn theo model](#giới-hạn-theo-model)).
- `version` bắt đầu từ 1. `--force` thay profile đã có và tăng version. Version
  chỉ là nhãn. Cache key được tạo từ chính các trường của request (model, giọng,
  format, style, setting, v.v.). Đổi bất kỳ trường nào trong đó thì các câu của
  giọng ấy được render lại, còn chỉ tăng version thì không.
- Profile không bao giờ chứa credential. Một trường có tên giống key, token,
  secret hay password, hoặc một giá trị trông như API key, làm profile không hợp
  lệ. Key được lấy từ biến môi trường khi render.
- Giọng clone từ giọng của một người thật phải ghi nhận sự đồng ý. `--cloned`
  bắt buộc đi kèm `--consent-by <name>`. `--consent-at <iso>` mặc định là thời
  điểm hiện tại, còn `--consent-note <text>` ghi phạm vi đồng ý.

## Định dạng kịch bản

Kịch bản là một file văn bản thuần. Mỗi file là một scene.

```text
# scene: s01
# title: Sân thượng lúc bình minh
# Các dòng khác bắt đầu bằng "#" là chú thích.
HIRO: Cuối cùng em cũng đến.
MAI (khẽ, hơi mệt): Suýt nữa em không đến.
  Chuyến tàu cuối đã chạy mất rồi.
HIRO: Vậy mình đi bộ.
```

- `# scene: <id>` đặt id của scene. Không có dòng này thì id là tên file bỏ
  phần đuôi. `# title:` là tùy chọn.
- `NGƯỜI_NÓI: lời thoại` bắt đầu một câu thoại. `NGƯỜI_NÓI (chỉ dẫn): lời
  thoại` thêm chỉ dẫn diễn xuất, chỉ dùng được với model nhận chỉ dẫn style.
- Dòng không bắt đầu bằng `NGƯỜI_NÓI:` được nối vào câu thoại phía trên.
- Văn bản được chuẩn hóa Unicode NFC. Tiếng Việt gõ dấu dựng sẵn hay dấu tổ hợp
  đều cho cùng một cache key.
- Id câu thoại có dạng `s01/001`. Khi câu dài hơn mức model nhận hoặc dài hơn
  `--max-chars` của profile, nó được tách theo ranh giới câu, rồi theo ranh giới
  từ, thành các phần `s01/001.1`, `s01/001.2`, v.v. Mỗi phần được render bằng
  một request riêng.

## Quy trình

```bash
multix scene plan scripts/s01.txt scripts/s02.txt   # phân tích vào multix-scene.json (local, miễn phí)
multix scene render --dry-run                       # kiểm tra key và xem request đầu tiên
multix scene render                                 # render mọi câu chưa có take hiện hành
multix scene status --lines                         # tiến độ, thời lượng và chi phí được báo
multix scene render --line s01/002 --new-take       # thêm một biến thể cho một câu
multix scene approve s01/001 s01/003
multix scene approve s01/002 --take <takeId>        # chọn một biến thể cụ thể
multix scene reject s01/002 --take <takeId>
multix scene export --out stems --approved-only
```

- **plan** phân tích kịch bản và profile rồi ghi manifest. Lệnh báo
  `to_render`, `to_render_chars`, `cached`, `invalidated`, `added` và
  `removed`. Kịch bản bạn truyền vào được thêm vào các kịch bản đã plan (kịch bản
  cùng đường dẫn được đọc lại); `--replace` chỉ plan các kịch bản bạn truyền và
  bỏ các scene khác. Chạy `plan` không kèm file kịch bản để đọc lại các kịch bản
  đã biết. Lệnh không gửi request nào.
- **render** chạy lại bước plan trước, nên kịch bản và profile vừa sửa được cập
  nhật. Sau đó lệnh gửi một request cho mỗi câu chưa có take ứng với request
  hiện tại của nó. `--scene <id>` và `--line <id>` (lặp lại được) thu hẹp phạm
  vi. `--limit <n>` giới hạn số request của một lần chạy. `--keep-going` tiếp
  tục sau câu bị lỗi; không có cờ này, lần chạy dừng ở lỗi đầu tiên. Lệnh thoát
  với mã khác 0 nếu có câu bị lỗi. Take có file không qua bước kiểm tra (rỗng,
  hoặc ffprobe không đọc được khi máy có ffprobe) vẫn được giữ cùng biên nhận
  nhưng không được chọn, và câu đó lỗi với mã `VERIFICATION_FAILED`. Các câu
  giống hệt nhau trong một lần chạy dùng chung một request.
- **`--new-take`** bắt buộc đi kèm `--line`. Cờ này render một biến thể mới cho
  các câu đó dù đã có take trong cache. Các take cũ vẫn nằm trong manifest.
- **approve** đánh dấu duyệt take đang chọn, hoặc take truyền qua `--take` (chỉ
  cho một câu). Lệnh từ chối take được render cho kịch bản hoặc giọng cũ.
- **reject** bắt buộc có `--take`. Nếu take bị loại đang được chọn, câu thoại
  quay về take mới nhất khác của cùng request.
- **status** hiển thị theo từng scene số câu đã render/đã duyệt/lỗi, thời lượng
  và chi phí được báo. `--lines` thêm id, người nói, trạng thái và take đang chọn
  của từng câu, không kèm lời thoại.
- **export** sao chép take đang chọn của mọi câu ra
  `<out>/<scene>/<NNN>_<speaker>.<ext>` và ghi `scene-export.json` gồm id câu,
  người nói, lời thoại, chỉ dẫn, take, trạng thái duyệt, hash, thời lượng và
  model của từng stem. Lệnh báo lỗi khi có câu chưa có take dùng được, trừ khi
  truyền `--allow-missing`. `--approved-only` coi câu chưa duyệt là thiếu. Trước
  khi sao chép, export kiểm tra từng file take với hash đã ghi. `--scene <id>`
  chỉ xuất một scene.

## Cache và request trả phí

Mỗi câu thoại có một cache key: hash của chính xác request (provider, model,
giọng, format, style, setting, ngôn ngữ, lời thoại lân cận khi bật context) cộng
với lời thoại. `render` chỉ gửi những câu mà key hiện tại chưa có take. Nếu bạn
sửa một câu trong scene, lần render sau chỉ gửi một request, mọi câu khác giữ
nguyên take.

multix không bao giờ retry một request trả phí và không bao giờ chuyển sang
provider khác. Câu bị lỗi được ghi lại cùng mã lỗi. Chạy lại `render` sẽ gửi lại
câu đó; đó là quyết định của bạn, không phải retry tự động. Manifest được ghi
sau mỗi take, nên một lần chạy bị ngắt vẫn giữ lại những gì đã trả tiền.
`plan`, `render`, `approve` và `reject` giữ file `multix-scene.lock` trong lúc
chạy, nên hai lệnh không ghi đè take của nhau; lock do một tiến trình đã thoát
để lại sẽ được tiếp quản. Take đi theo cache key, nên khi chèn thêm một câu, các
câu phía dưới vẫn giữ audio, nhưng id (và tên file khi export) được đánh số lại.

Trước khi tính phí, `plan` và `render` từ chối:

- người nói chưa có profile, profile không hợp lệ hoặc có secret trong profile;
- markup mà model không nhận: SSML khác `<break/>`, `<break/>` trên model không
  hỗ trợ SSML break, `[audio tag]` trên model khác `eleven_v3`;
- `(chỉ dẫn)` hoặc `--style` trên model không nhận chỉ dẫn style. Những model
  đó sẽ đọc to phần chỉ dẫn.

Sau đó `render` kiểm tra key của mọi provider sắp được gọi đã được đặt, trước
request đầu tiên.

## Giới hạn theo model

Các giới hạn này được kiểm tra trước khi gửi bất kỳ request nào. Nguồn của chúng
là
[`speech-adapters.ts`](https://github.com/mrgoonie/multix-cli/blob/main/src/commands/scene/speech-adapters.ts);
danh sách model, giọng và format lấy từ file model của từng provider.

| Provider / model | Ký tự tối đa mỗi request | Style hoặc `(chỉ dẫn)` | SSML `<break/>` | `[audio tag]` | `--context` | Gửi ngôn ngữ | Setting |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gemini 3.8 TTS (`gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`) | 4.000 | có | không | không | không | không | không có |
| Các model Gemini TTS khác | 4.000 | không | không | không | không | không | không có |
| OpenAI `gpt-4o-mini-tts` | 4.096 | có | không | không | không | không | `speed` (0,25–4) |
| OpenAI `tts-1`, `tts-1-hd` | 4.096 | không | không | không | không | không | `speed` (0,25–4) |
| ElevenLabs `eleven_v4`, `eleven_v4_turbo` | 10.000 | không | không | có | có | có | xem bên dưới |
| ElevenLabs `eleven_v3`, `eleven_v3_conversational` | 5.000 | không | không | có | không | có | xem bên dưới |
| ElevenLabs `eleven_multilingual_v2` | 10.000 | không | có | không | có | không (bị từ chối) | xem bên dưới |
| ElevenLabs `eleven_flash_v2_5`, `eleven_turbo_v2_5` | 40.000 | không | có | không | có | có | xem bên dưới |
| ElevenLabs `eleven_flash_v2`, `eleven_turbo_v2` | 30.000 | không | có | không | có | có | xem bên dưới |

- Setting của ElevenLabs: `stability`, `similarity_boost`, `style` (0–1),
  `use_speaker_boost` (true/false), `speed` (0,7–1,2) và `seed`. ElevenLabs
  không nhận style dạng văn bản tự do; dùng `settings.style` hoặc audio tag của
  v3. Format là các output format `mp3_*` và `pcm_*`; μ-law bị loại.
- `settings.style` của ElevenLabs chỉ được nhận bởi `eleven_multilingual_v2`,
  còn `use_speaker_boost` chỉ bởi `eleven_multilingual_v2` và
  `eleven_v3_conversational`; model khác sẽ bỏ qua chúng nên profile bị từ chối.
  Giới hạn lấy từ bảng capability trong `src/providers/elevenlabs/models.ts`.
- Output của Gemini trong scene chỉ là `wav`.
- Ký tự được đếm theo Unicode code point. `--max-chars` (tối thiểu 20) tách câu
  ở mức thấp hơn giới hạn của model. Một câu thoại được tách ở chỗ hết câu (`.`,
  `!` hoặc `?` theo sau là khoảng trắng, nên `3.5` được giữ nguyên), sau đó ở
  khoảng trắng, và không bao giờ tách bên trong tag `<…>` hay `[…]`. `plan` từ
  chối phần nào chứa tag chưa đóng hoặc tag dài hơn giới hạn.
- `--language` được lưu trong mọi profile nhưng chỉ được gửi tới các model ở cột
  "Gửi ngôn ngữ", dưới dạng subtag chính (`vi-VN` được gửi là
  `language_code: vi`). `eleven_multilingual_v2` không áp dụng language code,
  nên profile có `--language` trên model này bị từ chối; hãy bỏ `--language`
  hoặc chọn model có áp dụng. Với Gemini và OpenAI, ngôn ngữ chỉ được lưu để
  tham khảo.
- Output PCM thô được bọc header WAV để mọi phần mềm dựng đều mở được stem.

## Biên nhận chi phí

Mỗi take ghi `usage`: số ký tự đã gửi cùng `cost_usd` và `credits` mà provider
báo cho riêng request đó. Khi provider không báo, giá trị là `null` (không rõ),
không bao giờ là `0`. Ví dụ, ElevenLabs báo credit còn OpenAI TTS không báo gì.
`status` cộng chi phí trên mọi take, kể cả biến thể bị loại, và đếm các take
không rõ chi phí trong `unknown_cost_takes`.

`scene` chưa có bộ ước tính chi phí trước khi chạy, nên `plan` trả
`estimated_cost_usd: null`. `scene render --estimate` báo chi phí là không rõ và
không gửi gì, còn `--max-cost` từ chối chạy với `BUDGET_UNPROVEN` (exit 2), kể
cả khi có `--cost-policy estimate`. Dùng `to_render_chars` để tự ước tính chi
phí, hoặc ước tính giá một câu bằng `elevenlabs tts --estimate` hay
`gemini generate-speech --estimate`.

## JSON và dry run

Mọi lệnh `scene` đều nhận `--json` (một envelope `multix.result/v1` trên stdout;
dữ liệu của lệnh nằm trong `data`) và `--dry-run`.

- `render --dry-run` chạy mọi kiểm tra local và kiểm tra key. Sau đó lệnh in
  request đầu tiên tới provider thay vì gửi đi, và không ghi manifest.
- `voice add`, `plan`, `approve`, `reject` và `export` với `--dry-run` chỉ kiểm
  tra hợp lệ và báo `written: false` mà không thay đổi file.

## Giới hạn

- Mỗi câu thoại một request. Chưa hỗ trợ tổng hợp nhiều người nói trong một
  request.
- Khi bật `--context` (các model ElevenLabs v2), request của mỗi câu kèm lời
  thoại của các câu lân cận. Vì vậy sửa một câu cũng làm mất hiệu lực take của
  câu ngay trước và ngay sau nó.
- Không fallback ngầm sang provider khác. Một câu được render bằng provider
  trong profile của nó, hoặc báo lỗi.
- Lệnh scene không chạy qua [MCP server từ xa](/vi/guides/mcp-server/). Chúng bị
  loại khỏi catalog vì project nằm trong một thư mục local qua nhiều lần chạy,
  còn job container bị hủy sau mỗi lần chạy.
- multix không phải DAW. Nó tạo stem cho từng câu và `scene-export.json`; căn
  thời gian, mix và hiệu ứng được làm trong phần mềm dựng của bạn.

## Ví dụ đầy đủ

```bash
mkdir phim-ngan && cd phim-ngan
mkdir scripts
cat > scripts/s01.txt <<'EOF'
# scene: s01
# title: Sân thượng lúc bình minh
HIRO: Cuối cùng em cũng đến.
MAI: Suýt nữa em không đến.
HIRO (nhẹ nhàng): Vậy mình đi bộ.
EOF

multix scene voice add hiro --provider openai --model gpt-4o-mini-tts --voice cedar
multix scene voice add mai --provider elevenlabs --model eleven_flash_v2_5 \
  --voice kdmDKE6EkgrWrrykO9Qt --language vi-VN --setting stability=0.5

multix scene plan scripts/s01.txt
multix scene render --dry-run          # miễn phí: hiển thị request đầu tiên
multix scene render                    # 3 request
# Sửa câu của MAI trong scripts/s01.txt, rồi:
multix scene render                    # 1 request: chỉ s01/002
multix scene approve s01/001 s01/002 s01/003
multix scene export --out stems --approved-only
```
