# Code review: định nghĩa collection `i18n` cho docs-site (issue #157)

- Commit: `76cfbc0` — `chore(docs-site): define the i18n collection so the docs build stops warning`
- Phạm vi: `docs-site/src/content.config.ts` (+2/-2), `docs-site/src/content/i18n/vi.yml` (mới, 5 dòng)
- Môi trường: Astro 7.3.8, @astrojs/starlight 0.42.6 (node_modules đã cài trong docs-site/)
- Ngày: 2026-10-13 (UTC)

## Kết luận tổng quát

Bản sửa đúng, tối thiểu và dùng đúng API công khai của Starlight 0.42. Không có lỗi critical/high. Đã chứng minh: cảnh báo `i18n` biến mất, `dist/` giống hệt từng byte so với build của commit cha, `npm run verify:docs` pass (exit 0).

## Bằng chứng đã kiểm

1. **API Starlight 0.42**: `i18nLoader` được export từ `@astrojs/starlight/loaders` (`dist/loaders.js:30,49`), `i18nSchema` từ `@astrojs/starlight/schema` (`dist/schemas/i18n.js`); cả hai subpath có trong `exports` của package.json. Loader glob `src/content/i18n/**/[^_]*.{json,yml,yaml}` → `vi.yml` được nạp với id `vi`. Đúng theo cách Starlight hướng dẫn.
2. **`{}` không đổi chuỗi UI tiếng Việt**: `i18nSchema()` = `z.looseObject` gồm các schema `.partial()` (`schemas/i18n.js:52,66,73`) → `{}` hợp lệ. `createTranslationSystem.js` chỉ chồng lớp built-in → plugin → user qua `buildResources`, chỉ ghi đè khi key có giá trị truthy; object rỗng không thay đổi gì. Khóa `vi` khớp `lang: "vi"` trong `astro.config.mjs`.
3. **Chú thích "built-in Vietnamese strings are complete" là đúng**: `translations/vi.js` có 28/28 key giống `en.js`, không thiếu key nào.
4. **Vì sao cần file chứ không chỉ cần định nghĩa collection**: `astro/dist/content/runtime.js` chỉ cảnh báo khi `store.hasCollection(collection)` là false; collection không có entry thì không vào store → vẫn cảnh báo. Nếu file chỉ có comment thì YAML parse ra `null` và sẽ không qua được schema object, nên `{}` là lựa chọn đúng. Lập luận về `console.warn` trong `utils/translations.js` của Starlight là đúng: logger của Astro không đi qua `console.warn`.
5. **Build trước/sau**: build commit cha (`git archive HEAD~1`, cùng node_modules) in ra `[WARN] [content] The collection "i18n" does not exist or is empty`; HEAD không còn dòng này. `diff -r` hai thư mục `dist/` → giống hệt. Khẳng định "byte-identical" của tác giả **đã được xác minh**.
6. **CI**: job `docs` trong `.github/workflows/ci.yml` chạy `npm run verify --prefix docs-site`, tôi đã chạy lại: `astro check` 0 errors/0 warnings/0 hints, build xong, `node --test` 7/7 pass. `biome check docs-site/src/content.config.ts` sạch. Type commit `chore` → release-please không phát hành npm (đúng quy tắc trong AGENTS.md).

## Critical
Không có.

## High
Không có.

## Medium
Không có.

## Low / Thông tin

- **L1 — Vẫn còn một cảnh báo build khác, có từ trước, nằm ngoài phạm vi**: `[WARN] [content] Entry docs → 404 was not found.` khi render `/404.html` (có ở cả commit cha lẫn HEAD). Issue #157 chỉ nói về `i18n` nên không cần sửa trong PR này; nếu muốn build sạch hoàn toàn thì mở issue riêng (theo AGENTS.md), ví dụ thêm `src/content/docs/404.md` hoặc dùng `disable404Route`.
- **L2 — Merge sẽ kích hoạt `deploy-docs.yml`** (đường dẫn `docs-site/**`). Vô hại vì output giống hệt, chỉ là một lần deploy dư.
- **L3 — Chưa có test chặn cảnh báo quay lại**: verify không fail khi có `[WARN]`, nên nếu sau này ai đó xóa `vi.yml` thì cảnh báo sẽ âm thầm quay lại. Comment trong file đã giải thích vì sao phải giữ file; chưa cần thêm test kiểu grep log build (lợi ích nhỏ so với độ giòn của test). Ghi lại để tham khảo, không bắt buộc.

## Có cách sửa nào tốt hơn không?
Không có cách nào rõ ràng tốt hơn. Các phương án khác:
- Chỉ định nghĩa collection mà không thêm file: vẫn cảnh báo (xem mục 4).
- Bỏ qua/lọc logger của Astro: hack, dễ hỏng, che cả cảnh báo thật.
- Dùng file `en.yml` thay `vi.yml`: tương đương; chọn `vi` hợp lý hơn vì đây là chỗ tự nhiên để đặt override cho tiếng Việt sau này.
Cách tác giả chọn đúng là cách Starlight hướng dẫn cho site đa ngôn ngữ.

## Việc nên làm
1. Không cần sửa gì trong PR. Có thể merge.
2. (Không bắt buộc) Mở issue riêng cho cảnh báo `Entry docs → 404 was not found`.

## Số liệu
- Type check: `astro check` 0 errors/warnings/hints
- Tests docs-site: 7/7 pass
- Lint (biome) trên file TS đã đổi: 0 lỗi

## Câu hỏi còn mở
Không có.

Status: DONE
Summary: Bản sửa đúng với API Starlight 0.42.6. `{}` không làm thay đổi chuỗi UI tiếng Việt và hợp lệ với schema; cảnh báo `i18n` đã biến mất, `dist/` giống hệt build của commit cha và `verify:docs` pass. Chỉ còn ghi chú mức thấp: cảnh báo 404 có từ trước, nằm ngoài phạm vi.
