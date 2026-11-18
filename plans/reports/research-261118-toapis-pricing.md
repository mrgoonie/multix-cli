# Nghiên cứu giá ToAPIs (toapis.com) so với provider multix-cli

Ngày: 2026-11-18 (Asia/Saigon). Phạm vi: chỉ nghiên cứu, không sửa code, không mở PR.

## Kết luận nhanh

- **Không có test thật.** Không tìm thấy `TOAPIS_API_KEY` trong `.env` của repo hay `~/.multix/.env`; `ak secrets` không chạy được trong shell (lỗi môi trường `fnm`). Chi phí đã tiêu: **$0**. Mọi con số $/giây bên dưới là **ước tính**, không phải đo từ `usage.total_tokens` thực.
- Tuy vậy, các ước tính này có cơ sở mạnh: chính API báo giá công khai của ToAPIs (`POST https://toapis.com/api/sku/quote/batch`, không cần đăng nhập) trả về trường `estimated_second_price` cho Seedance, ghi chú là "dựa trên P75 của `usage.total_tokens` trên production, cộng 20% dự phòng khi pre-authorize, quyết toán theo `total_tokens` thực". Con số này khớp với công thức token chính thức của BytePlus trong sai số ~5%.
- **Seedance trên ToAPIs rẻ hơn BytePlus ModelArk chính thức**: 2.0 và 2.5 rẻ hơn ~6–10%, 2.0 Fast rẻ hơn ~26%, 2.0 Mini rẻ hơn ~46% (so theo đơn giá token, không video input).
- Ảnh Gemini/GPT trên ToAPIs rẻ hơn giá chính thức 44–90%, nhưng đó là các biến thể "preview"/"vip"/"flare"/"sunburst" không rõ nguồn gốc (gần như chắc chắn là kênh không chính thức). Các biến thể `-official` của ToAPIs tính theo token, không còn rẻ đột biến.
- Đề xuất: **đáng mở một issue thảo luận** tích hợp ToAPIs như provider tùy chọn cho Seedance 2.x (2.0 Fast/Mini đặc biệt rẻ), kèm cảnh báo rủi ro reseller. Chưa nên dùng các model ảnh/video "rẻ bất thường" làm mặc định.

## 1. Cách ToAPIs tính giá

Nguồn: https://toapis.com/pricing (dữ liệu nhúng của trang và API `/api/sku/quote/batch`, truy cập 2026-11-18).

- Nền tảng là một bản fork kiểu New-API/One-API: mỗi model có `quota_type` (0 = theo token, 1 = theo request, 2 = theo giây), `model_ratio`, `model_price`. Với video theo token, giá $/1M = `model_ratio` × $2 (ví dụ `seedance-2-5` có ratio 5 → $10/1M).
- Trang ghi "1 credit ≈ $0.005" và "Every price below is the actual rate you pay".
- **Bẫy đọc bảng giá:** với model tính theo giây, `display_price` của API báo giá là **tổng tiền = đơn giá/giây × duration** (mặc định 1 giây nếu không truyền `duration`; một số model như grok có duration mặc định khác). Mọi giá $/s trong báo cáo này đã chia cho duration = 5 đã truyền. Ví dụ `Veo3.1-lite-official` 720p: không truyền duration → $0.024; truyền 5 → $0.12 → $0.024/s.
- Video Seedance 2.x tính theo `total_tokens`, các model khác theo giây hoặc theo request.

## 2. Công thức token Seedance (đã kiểm chứng tài liệu chính thức)

Nguồn: BytePlus ModelArk Pricing, https://docs.byteplus.com/en/docs/ModelArk/1544106 (truy cập 2026-11-18):

> Estimated token consumption: (Input video duration + output video duration) × output width × output height × output frame rate / 1024. Actual consumption is determined by usage.completion_tokens.

Ngoài ra khi có video đầu vào áp dụng mức token tối thiểu theo bảng riêng. Với 24 fps, 16:9: 480p (864×496) ≈ 10 044 tokens/s, 720p (1280×720) = 21 600 tokens/s, 1080p (1920×1080) = 48 600 tokens/s.

Kiểm chéo với ToAPIs (`seedance-2-5`, $10/1M): 720p → 21 600 × $10/1M = $0.216/s; ToAPIs báo $0.2158/s. 1080p ($11/1M) → $0.535/s; ToAPIs báo $0.5353/s. 480p → $0.100/s; ToAPIs báo $0.0961/s. Khớp.

## 3. Bảng giá video ToAPIs (16:9, quy đổi $/giây)

"Ước tính" = `estimated_second_price` của ToAPIs (P75). Cột "vin" = có video đầu vào (đơn giá token thấp hơn, nhưng số token cộng thêm thời lượng video đầu vào nên $/s đầu ra thực tế có thể cao hơn; ToAPIs vẫn ước tính thấp hơn).

| Model ToAPIs | $/1M tokens (480p·720p / 1080p) | 480p $/s | 720p $/s | 1080p $/s | vin $/1M (480/720p) |
|---|---|---|---|---|---|
| seedance-2-5 | 10 / 11 | 0.096 | 0.216 | 0.535 | 6.0 |
| seedance-2-5-flash | 6.3 / — | 0.061 | 0.136 | không hỗ trợ | 3.87 |
| seedance-2 | 6.571 / 7.286 | 0.063 | 0.142 | 0.355 | 4.0 |
| seedance-2-fast | 4.142 / — | 0.040 | 0.090 | không hỗ trợ | 2.463 |
| seedance-2-mini | 1.888 / — | 0.019 | 0.041 | không hỗ trợ | 1.149 |
| seedance-2-fast-ext / seedance-2.5-ext | theo request | $0.50/req | $0.50/req | $0.50/req | — |
| doubao-seedance-1-5-pro | theo giây | 0.0204 | 0.044 | 0.108 | — |
| doubao-seedance-1-0-pro-fast | theo giây | 0.0088 | 0.020 | 0.0416 | — |
| grok-video-1.5 | theo giây | 0.0102 | 0.0191 | — | — |
| wan3.0-video | theo giây | 0.0329 | 0.0658 | 0.1315 | — |
| wan3.0-video-prime | theo giây | 0.0514 | 0.1029 | 0.2057 | — |
| happyhorse-1.1 | theo giây | — | 0.0643 | 0.0857 | — |
| kling-v3 / kling-v3-omni / kling-video-o1 | theo giây | 0.06 | 0.06 | 0.06 | — |
| kling-v2-6 | theo giây | 0.0322 | 0.0322 | 0.0322 | — |
| kling-4.0 | theo giây | — | 0.157 | 0.235 | — |
| Veo3.1-lite-official | theo giây | 0.024 | 0.024 | 0.04 | — |
| Veo3.1-fast-official | theo giây | 0.08 | 0.08 | 0.096 | — |
| Veo3.1-quality-official | theo giây | 0.32 | 0.32 | 0.32 | — |
| veo3.1-lite / veo3.1-fast (không official) | theo request (8s) | $0.07 / $0.14 mỗi video | | | — |

Ghi chú: (a) giá kling/wan/v.v. không đổi khi bật/tắt `generate_audio` trong API báo giá, nên báo cáo không xác định được phụ phí audio; (b) "—" là API báo giá trả lỗi `invalid_input` (resolution không hỗ trợ). Toàn bộ 51 model video và tham số thô nằm trong dữ liệu trang pricing; bảng trên giữ các model có liên quan đến multix.

## 4. So sánh Seedance với BytePlus (provider multix `byteplus`)

multix hỗ trợ `seedance-2.0`, `seedance-2.0-fast`, `seedance-2.0-pro` qua `src/providers/byteplus/models.ts`, và `bytedance/seedance-2.0`, `-2.0-fast`, `-2.0-mini`, `-2.5` qua OpenRouter (`src/providers/openrouter/commands/image-to-video.ts`). Giá chính thức BytePlus (không video input, online inference), nguồn https://docs.byteplus.com/en/docs/ModelArk/1544106, kiểm chứng 2026-11-18.

| Model | Resolution | ToAPIs $/1M | BytePlus $/1M | ToAPIs $/s (ước tính) | BytePlus $/s (ví dụ chính thức, 5s) | Chênh lệch |
|---|---|---|---|---|---|---|
| Seedance 2.5 | 480p / 720p | 10.0 | 10.70 | 0.096 / 0.216 | 0.103 / 0.231 | −6.5% |
| Seedance 2.5 | 1080p | 11.0 | 11.7 | 0.535 | 0.569 | −6.0% |
| Seedance 2.5 Flash | 480p / 720p | 6.3 | 7.0 | 0.061 / 0.136 | 0.07 / 0.15 | −10% |
| Seedance 2.0 | 480p / 720p | 6.571 | 7.0 | 0.063 / 0.142 | 0.07 / 0.15 | −6.1% |
| Seedance 2.0 | 1080p | 7.286 | 7.7 | 0.355 | 0.37 | −5.4% |
| Seedance 2.0 Fast | 480p / 720p | 4.142 | 5.6 | 0.040 / 0.090 | 0.06 / 0.12 | −26% |
| Seedance 2.0 Mini | 480p / 720p | 1.888 | 3.5 | 0.019 / 0.041 | 0.04 / 0.08 | −46% |
| Seedance 1.0 Pro Fast | 720p | ≈ $0.02/s | 1.0 | 0.020 | ≈ 0.020 (102 960 tokens/5s) | ≈ 0% |

Với video đầu vào, BytePlus có bảng giá và mức token tối thiểu riêng (tab "Input with video") mà báo cáo chưa trích được; ToAPIs áp đơn giá ≈ 60% đơn giá không video input. Giá OpenRouter cho Seedance chưa được đối chiếu.

## 5. So sánh Veo và ảnh

| Model | Cấu hình | ToAPIs | Giá chính thức | Nguồn chính thức | Chênh lệch |
|---|---|---|---|---|---|
| Veo 3.1 Lite (`Veo3.1-lite-official`) | 720p | $0.024/s | $0.05/s | Thứ cấp: https://the-decoder.com/googles-veo-3-1-lite-cuts-video-generation-costs-by-more-than-half/ (chưa đọc được bảng Veo trên trang chính thức) | −52% |
| Veo 3.1 Lite | 1080p | $0.04/s | $0.08/s | như trên | −50% |
| Veo 3.1 Fast (`Veo3.1-fast-official`) | 720p / 1080p | $0.08 / $0.096/s | $0.10 / $0.12/s | như trên | −20% |
| Nano Banana Pro (`gemini-3-pro-image-preview`) | 1K·2K / 4K | $0.04–0.05 / $0.06 | $0.134 / $0.24 | https://aistudio.google.com/docs/pricing (2026-11-18) | −63% đến −75% |
| Nano Banana 2 (`gemini-3.1-flash-image-preview`) | 0.5K / 1K / 2K / 4K | $0.025 / 0.025 / 0.03 / 0.04 | $0.045 / 0.067 / 0.101 / 0.151 | như trên | −44% đến −74% |
| Nano Banana (`gemini-2.5-flash-image-preview`) | 1K | $0.012 | $0.039 | như trên | −69% |
| gpt-image-2 | 1K / 2K / 4K | $0.015 / 0.02 / 0.025 | $0.053 (theo cột "Official API" của ToAPIs) | Trang OpenAI trả 403, chưa kiểm chứng | ≈ −72% (chưa xác minh) |
| Seedream 4.5 | 1 ảnh | $0.0357 | $0.04 | BytePlus pricing (2026-11-18) | −11% |
| Seedream 4.0 | 1 ảnh | $0.0285 | $0.03 | như trên | −5% |
| Seedream 5.0 pro | ≤1.5K / >1.5K | $0.0429 / $0.0857 | $0.045 / $0.09 | như trên | −5% |
| Seedream 5.5 | 1K / 2K | $0.016 / $0.028 | $0.020 / $0.035 (+$0.008 mỗi ảnh đầu vào) | như trên | −20% |

multix đang có các model này qua: `gemini` (Veo trong `src/providers/gemini/veo.ts`, ảnh Gemini), `openai` (`gpt-image-2` mặc định), `byteplus` (`seedream-4-0-250828` mặc định), `openrouter` (`google/veo-3.1`), `minimax` (Hailuo 2.3/02), `leonardo` (kling-2.6/3.0/O1/O3, hailuo-2_3). `src/capabilities/model-registry.ts` không lưu giá, nên giá "multix hiện có" ở đây là giá chính thức của provider gốc.

Giá MiniMax Hailuo và Kling trên ToAPIs: API báo giá trả lỗi cho mọi resolution của Hailuo, còn Kling không có bảng giá chính thức tương ứng được kiểm chứng trong lần này, nên không đưa vào bảng chênh lệch.

## 6. Đánh giá

**Có rẻ hơn thật không?** Với Seedance, có, và mức giảm nhỏ, hợp lý (6–10%) cho 2.0/2.5, lớn hơn cho Fast/Mini. Đây là giá theo token quyết toán theo usage thật, nên sát với chi phí thực. Với ảnh Gemini/GPT và Veo, mức giảm 50–90% là bất thường với một reseller; nhiều khả năng đi qua tài khoản/kênh không chính thức (tên như "preview", "vip", "flare", "sunburst"), nên rủi ro ổn định và chính sách cao hơn.

**Model đáng cân nhắc:** `seedance-2-mini`, `seedance-2-fast`, `seedance-2-5-flash` (rẻ nhất cho draft 480p/720p), và `Veo3.1-lite-official` nếu cần Veo giá thấp.

**Rủi ro:**
- Reseller: không có SLA công khai trong tài liệu đã đọc; không rõ chính sách hoàn tiền khi lỗi (FAQ trên trang có mục "Are failed requests billed?" nhưng chưa đọc được nội dung).
- ToS của Google/OpenAI/ByteDance thường cấm bán lại quyền truy cập; dùng kênh "preview/vip" có thể vi phạm điều khoản gốc và có thể bị cắt bất kỳ lúc nào.
- Pre-authorize cộng 20% dự phòng trên P75, nên số dư bị giữ tạm cao hơn giá thực.
- Đơn vị credit (1 credit ≈ $0.005) chỉ là quy đổi hiển thị; có nhóm giá `default/vip/svip`, giá có thể khác theo nhóm tài khoản.
- Một phần mô tả model bằng tiếng Trung; có domain `toapis.cn` cho Trung Quốc đại lục.

**Công sức tích hợp:** Thấp đến trung bình. Theo https://docs.toapis.com/, API dùng Bearer token, base URL `https://toapis.com`, text tương thích OpenAI (`/v1/chat/completions`), còn ảnh và video là API bất đồng bộ riêng: `POST /v1/images/generations` và `POST /v1/videos/generations` (trường `model`, `prompt`, `duration`, `aspect_ratio`, `resolution`), poll `GET .../{task_id}`. Một client kiểu job-poll giống `byteplus`/`atlascloud` là đủ, không cần SDK.

## 7. Điều kiện để test thật

Cần `TOAPIS_API_KEY` (lưu qua `ak secrets` hoặc `~/.multix/.env`) và số dư khoảng $1. Kế hoạch tiêu ≤ $0.5: một video `seedance-2-mini` 480p 4–5s (≈ $0.10 sau dự phòng) và một `seedance-2-fast` 480p (≈ $0.20), đọc `usage.total_tokens` và log khấu trừ trong console để so với công thức ở mục 2.

## 8. Đề xuất nội dung GitHub issue (chưa tạo)

**Tiêu đề:** `feat(toapis): evaluate ToAPIs as an optional reseller provider for Seedance 2.x`

**Nội dung:** ToAPIs bán Seedance 2.0/2.5 theo token rẻ hơn BytePlus 6–10% (2.0 Fast −26%, 2.0 Mini −46%), quyết toán theo `usage.total_tokens`. API ảnh/video bất đồng bộ (`/v1/videos/generations` + poll). Việc cần: (1) test thật ≤ $1 để xác nhận token và khấu trừ; (2) đọc ToS, chính sách hoàn tiền lỗi; (3) nếu ổn, thêm `src/providers/toapis/` (client không dùng `node:*`), chỉ đăng ký các model Seedance có nguồn kiểm chứng, đánh dấu rõ là reseller trong docs và `--help`. Ngoài phạm vi: các model ảnh/Veo "preview/vip" giá bất thường. Báo cáo nguồn: `plans/reports/research-261118-toapis-pricing.md`.

## Câu hỏi còn mở

- Giá Seedance khi có video đầu vào trên BytePlus và mức token tối thiểu chưa được trích.
- Giá Veo 3.1 trên trang chính thức Google chưa đọc được trực tiếp; đang dùng nguồn thứ cấp.
- Giá gpt-image-2 chính thức chưa xác minh (OpenAI trả 403).
- Phụ phí audio của các model tính theo giây trên ToAPIs chưa xác định.

## Đối chiếu sau khi chạy thực tế (2026-11-18)

- Video `seedance-2-mini` 480p 4 s: `usage.total_tokens` = 40 594, đúng công thức 864 × 496 × (24 × 4 + 1) / 1024. ToAPIs tính $0.076642, tức $1.888/1M, khớp bảng ở mục 2. Ước tính của multix trước khi chạy là $0.0766.
- Tổng chi cho mọi lần chạy thử (ảnh Seedream và video) là $0.1653; receipt ghi lại `billing.cost_usd` mà ToAPIs quyết toán.
- Kết luận về giá ở trên vẫn đúng. Bảng chỉ phản ánh giá niêm yết của nhóm tài khoản mặc định vào ngày kiểm tra; ToAPIs có thể đổi giá, nên `multix toapis quote` là nguồn kiểm tra lại.
