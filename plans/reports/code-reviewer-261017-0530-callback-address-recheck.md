# Code review: a133d71 fix(worker): re-check webhook callback addresses (#226)

Reviewer: isolated code-reviewer (không phải tác giả). Ngày: 2026-10-17 (UTC).

## Phạm vi
- 14 file, +226/-45. Worker: `api/event-api-handlers.ts`, `api/openapi-document.ts`, `events/{account-events,callback-guard,event-hub,subscription-input}.ts`; test: `event-hub`, `rest-api`, `mcp-events`, `fake-job-bindings`; docs-site en+vi (`guides/mcp-server.md`, `guides/rest-api.md`).
- Đã chạy lại: `npx vitest run test/event-hub.test.ts test/rest-api.test.ts test/mcp-events.test.ts` trong `worker/`: 86/86 pass. Lead báo `check:mcp` và lint/typecheck/build/test ở root đều pass; tôi không chạy lại phần đó.

## Đánh giá tổng quát
Bản sửa làm đủ các yêu cầu của #226: REST `createSubscription` gọi `assertPublicCallbackUrl` (host không public hoặc không phân giải được trả 400, lỗi DoH trả 503 kèm `Retry-After: 30`). `EventHub.send` kiểm tra lại địa chỉ trước mọi lần thử; khi không đạt thì không gửi, đánh dấu retry rồi cuối cùng đưa vào dead letter. Comment sai về `global_fetch_strictly_public` đã được sửa; OpenAPI và docs en/vi đã cập nhật; có test cho cả hai đường. `checkCallback` là port inject vào hub, nên `event-hub.ts` không có `node:*` hay runtime DO, giữ đúng quy tắc của AGENTS.md. Không có lỗi chặn merge.

## Các phát hiện (xếp theo mức độ)

### 1. [Medium, optional] DoH (cloudflare-dns.com) lỗi thì bị tính là lỗi của endpoint, và có thể vô hiệu hóa subscription
`worker/src/events/event-hub.ts:656-667`, `:620-647`, `DISABLE_AFTER_DEAD_LETTERS = 5` (`:67`).
`send()` gộp `CallbackDnsError` (lỗi phía server: DoH timeout, SERVFAIL, 5xx) với `reason: "unresolved"` (NXDOMAIN thật). Cả hai trả cùng thông báo `endpoint host could not be resolved` và cùng tốn một lượt trong `MAX_DELIVERY_ATTEMPTS`. Trước commit này, DoH bị sự cố không ảnh hưởng việc gửi. Bây giờ nếu DoH sập kéo dài (lịch retry khoảng một ngày), mọi delivery sẽ vào dead letter. Sau 5 dead letter liên tiếp, subscription bị `disabled` với lý do "deliveries in a row failed", tức là lỗi của server lại đổ lên khách hàng. Fail-closed là đúng hướng về bảo mật, chỉ có phần quy trách nhiệm và chẩn đoán là sai.
Đề xuất: tách lý do (`address check unavailable` cho `CallbackDnsError`, `endpoint host could not be resolved` cho `unresolved`). Có thể xếp lại lịch cho lỗi DoH mà không tăng `attempts` (hoặc không đếm vào `consecutiveDeadLetters`). Ít nhất cũng nên ghi rõ điều này trong docs ở mục "Address re-check".

### 2. [Low, optional] Exception bất kỳ từ `checkCallback` bị nuốt và ghi thành "could not be resolved", không có log
`worker/src/events/event-hub.ts:658-659`: `error instanceof CallbackUrlError ? error.reason : "unresolved"`. Nhánh này nhận cả những lỗi không phải lỗi DNS (ví dụ một bug `TypeError` trong guard). Bug như vậy sẽ âm thầm chặn mọi delivery và dead-letter chúng, mà log `event_delivery_retry` chỉ ghi `status` chứ không ghi `error`, nên operator không biết nguyên nhân. Đề xuất: chỉ map `CallbackDnsError` và `CallbackUrlError`. Lỗi khác vẫn có thể giữ fail-closed (retry), nhưng phải `logEvent("error", …)` với `error.name`.

### 3. [Low, optional] `CallbackUrlError` có `reason: "invalid"` (bị từ chối theo tên) vẫn được retry suốt khoảng một ngày
`worker/src/events/event-hub.ts:660-665`. Ở thời điểm gửi, lỗi "invalid" chỉ xảy ra khi url-guard được siết lại sau khi subscription đã lưu. Kết quả này mang tính quyết định nên retry 9 lần không có ích, và thông báo `endpoint address not public` cũng không đúng bản chất. Có thể trả `kind: "permanent"`. Không ảnh hưởng an toàn vì không có gì được gửi đi.

### 4. [Low, optional] Chi phí subrequest và thời gian của alarm
`worker/src/events/event-hub.ts:554-581` (`DELIVERY_BATCH = 10`). Mỗi delivery giờ tốn 3 subrequest (DoH A, DoH AAAA, POST). Một alarm có tối đa 30 subrequest (trước đây 10), vẫn dưới giới hạn 50 của gói Free và 1000 của gói Paid. Housekeeping không fetch. Trong trường hợp xấu nhất, deliveries của cùng một subscription chạy tuần tự, mỗi cái tối đa khoảng 5 s DoH + 10 s POST, tức 10 × 15 s = 150 s cho một alarm, vẫn dưới giới hạn wall-clock của alarm. Không phải bug. Chỉ lưu ý: nếu sau này tăng `DELIVERY_BATCH` lên khoảng 16 trở lên thì sẽ chạm giới hạn 50 của gói Free. Nên để một comment cạnh `DELIVERY_BATCH`.

### 5. [Low, informational] Rebinding vẫn còn cửa sổ TOCTOU giữa lúc check và lúc connect
`worker/src/events/callback-guard.ts:10-15`. Đây là hạn chế đã biết: Worker không ghim được IP, và resolver mà `fetch` dùng có thể khác cache DoH. Một tên có TTL 0 trả lời luân phiên vẫn có thể lọt qua. Docs en/vi đã ghi đúng giới hạn này ("a name that flips between the check and the connection is not caught"), nên không coi là lỗi của commit. Không cần sửa.

### 6. [Low, informational] Comment cũ trong `url-guard.ts` mâu thuẫn với cách làm mới
`worker/src/url-guard.ts:1-7` vẫn viết "Workers cannot resolve DNS up front". Câu này đúng với media URL (do provider tải), nhưng mâu thuẫn với `callback-guard.ts`, nơi đã resolve qua DoH. Có thể sửa thành "this guard does not resolve DNS". Nằm ngoài phạm vi, không chặn.

### 7. [Informational, ngoài phạm vi] Những chỗ khác fetch URL do người dùng cung cấp
- MCP verification (`worker/src/events/events-methods.ts:118-131`, `:178-187`): check chạy ngay trước `verifyCallback`, nên khoảng cách nhỏ. Có một ngoại lệ: nhánh `needs_verification` gọi lại `verify()` mà không chạy lại DoH check, tuy khoảng thời gian chỉ là vài ms. Chấp nhận được.
- Input files của job (`worker/src/jobs/run-input-files.ts:51`) chỉ được kiểm tra theo tên, và container tải chúng. Client ID Metadata Documents (`worker/src/index.ts:143`) thì do thư viện OAuth fetch. Cả hai đều không thuộc #226. Nếu chưa có issue riêng, nên mở một issue để đánh giá SSRF cho container download (theo AGENTS.md: mở issue mới thay vì mở rộng PR này).

### 8. [Low, optional] Chất lượng test
- `worker/test/event-hub.test.ts`: kiểm tra đúng ý "re-point thì không gửi", cả retry lẫn dead letter, đếm `checked` theo từng lần thử. Đây là test hành vi thật, không phải phantom test. Hạn chế: test dùng `checkCallback` giả, nên phần nối dây trong `account-events.ts:29` (truyền global `fetch` vào guard) không được test nào chạm tới. Rủi ro thấp vì đoạn đó chỉ một dòng.
- `mcp-events.test.ts` hiện dùng guard thật qua `remote.fetch`, tốt, nhưng không có kịch bản DNS đổi giữa lúc subscribe và lúc deliver với guard thật. Có thể thêm một case: subscribe với địa chỉ public, đổi DoH stub sang 10.0.0.1, chạy alarm, khẳng định không có POST tới callback.
- `worker/test/rest-api.test.ts:405,413-422`: `https://private.example.com/in` được test hai lần (trong vòng lặp 400 và kiểm tra body riêng). Trùng lặp nhưng vô hại. Case 503 kiểm tra `retry-after` và không tạo subscription, tốt.
- Không có test cho trường hợp `CallbackUrlError` có `reason: "unresolved"` (NXDOMAIN) ở REST (400). Logic là cùng nhánh 400 nên không cần thiết.

## Kiểm tra theo checklist
- Concurrency: check chạy trong `send()` cho từng delivery và theo đúng thứ tự trong mỗi subscription. Không có shared state mới. Đường "bị revoke trong lúc gửi" vẫn được xử lý vì check nằm trước đoạn đó.
- Error boundaries: REST map rõ hai lớp lỗi và rethrow phần còn lại (thành 500 internal). Hub nuốt mọi lỗi (xem #2).
- API contract / tương thích ngược: `HubPorts.checkCallback` là field bắt buộc mới. Mọi chỗ dựng `EventHub` (DO, fake bindings, mcp-events test) đều đã cập nhật. Tham số `field` mới của `assertPublicCallbackUrl` có default là `"delivery.url"`, nên thông báo lỗi của MCP giữ nguyên. Thêm 400/503 vào REST là thay đổi hành vi có chủ đích và đã ghi trong docs và OpenAPI (`EVENT_ERRORS` đã có 503).
- Input validation / authz: không đổi. Check chạy sau khi key đã được xác thực.
- Data leak: thông báo 400 không chứa IP; thông báo 503 là chuỗi cố định; `lastError` không chứa địa chỉ.
- Docs: en/vi khớp với code (400/503/`Retry-After`, lý do retry, giới hạn TOCTOU). Phần chưa ghi là hệ quả khi DoH bị sự cố (#1).

## Hành động đề xuất
1. (optional, nên làm) Tách lý do lỗi DoH khỏi NXDOMAIN, và cân nhắc không trừ attempt hay đếm dead letter cho lỗi DoH (#1).
2. (optional) Ghi log hoặc thu hẹp catch trong `send()` (#2). Trả `permanent` cho `reason: "invalid"` (#3).
3. (optional) Thêm test tích hợp re-point dùng guard thật trong `mcp-events.test.ts` (#8).
4. (optional, issue riêng) Đánh giá SSRF cho input-file download (#7).

Status: DONE
Summary: Commit a133d71 đáp ứng đủ #226 (check DoH ở REST subscribe và trước mỗi lần gửi, docs/OpenAPI en+vi đã sửa, có test). Không có lỗi chặn merge. Đáng sửa nhất: lỗi DoH phía server đang bị tính là lỗi của endpoint, có thể dead-letter và vô hiệu hóa subscription khi cloudflare-dns.com bị sự cố.
Concerns/Blockers: không có blocker; xem các mục optional #1-#3.

## Xử lý sau review (tác giả)
- #1: lỗi DoH (`CallbackDnsError`) có lý do riêng `callback address check unavailable` và không tốn lượt thử; docs en/vi đã ghi.
- #2: lỗi lạ từ check được log `event_callback_check_failed` (chỉ tên lỗi) và xử lý như lỗi DoH.
- #3: `reason: "invalid"` thành `permanent` (`endpoint URL is no longer allowed`).
- #4: comment cạnh `DELIVERY_BATCH`. #6: sửa comment `url-guard.ts`.
- #8: thêm test tích hợp re-point với guard thật trong `mcp-events.test.ts`.
- #7: input file của job đã được container kiểm tra theo địa chỉ khi tải (docs mcp-server, mục bảo mật), nên không mở issue mới.
