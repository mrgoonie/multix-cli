# Code review: 19946a4 fix(errors): fal result + MiniMax i2i errors propagate (issue #492)

## Phạm vi
- Files: src/providers/fal/commands/result.ts, src/providers/minimax/commands/image-to-image.ts, tests/unit/providers/fal/commands.test.ts, tests/unit/providers/minimax/image-to-image-errors.test.ts
- LOC: +101 / -17
- REVIEW.md: không có trong repo root.

## Đánh giá tổng quan
Thay đổi đúng, tối thiểu, khớp mẫu của PR #491. Không có lỗi chặn.

## Truy vết luồng lỗi (đã kiểm chứng)
1. Action throw -> `program.parseAsync(...)` reject -> `.catch(exitWithError)` (src/cli.ts:30).
2. `exitWithError` -> `finalizeRun({ exitCode: 1, error })` (src/agent/agent-runtime.ts:469-471).
3. `finalizeRun` gọi `classifyError(input.error)` khi có error (agent-runtime.ts:231-233), nên HttpError giữ `http_status` và `retry_after_s` vào envelope `--json` và history.
4. `nameJob(requestId)` chạy trước request (result.ts:53), nên envelope vẫn có job id.

## Request id của fal còn hiển thị không
- HttpError: message = `HTTP <status> from ${redactUrl(url)}: ...` (src/core/errors.ts:108). `redactUrl` giữ origin + pathname, path là `/<owner>/<alias>/requests/<id>` -> id có trong message. `build()` trong error-classify chỉ chạy `redactUrlsInText`, vẫn giữ path.
- Lỗi mạng: `fetchFollowingRedirects` (wrapNetworkErrors) -> `toFetchError(cause, url)`; nhánh mặc định là `HttpError(0, detail, url)` -> message có URL nên có id. Các nhánh ConfigError/ProviderError dùng `target = redactUrl(url)` -> cũng có id.
- Body đọc lỗi / JSON lỗi trong fetch-json.ts: đều là HttpError có url -> có id.
- Kết luận: yêu cầu "giữ request id" của issue được đáp ứng, không cần bọc lại.

## Rò rỉ secret / URL
- Không có. `redactUrl` bỏ userinfo (dùng `u.origin`) và query string; header `authorization: Key ...` không bao giờ vào message (nhánh header của toFetchError không in giá trị). `rawUrl` là non-enumerable.
- MiniMax: URL `api.minimax.io/v1/image_generation` không có secret. Prompt không vào message lỗi.

## Thay đổi hành vi với người dùng (không phải agent)
- Trước: `✗ Failed to fetch result for fal request <id>: HTTP 429 from ...` rồi exit 1; phân loại từ log line (mất retry_after_s).
- Sau: `finalizeRun` in `Error: HTTP 429 from https://queue.fal.run/<app>/requests/<id>: ...` (chỉ khi chưa có lastErrorLine — với 2 lệnh này không có dòng lỗi nào trước request) + `code:`/`hint:` có thêm `retryable after 30s`. Exit code không đổi ở chế độ text (1); ở `--json` exit code theo phân loại như trước (429 vẫn RATE_LIMITED). Lỗi mạng giờ là NETWORK_ERROR từ class thay vì đoán từ text.
- Không còn tiền tố "Failed to fetch result for fal request <id>" — chấp nhận được vì id nằm trong URL. Không có doc nào trích dẫn chuỗi cũ (grep đã kiểm). Documentation impact: N/A.

## Critical
Không có.

## High
Không có.

## Medium
1. Cùng lỗi gốc vẫn còn ở đường submit-and-wait của fal: src/providers/fal/run-helpers.ts:164-165 và :174-177 bọc lỗi bằng `new Error(...)` thuần, làm mất HttpError class và `retryAfterMs` (classifyMessage vẫn bắt được `HTTP 429` nhưng mất `retry_after_s`; HTTP 0 bị đoán từ text). Ngoài phạm vi #492 — nên mở issue riêng (giữ `cause` hoặc dùng error có class, ví dụ thêm resumeHint mà vẫn giữ HttpError).
2. Mẫu catch -> process.exit(1) sau request còn ở: leonardo/commands/status.ts:85, leonardo/commands/video.ts:156, byteplus/commands/{image-to-video.ts:125,status.ts:80,reference-to-video.ts:147}, openrouter/commands/{image-to-video.ts:107,video-status.ts:108}, gemini/commands/generate.ts:122 (cần xác minh khối này có phải request error không). Theo AGENTS.md: mở issue riêng, không mở rộng PR này.

## Low
1. Test fal chỉ phủ HTTP 429; không có test lỗi mạng (`TypeError("fetch failed")`) khẳng định request id có trong message HttpError(0) — đây chính là trường hợp issue nêu ("nếu chưa có trong lỗi throw"). Nên thêm 1 case.
2. Test MiniMax không khẳng định fetch được gọi tới `image_generation` (stub fetch trả 429 cho mọi URL). Hiện đúng vì `resolveImageInput` trả URL http nguyên trạng (src/core/image-input.ts:91), nhưng test sẽ vẫn pass nếu lỗi đến từ một fetch khác. Nên ghi lại URL được gọi.
3. Cả hai test kiểm `classifyError(error)` trực tiếp, không qua `finalizeRun`/envelope. Chấp nhận được vì luồng cli.ts -> exitWithError -> finalizeRun -> classifyError là chung và đã có test riêng; không phải phantom test (có assert `process.exit` không được gọi và metadata 429/30s).
4. Các nhánh `process.exit(1)` không phải lỗi request còn lại trong file đã sửa (result.ts:87-88 "none downloaded", image-to-image "No images in response") sẽ phân loại UNKNOWN từ log line. Ngoài phạm vi, chỉ ghi nhận.

## Edge cases từ scout
- Telemetry: khi throw, hook postAction (settleTelemetry) không chạy; finalizeRun dùng `recordUnfinishedCalls()`. Giống hệt gemini generate (#491), không phải hồi quy mới.
- FAL_BASE_URL proxy có userinfo: `redactUrl` dùng origin nên không lộ credential.
- Redirect cross-origin bị từ chối -> HttpError 3xx có URL đã redact -> vẫn có id.

## Kiểm chứng đã chạy
- `npx vitest run tests/unit/providers/fal/commands.test.ts tests/unit/providers/minimax/image-to-image-errors.test.ts`: 2 files, 29 tests pass.
- `npx biome check` 4 file: sạch. `npx tsc --noEmit`: sạch.
- Chưa chạy toàn bộ `npm test`/`npm run build`.

## Recommended actions
1. (Không chặn) Thêm test lỗi mạng cho `fal result` khẳng định REQUEST_ID trong message và code NETWORK_ERROR.
2. (Không chặn) Ghi URL fetch trong test MiniMax.
3. Mở issue follow-up cho run-helpers.ts:165,177 và các lệnh còn catch-and-exit.

## Unresolved questions
- gemini/commands/generate.ts:122 vẫn có catch -> exit(1): có phải lỗi request mà #491 bỏ sót không? Chưa xác minh.

Status: DONE
Summary: Lỗi giờ lan tới cli.ts -> exitWithError -> finalizeRun -> classifyError, giữ HttpError/retry_after_s; request id vẫn có trong URL đã redact cho cả HttpError và lỗi mạng, không lộ secret. Chỉ còn khoảng trống test nhỏ và các vị trí cùng mẫu ngoài phạm vi.
Concerns: none (blocking). Non-blocking: src/providers/fal/run-helpers.ts:165,177 cùng lỗi gốc; thiếu test lỗi mạng cho fal result.
