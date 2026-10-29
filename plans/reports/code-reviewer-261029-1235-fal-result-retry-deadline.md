# Code review: fal retry khi lấy kết quả + timeout theo deadline (#514)

- Nhánh: `claude/relaxed-clarke-id4env`, diff `origin/dev...HEAD` (commit 0ce1ae5 + merge 3372f9b)
- File: `src/providers/fal/run-helpers.ts` (+59/-14), `tests/unit/providers/fal/run-helpers.test.ts` (+83), `docs-site/src/content/docs/commands/fal.md`, `docs-site/src/content/docs/vi/commands/fal.md`
- Reviewer độc lập, không viết code này. Ngày 2026-10-29 (UTC).

## Kiểm chứng đã chạy

- `npx vitest run tests/unit/providers/fal`: 155 passed, 2 skipped. Chạy `run-helpers.test.ts` 3 lần liền: 40/40 mỗi lần, không flaky.
- `npx tsc --noEmit`: sạch.
- `npx biome check` hai file đổi: sạch.
- `grep -rn "run-helpers\|providers/fal" worker/src`: worker chỉ import `src/providers/fal/speech-models.js` (`worker/src/jobs/catalog-view.ts:23`). Không có gì trong worker import `run-helpers.ts`, nên không cần `check:mcp`.

## Đánh giá chung

Vòng retry đúng về mặt cơ học: luôn có ít nhất một lần gọi result (kể cả khi deadline đã qua), không có busy loop (`retryDelayMs` >= 1 ms, thực tế >= `intervalMs` = 3 s), không lặp vô hạn (chỉ lặp khi `deadline - Date.now() > 0`, mỗi vòng ngủ hoặc tốn thời gian request). Lỗi cuối được bọc kèm `cause`, nên `classifyError` giữ đúng class (đã có test cho 429/RATE_LIMITED). GET `response_url` idempotent, không submit lại, nên không có rủi ro tính tiền hai lần hay trả nhầm output. Docs EN/VI khớp code và khớp nhau.

Có một vấn đề hành vi đáng kể: theo spec của fal, endpoint result trả **500 khi chính job thất bại**, và code mới coi đó là lỗi tạm thời.

## Critical

Không có.

## High

### H1. Job thất bại (fal trả 500/504 trên `response_url`) bị retry tới hết `--wait-timeout` thay vì báo lỗi ngay

- Vị trí: `src/providers/fal/run-helpers.ts:206-224` (vòng result), điều kiện ở `:214`.
- Bằng chứng: tài liệu queue result của fal (https://fal.ai/docs/inference-api/queue/result.md) ghi rằng result endpoint trả **500** khi "The model or the platform failed", **504** khi "The request did not start before the `X-Fal-Request-Start-Timeout` deadline", 422 khi input bị từ chối. Status response ở trạng thái `COMPLETED` có thêm `error` / `error_type` khi job thất bại (https://fal.ai/docs/model-apis/model-endpoints/queue). `isTransientHttpError` (`src/core/async-poll.ts:57-71`) coi 500 và 504 là lỗi tạm thời.
- Kịch bản lỗi: `multix fal video ...` (mặc định `--wait-timeout` 900000). Model crash sau 20 s, status trả `COMPLETED` kèm `error`, rồi `response_url` trả 500. Trước đây lệnh dừng ngay với "Failed to fetch result ... HTTP 500". Giờ CLI gọi lại `response_url` khoảng mỗi 3 s trong ~14.7 phút (khoảng 290 request), rồi mới báo cùng lỗi đó. Với `fal run` / `image` / `tts` (480 s) là khoảng 7.5 phút. Một agent gọi CLI sẽ treo tới hết ngân sách chờ cho một lỗi tất định. Không gây tính tiền lặp, nhưng là regression thật về UX/latency và tạo tải thừa lên fal.
- Hướng sửa (chọn một):
  1. Giữ `statusRes` của lần poll `COMPLETED` (đã có `break` ở `:200`). Thêm `error?: string; error_type?: string` vào `FalStatusResponse` (`src/providers/fal/types.ts:17`). Nếu `statusRes.error` có giá trị thì gọi result đúng một lần, không retry (hoặc ném luôn lỗi kèm `error_type` + resume hint).
  2. Hoặc chỉ retry kết quả với tập hẹp hơn: status 0, 408, 429, 502, 503 (lỗi transport/gateway). Không retry 500/504, vì chúng là kết cục của job.
  Thêm test: status `COMPLETED` + `error`, result 500 thì `fetches === 1`. Test hiện tại "wraps a result-fetch failure with the request id" (`tests/unit/providers/fal/run-helpers.test.ts:254`) đang dùng đúng kịch bản 500 này, nhưng chỉ chạy nhanh nhờ `waitTimeoutMs: 50` được thêm vào. Đó là dấu hiệu hành vi đã đổi mà test chưa khẳng định điều gì về nó.

## Medium

### M1. Sàn timeout 10 s có thể làm hỏng lần lấy result lớn sát deadline (regression so với 120 s cố định)

- Vị trí: `src/providers/fal/run-helpers.ts:129-134`, áp dụng ở `:208-211`.
- Kịch bản: job xong lúc còn ~1 s trước deadline. Trước đây lần GET result có 120 s, giờ chỉ còn 10 s (timeout của `fetchJson` bao cả phần đọc body, `src/core/fetch-json.ts:100,132`). Result thường là JSON nhỏ (media tải riêng qua `downloadResultMedia`, có timeout riêng), nên đa số trường hợp không sao. Nhưng `fal run --input` cho phép `sync_mode: true`, khi đó fal trả ảnh/audio dạng data URI ngay trong JSON, có thể vài chục MB. Trên mạng chậm, 10 s không đủ. Timeout biến thành `HttpError(0)`, và vì deadline đã qua nên ném lỗi ngay. Người dùng phải chạy `multix fal result` (vẫn dùng 120 s). Thêm nữa, fal chỉ giữ result >= 10 KB trong 6 phút, nên cửa sổ resume ngắn.
- Mức chấp nhận: có thể chấp nhận vì có resume hint và đây là đánh đổi có chủ đích (không vượt deadline quá xa). Nhưng nên sửa rẻ: ngân sách deadline chỉ nên giới hạn *chờ* job, không nên giới hạn lần lấy kết quả đầu tiên của một job đã xong và đã tính tiền. Đề xuất: lần result đầu tiên dùng `MAX_REQUEST_TIMEOUT_MS`; các lần retry sau mới dùng `requestTimeoutMs(deadline)`. Hoặc nâng sàn riêng cho result (ví dụ 60 s). Nếu giữ nguyên thì docs nên nói rõ.

## Low

### L1. Sau khi sleep bị cắt theo deadline, vòng result vẫn thử thêm một lần ngay tại deadline

- Vị trí: `src/providers/fal/run-helpers.ts:214-216`. Khi `Retry-After` (ví dụ 30 s) lớn hơn thời gian còn lại, `retryDelayMs` ngủ đến đúng deadline rồi `continue` gọi lại (với timeout 10 s), gần như chắc chắn vẫn 429. Vô hại, nhưng không nhất quán với vòng status (kiểm tra `remaining <= 0` *trước* khi gọi). Sửa: sau `sleep`, nếu `Retry-After > thời gian còn lại` thì ném luôn lỗi gốc. Hoặc kiểm tra `deadline - Date.now() > retryDelay` trước khi ngủ.

### L2. Thiếu test cho các ranh giới chính của vòng result

- `tests/unit/providers/fal/run-helpers.test.ts:338` chỉ phủ "503 một lần rồi thành công". Chưa có test cho: (a) lỗi tạm thời kéo dài tới hết deadline thì lỗi cuối là `Failed to fetch result ...` có `cause` là `HttpError(503)` và `classifyError` đúng `http_status`; (b) deadline đã qua lúc COMPLETED thì vẫn gọi result đúng một lần; (c) số lần gọi bị chặn (không busy loop). Test 429 (`:320`) gián tiếp phủ (a) nhưng không đếm số lần fetch. Nên dùng fake timers như test 429 trên status poll để khẳng định số lần fetch và khoảng ngủ.
- Test timeout (`:373`) dùng đồng hồ thật với ngưỡng `> 29_000` trên ngân sách 30 s. Chỉ flaky nếu event loop treo > 1 s; chấp nhận được. Nó khẳng định đúng các giá trị kẹp 120 000 / 10 000.

### L3. Lịch sử nhánh chứa merge commit và các commit của #513

- `git log origin/dev..HEAD` có merge 3372f9b và các commit 5e26971/b0b1bf1/146cec4 (nội dung đã có trên `dev` qua 309c6d5, nên diff ba chấm sạch). Nếu PR không squash, changelog của release-please có thể lặp mục "fix(fal): wait out a rate-limited status poll...". Nên rebase lên `origin/dev` để chỉ còn 0ce1ae5, hoặc đảm bảo squash merge.

### L4. `FalClient.getAbsolute` giờ chỉ còn test dùng

- `src/providers/fal/client.ts:145`: không còn caller nào trong `src/`, chỉ `tests/unit/providers/fal/client.test.ts:52,61`. Không phải lỗi, nhưng nên ghi nhận (xoá hoặc chuyển test sang `requestAbsolute`) trong một thay đổi riêng, không mở rộng PR này.

## Docs

- EN `docs-site/src/content/docs/commands/fal.md:218-224` và VI `docs-site/src/content/docs/vi/commands/fal.md:218-224` khớp nhau và khớp code: retry 0/408/429/5xx trừ 501, 505 cho cả status poll lẫn result fetch; timeout mỗi request = thời gian còn lại, kẹp [10 s, 120 s]. `README.md`, `skill/` không nói tới chi tiết retry này, nên không cần sửa. `--help` không đổi.
- Nếu sửa H1 thì docs cần thêm: job thất bại (500/504 từ result) không được retry.

## Checklist

- Concurrency: không có trạng thái chia sẻ. Vòng lặp tuần tự. OK.
- Error boundaries: mọi lỗi được bọc kèm `cause`, giữ class. OK.
- API contracts: `waitForFalResult` không đổi signature. Callers (`run.ts:121`, `tts.ts:121`, `image.ts`/`video.ts` qua `submitAndWait`) không bị ảnh hưởng ngoài thời gian chờ (xem H1).
- Backward compat: không đổi export. Hành vi lỗi đổi như H1/M1.
- Auth/trust boundary: vẫn qua `requestAbsolute` nên vẫn `assertTrustedFalUrl`. Không log key hay URL ký (dùng `redactUrl`).
- Billing: GET result idempotent, không resubmit. Không có rủi ro tính tiền hai lần.
- Worker: không import `run-helpers.ts`.

## Đề xuất theo thứ tự

1. Sửa H1: không retry result khi status `COMPLETED` có `error`, hoặc không retry 500/504 trên result. Thêm test.
2. Cân nhắc M1: lần GET result đầu tiên dùng 120 s.
3. Bổ sung test L2. Dọn lịch sử nhánh (L3).

## Câu hỏi mở

- Hành vi thực tế của fal: một job thất bại có luôn trả 500 trên `response_url` không, hay đôi khi trả 200 kèm `detail`? Spec nói 500. Nên xác nhận bằng một request thất bại thật (chạy thủ công, có opt-in) trước khi chọn cách sửa 1 hay 2 cho H1.

Nguồn: https://fal.ai/docs/inference-api/queue/result.md, https://fal.ai/docs/model-apis/model-endpoints/queue, https://fal.ai/docs/documentation/model-apis/request-errors
