# Code review: smoke `--help` timeout (#158)

Phạm vi: `tests/smoke/parse-args.test.ts` (+13/-4). Không có file nào khác bị đổi.

## Kiểm chứng

- vitest 4.1.11: `createTest` trong `@vitest/runner` gộp option của suite vào từng `it` (`Object.assign({}, suiteOptions, options)`, comment "inherit repeats, retry, timeout from suite"). Vì vậy `describe(name, { timeout }, fn)` áp dụng cho mọi `it` bên trong, kể cả các `it` sinh ra trong vòng `for`.
- `npx vitest run tests/smoke/parse-args.test.ts --testTimeout=20`: 73/73 pass. Nếu timeout của `describe` không có tác dụng thì cả 73 case đã timeout ở 20 ms.
- `biome check` trên file không báo lỗi. `vitest.config.ts` không đổi, nên unit test vẫn dùng timeout mặc định 5 s.

## Nhận xét

- execa kill tiến trình con ở 29 s (`SPAWN_TIMEOUT - 1_000`), trước khi vitest timeout ở 30 s, nên CLI bị treo không để lại tiến trình mồ côi. Cách này giống `cli.test.ts` và `library-entry.test.ts`.
- Windows: tiến trình con chỉ là `node dist/cli.js --help`, không sinh tiến trình cháu.
- Hai file smoke còn lại dùng 15 s, file này dùng 30 s, nằm trong khoảng 20–30 s mà issue đề xuất.
- Không chặn merge: nếu mọi lần spawn đều treo thì file chạy tuần tự khoảng 73 × 29 s ≈ 35 phút rồi mới fail. Chỉ xảy ra khi CLI hỏng thật, và timeout của job CI sẽ cắt trước.
- Ngoài phạm vi: `parse-args.test.ts` không dùng `isolatedEnv`. `--help` không gọi provider và không ghi file, nên không cần sửa.

## Kết luận

Không có lỗi Critical, High hay Medium. Có thể merge.
