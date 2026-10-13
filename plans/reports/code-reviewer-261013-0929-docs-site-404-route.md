# Review code: commit 32c670f — trang 404 của docs-site (issue #160)

## Phạm vi
- Các file: `docs-site/astro.config.mjs` (+3), `docs-site/src/pages/404.astro` (+16, mới), `docs-site/src/env.d.ts` (+2, mới)
- Số dòng: 21 dòng thêm, 0 dòng xoá
- Trọng tâm: tính tương đương với route 404 có sẵn của Starlight 0.42.6, side effect về kiểu, đường deploy Cloudflare, độ phủ test CSP, độ chính xác của comment.

## Kết luận tổng quát
Đúng và gọn. Tôi đã tự build lại để kiểm chứng: `404.html` mới **giống từng byte** với bản build của 3f78fe9. Không còn WARN. Mọi HTML khác chỉ khác ở tên chunk CSS (`common.C_T1oc0O.css` -> `middleware.C_T1oc0O.css`), còn nội dung hai file CSS giống từng byte. Không có lỗi chặn merge.

## Kiểm chứng đã chạy (scratch, bằng `git archive` + `npm ci`, Node 22.22.0)
- Build 3f78fe9: có `[WARN] [content] Entry docs → 404 was not found.`
- `npm run verify` của 32c670f: astro check 0 errors / 0 warnings, build không có WARN, 7/7 test pass.
- `diff -r dist` sau khi chuẩn hoá tên chunk CSS: chỉ còn `pagefind/pagefind-entry.json` khác, và chỉ khác thứ tự key `en`/`vi` (hash và `page_count: 21` giống nhau). Đây là output không tất định của pagefind, không phải thay đổi về nội dung.
- `dist/_headers` giống hệt nhau, nên tập hash CSP không đổi.
- `sitemap-0.xml` ở cả hai bản đều không có `404`.
- `astro dev`: `/nope/` và `/vi/nope/` đều trả về 404 với `<title>404 | multix</title>`. Đã tắt dev server sau khi kiểm tra.
- Bỏ `src/env.d.ts` thì `astro check` báo `src/pages/404.astro:14:35 ts(2339): Property 't' does not exist on type 'Locals'`. Vậy file này thực sự cần.
- Đã xoá thư mục scratch.

## So sánh với `get404Route` (node_modules/@astrojs/starlight/dist/utils/routing/data.js:86-123)
| Thuộc tính | Bản có sẵn | Trang mới | Kết quả |
|---|---|---|---|
| title | "404" | "404" | khớp |
| template | splash | splash | khớp (không sidebar, không ToC, `data-has-hero`) |
| editUrl | false | false (StarlightPage cũng mặc định là false) | khớp |
| pagefind | false | false | khớp (không có `data-pagefind-body`, page_count không đổi) |
| hero.tagline / actions | `t("404.text")` / [] | `t("404.text")` / mặc định [] từ schema | khớp |
| head | [] | mặc định [] | khớp |
| sidebar | hidden:false | StarlightPage tự gán | khớp |
| lang/dir | lấy từ `config.defaultLocale` | lấy từ URL `/404` qua `slugToLocaleData`, ra root = en/ltr | khớp với config hiện tại (`lang="en" dir="ltr"`) |
| robots/noindex | Starlight không thêm | không thêm | khớp (vốn đã không có noindex, không phải hồi quy) |
| sitemap | không có trong sitemap | không có trong sitemap | khớp |

## Cloudflare và test
- `docs-site/wrangler.jsonc:8`: `not_found_handling: "404-page"` vẫn trỏ được đến `dist/404.html`, vì file này vẫn được tạo ở cùng đường dẫn. Trước đây cũng không có `vi/404.html`, nên hành vi không đổi.
- `docs-site/tests/site-output.test.mjs:159` đã đưa `404.html` vào vòng kiểm tra CSP. Test pass, và `_headers` giống hệt bản trước.

## `src/env.d.ts`
- `@astrojs/starlight` có `types` trỏ tới `dist/index.d.ts`, file này import `./global.js`. Như vậy chỉ thêm `declare global { App.Locals { t, starlightRoute }, StarlightApp, StarlightThemeProvider }` và phần augment `i18next`. Đây là đúng những kiểu mà middleware của Starlight thực sự cung cấp lúc chạy, nên không thừa.
- Không xung đột với `.astro/types.d.ts`: file đó chỉ tham chiếu `astro/client` và `content.d.ts`, không khai báo `App.Locals`. Astro 7 không sinh và không ghi đè `src/env.d.ts` (hằng `ENV_TYPES_FILE` của Astro dùng cho `.astro/env.d.ts`).
- Nguyên nhân gốc: `docs-site/tsconfig.json` ghi đè `include: ["src"]`, nên `astro.config.mjs` (nơi import Starlight và kéo theo global types) nằm ngoài chương trình TS. Vì vậy cách sửa bằng env.d.ts là hợp lý và tối thiểu. Comment trong file mô tả đúng việc này.

## Critical / High
Không có.

## Medium
Không có.

## Low / thông tin (không chặn merge)
1. **Rủi ro lệch khi nâng cấp Starlight.** `docs-site/src/pages/404.astro:8-15` là bản sao thủ công của fallback entry. Nếu Starlight sau này đổi trang 404 mặc định (ví dụ thêm `noindex` hoặc hero actions), trang này sẽ không tự cập nhật theo. Comment "Same page as Starlight's built-in 404 route" chỉ đúng tại 0.42.6. Có thể chấp nhận. Khi nâng cấp Starlight, nên so lại với `get404Route`.
2. **Mất cơ chế ghi đè bằng nội dung.** Route có sẵn sẽ ưu tiên dùng `src/content/docs/404.md` nếu file đó tồn tại. Từ nay muốn tuỳ biến trang 404 thì phải sửa `src/pages/404.astro`. Điều này không ảnh hưởng gì vì repo không có 404.md, và hướng đó đã bị loại vì xung đột với `[...slug]`.
3. Commit type là `chore(docs-site)`, nên không kích hoạt release npm. Điều này phù hợp vì docs-site không được publish.

## Độ chính xác của comment
- `astro.config.mjs:41-42`: đúng (`index.js:37` chỉ inject route khi `!disable404Route`; `data.js:117` gọi `getEntry("docs","404")`).
- `404.astro:2-4`: đúng tại phiên bản hiện tại; xem mục Low 1.
- `env.d.ts:1`: đúng.

## Edge case đã soát
- Locale `vi`: không có `vi/404.html`, trước và sau đều vậy. Cloudflare trả về `/404.html` gốc (tiếng Anh). Không phải hồi quy.
- Dev mode: 404 vẫn hoạt động.
- Middleware của Starlight vẫn chạy cho `src/pages/404.astro` (`Astro.locals.t` có giá trị khi render). Việc chunk CSS đổi tên thành `middleware.*` là hệ quả của chunking, không ảnh hưởng nội dung.

## Việc nên làm
1. Merge được như hiện tại.
2. (Tuỳ chọn) Khi nâng cấp Starlight, đối chiếu lại `get404Route` với `404.astro`.

## Số liệu
- Typecheck (astro check): 0 errors, 0 warnings, 0 hints
- Test docs-site: 7/7 pass
- WARN khi build: 0 (trước đó là 1)

## Câu hỏi chưa giải quyết
Không có.

Status: DONE
Summary: Trang 404 mới render ra HTML giống từng byte với route có sẵn của Starlight, cảnh báo build đã hết, CSP, Cloudflare not_found_handling, sitemap và pagefind đều không đổi. env.d.ts cần thiết và không gây side effect.
Concerns/Blockers: Không có lỗi chặn merge.
