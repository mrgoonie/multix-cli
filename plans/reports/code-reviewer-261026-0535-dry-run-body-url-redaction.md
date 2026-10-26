# Code review: redact URL query strings trong dry-run request body (#318)

- Commit: `e8c4083` (`fix(agent): redact URL query strings in dry-run request bodies`), branch `claude/gracious-heisenberg-d1g2l5`
- Reviewer: code-reviewer (context độc lập), 2026-10-26 05:35 UTC
- Phạm vi: `src/agent/fetch-telemetry.ts`, `tests/unit/agent/fetch-telemetry.test.ts`, `tests/smoke/agent-mode.test.ts`, 2 file docs `for-ai-agents.md` (EN/VI). Khoảng 54 dòng thêm, 6 dòng xoá.
- Claim: comment claim đầu tiên trên #318 là của session này, nên không có xung đột claim.

## Đánh giá tổng quát

Commit sửa đúng trường hợp phổ biến: URL "sạch" (`https://host/path?sig=...`) ở mọi độ sâu, trong mảng, trong FormData, scheme viết hoa, URL nằm trong câu văn. Lint, typecheck, `tests/unit/agent` và `tests/smoke/agent-mode.test.ts` đều pass (25/25). Tuy vậy DoD của issue ghi rõ "A dry-run body **never** contains a URL query value". Regex hiện tại loại `'`, `"`, `<`, `>` và khoảng trắng ra khỏi phần path. Vì thế một URL hợp lệ có ký tự `'` trong path (ví dụ key S3 lấy từ tên file kiểu `John's.png`) lọt qua **toàn bộ**, kể cả chữ ký. Đã tái hiện end-to-end bằng `dist/cli.js` (được build từ HEAD).

Commit cũng tự viết lại logic redact URL mà repo đã có sẵn: `redactUrl()` trong `src/core/redact.ts`. Hàm đó bỏ userinfo, chuẩn hoá `\` và khoảng trắng, xử lý scheme opaque. Đây đúng là kiểu triển khai song song mà AGENTS.md muốn tránh.

## Critical / blocking

### C1. Ký tự `'` (hoặc khoảng trắng, `"`) trong path làm lộ nguyên signed URL
`src/agent/fetch-telemetry.ts:34`

```ts
const URL_SECRET_PART = /(https?:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;
```

Nhóm 1 dừng ở `'`, sau đó bắt buộc phải gặp `[?#]` ngay. Nếu không gặp thì match thất bại, và không còn `https://` nào khác để thử lại.

Đã tái hiện bằng CLI đã build, với `FAL_KEY` giả và mạng bị chặn:

```
multix fal video "a cat" --image-url "https://b.s3.amazonaws.com/John's.png?X-Amz-Signature=LEAK1" --dry-run --json
=> "body":{"prompt":"a cat","image_url":"https://b.s3.amazonaws.com/John's.png?X-Amz-Signature=LEAK1"}

multix fal video "a cat" --image-url "https://cdn.example.com/my photo.png?sig=LEAK3" --dry-run --json
=> "body":{"prompt":"a cat","image_url":"https://cdn.example.com/my photo.png?sig=LEAK3"}
```

`'` là ký tự hợp lệ trong path theo RFC 3986. WHATWG URL và `encodeURI` đều **không** percent-encode nó, nên presigned URL của S3/R2/GCS cho object có dấu nháy đơn sẽ giữ nguyên `'` khi đi qua CLI. `--image-url` được truyền thẳng vào body (`src/providers/fal/commands/video.ts:53`) mà không qua chuẩn hoá nào.

Biến thể cùng gốc (probe bằng `npx tsx`):
- `https://x.com/a.png?sig=abc'SECRET3` cho ra `...?[redacted]'SECRET3`: phần query sau `'` vẫn bị in ra.
- `https://x.com/a"b.png?sig=SECRET11` lộ toàn bộ.
- `https://x.com/a　b?sig=SECRET18` lộ toàn bộ, vì `\s` khớp U+3000 nên nhóm 1 dừng ở đó.

Cách sửa đề xuất (đã thử nhanh trong scratchpad, đóng được hết các case trên):

```ts
import { redactUrl } from "../core/redact.js";
const URL_IN_TEXT = /(https?:[\/\\]{2}[^\s?#"<>]*)[?#][^\s"<>]*/gi; // bỏ ' khỏi cả hai class

function redactUrls(value: string): string {
  const t = value.trim();
  if (/^https?:/i.test(t)) {
    try { return redactUrl(new URL(t).href); } catch {} // giá trị là đúng 1 URL: parse, bỏ userinfo, encode khoảng trắng
  }
  return value.replace(URL_IN_TEXT, "$1?[redacted]");     // URL nằm trong câu văn
}
```

Kết quả probe: `John's.png?...` thành `https://b.s3.amazonaws.com/John's.png?[redacted]`, `my photo.png?...` thành `https://x.com/my%20photo.png?[redacted]`, `https://u:L3@x.com/a.png` thành `https://x.com/a.png`, `https:\\x.com\a.png?sig=` thành `https://x.com/a.png?[redacted]`. Đánh đổi: ở nhánh câu văn, dấu nháy đóng sau query cũng bị nuốt. Với output dry-run thì chấp nhận được.

Cần thêm test hồi quy cho `'` trong path, `'` trong query và khoảng trắng trong path.

## High

### H1. Userinfo (`https://user:pass@host/...`) không bị redact
`src/agent/fetch-telemetry.ts:34,39`. Input `https://user:SECRET5@x.com/a.png` giữ nguyên, đã tái hiện qua `fal video --image-url` (LEAK2). Issue và docstring nói "origin and path stay". `origin` theo WHATWG không bao gồm userinfo, và `safeUrl()` / `redactUrl()` đều đã bỏ phần này. Nằm ngoài chữ "query value" của DoD nhưng là cùng một lớp lộ credential, và dùng `redactUrl()` như C1 thì tự hết.

### H2. Đường dry-run EXEC (Codex driver) không đi qua `shorten()`
`src/agent/agent-runtime.ts:333` dựng `request.body` từ argv của `codex` và chỉ cắt chuỗi dài hơn 400 ký tự. Đã tái hiện với một `codex` giả trả về "Logged in using ChatGPT":

```
multix openai generate --prompt "cat like https://cdn.example.com/a.png?sig=EXECLEAK" --driver codex --dry-run --json
=> request.body[...] chứa "...a.png?sig=EXECLEAK..." và next[0] cũng chứa EXECLEAK
```

`next[0]` lộ là vì `redactArgv()` (`src/agent/history-store.ts:66`) chỉ redact argv **bắt đầu** bằng `http`, không redact URL nằm giữa prompt. Lỗi này có từ trước và nằm ngoài diff. Nhưng phần `request.body` thì thuộc đúng DoD "a dry-run body never contains a URL query value". Có 2 cách: áp cùng hàm redact cho `args` ở `agent-runtime.ts:333` trong PR này (1 dòng), hoặc mở issue riêng theo AGENTS.md. Riêng phần `next`/history thì nên mở issue riêng.

## Medium

- **M1. Triển khai song song.** `redactUrl()` (`src/core/redact.ts:22`) và `SIGNED_QUERY`/`redactArgv` (`src/agent/history-store.ts:47,66`) đã có sẵn. Regex mới là bản thứ ba với hành vi khác hai bản kia: không parse, không bỏ userinfo, và redact mọi query thay vì chỉ query có dạng signed. Nên dùng lại `redactUrl()` như C1.
- **M2. Scheme khác http(s) không được xử lý.** `s3://bucket/a.png?sig=`, `wss://...?token=`, `ftp://...?sig=` và URL protocol-relative `//cdn.example.com/a.png?sig=` đều lộ. Đúng với phạm vi chữ của issue ("any `http(s)://` string value"), nhưng nên ghi rõ trong docstring hoặc docs, hoặc mở rộng regex sang `[a-z][a-z0-9+.-]*://`.
- **M3. Test chưa chứng minh được "never".** Unit test (`tests/unit/agent/fetch-telemetry.test.ts:50`) chỉ phủ URL sạch. Thiếu các case: scheme viết hoa, FormData (`describeRequest` với `FormData`, mới là đường thật mà `shorten` được gọi từ đó), ký tự `'`/khoảng trắng/`"`, userinfo, mảng dài hơn 10 phần tử, object sâu hơn 4 tầng. Assertion `not.toMatch(/...|abc|.../)` ở dòng 63 hơi lỏng: `abc` là chuỗi ngắn, dễ trùng ngẫu nhiên. Assertion `toEqual` ngay sau đó mới thực sự chứng minh hành vi.
- **M4. `shorten` được export chỉ để phục vụ test.** Đã kiểm tra: `src/index.ts` không re-export nên không đổi public API của package. Có thể test qua `installFetchTelemetry` cùng `run.dryRun`, giống test hiện có trong cùng file, để phủ luôn đường FormData và JSON.parse.

## Low

- Fragment `#token=xyz` bị viết lại thành `?[redacted]`. Output đổi `#` thành `?` nên hiển thị lệch so với request thật. Docs EN/VI chỉ nói "query strings", không nhắc fragment.
- URL ở cuối câu nuốt luôn dấu chấm: `...png?sig=S23.` thành `...png?[redacted]` (mất dấu `.`). Chỉ là chi tiết hiển thị.
- Key của object không đi qua redact. Ví dụ `{"https://x?sig=S": 1}` chỉ được che nếu key tình cờ khớp regex `key|token|secret...`. Body của provider thực tế không dùng URL làm key, nên không chặn merge.

## Các vector đã kiểm tra và không có vấn đề

| Vector | Kết quả |
|---|---|
| Scheme viết hoa `HTTPS://`, `httpS://` | Đã redact (cờ `i`) |
| URL trong câu văn, nhiều URL trong một chuỗi | Đã redact từng URL |
| Bọc trong nháy `'...'` hoặc ngoặc `<...>` | Đã redact, giữ ký tự bao |
| Percent-encoded `https%3A%2F%2F...` | Không coi là URL; query cũng không tồn tại dưới dạng `?`. Không phải rò rỉ query của một URL thật |
| FormData string entry | Đi qua `shorten()`, đã redact |
| Mảng lồng 8 tầng | Mảng không kiểm tra `depth` nhưng chuỗi vẫn đi qua `shorten`, đã redact |
| Object sâu hơn 4 tầng | Thành `<object>`, không lộ |
| Mảng dài hơn 10 phần tử | Bị cắt thành `<+n more>`, không lộ |
| Chuỗi dài hơn 400 ký tự hoặc `data:` | Thành `<n chars>` trước khi chạy regex |
| ReDoS | Không có quantifier lồng nhau; class của nhóm 1 loại `?#` nên ranh giới là tất định. Trường hợp xấu nhất là O(n²) theo số lần lặp `http://`, nhưng n bị giới hạn ở 400 ký tự. Đo `"http://".repeat(57)` x1000 lần mất khoảng 30 ms (~30 µs/lần) |
| Hồi quy ở nơi khác dùng `shorten` | Chỉ `describeRequest()` gọi tới. Thay đổi hành vi duy nhất: mọi query của URL http(s) trong body dry-run đều bị ẩn, kể cả query vô hại (`?format=png`). Chấp nhận được theo issue |

## Kết quả kiểm tra

- `npx vitest run tests/unit/agent tests/smoke/agent-mode.test.ts`: 4 file, 25/25 pass.
- `npx biome check` trên 3 file thay đổi: sạch.
- `npx tsc --noEmit -p .`: sạch.
- `dist/cli.js` đã được build sau source (05:32:32 so với 05:32:06) và chứa regex mới. Các probe end-to-end ở trên chạy trên bản build này.

## Đề xuất (theo thứ tự ưu tiên)

1. Sửa C1 và H1: dùng `redactUrl()` cho chuỗi là đúng một URL, và bỏ `'` khỏi các character class của regex dành cho câu văn. Thêm test cho `John's.png?sig=`, `my photo.png?sig=`, `?sig=abc'x`, `user:pass@`.
2. H2: áp cùng hàm redact cho `args` trong dry-run EXEC (`agent-runtime.ts:333`), hoặc mở issue riêng. Mở issue riêng cho `redactArgv` không redact URL nằm giữa prompt (lộ qua `next` và history).
3. M3: thêm test cho đường FormData và các case biên.
4. Docs: nhắc tới fragment, và tới việc chỉ xử lý `http(s)`.

## Câu hỏi còn mở

- Có muốn redact cả scheme khác http(s) (`s3://`, `gs://`, `wss://`) trong dry-run body không? Issue chỉ yêu cầu http(s).
- H2 (body của EXEC) xử lý trong PR này hay tách issue riêng?

Status: DONE_WITH_CONCERNS
Summary: Bản sửa che được URL http(s) "sạch" ở mọi vị trí trong body, test và lint đều pass. Nhưng chưa đạt DoD "never": một URL hợp lệ có `'` hoặc khoảng trắng trong path, cũng như userinfo, vẫn lộ nguyên signed query/credential, và body dry-run của Codex EXEC không đi qua redact.
Concerns:
- BLOCKING `src/agent/fetch-telemetry.ts:34`: `--image-url "https://b.s3.amazonaws.com/John's.png?X-Amz-Signature=LEAK1"` thì `request.body.image_url` chứa nguyên `X-Amz-Signature=LEAK1`. Tương tự với `https://cdn.example.com/my photo.png?sig=LEAK3` và `https://x.com/a.png?sig=abc'SECRET3` (lộ `'SECRET3`).
- HIGH `src/agent/fetch-telemetry.ts:34,39`: `https://user:SECRET5@x.com/a.png` giữ nguyên userinfo.
- HIGH `src/agent/agent-runtime.ts:333`: `openai generate --driver codex --prompt "... https://cdn.example.com/a.png?sig=EXECLEAK"` thì `request.body` (và `next[0]`) chứa `sig=EXECLEAK`.
