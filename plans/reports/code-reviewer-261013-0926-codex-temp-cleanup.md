# Code review: dọn thư mục tạm của Codex image driver (#164)

Phạm vi: `src/providers/openai/codex-image-driver.ts` và `tests/unit/providers/openai/codex-image-driver.test.ts`. Hàm được gọi từ `src/providers/openai/commands/generate.ts` và `image-to-image.ts`; cả hai chỉ dùng `.path`. Worker không import file này.

## Kết quả vòng 1

- **High, đã sửa:** `fs.rmSync` trong `finally` không được bảo vệ. Nếu xóa thất bại (EBUSY/EPERM trên Windows, ví dụ do antivirus hoặc tiến trình cháu của `codex` còn giữ cwd), một lần tạo ảnh thành công sẽ bị báo lỗi, hoặc lỗi gốc của Codex bị thay bằng lỗi xóa thư mục. Đã đổi sang mẫu best-effort có sẵn ở `src/core/stdin-file.ts` (`maxRetries: 3, retryDelay: 100`, bọc try/catch).
- **Low, đã sửa:** thêm test giả lập `rmSync` ném lỗi, kiểm tra ảnh vẫn được trả về và `ProviderError` gốc vẫn được ném.

## Đã kiểm và không có vấn đề

- `return await` trong `try` bảo đảm `finally` chỉ chạy sau khi Codex kết thúc.
- `dest` không thể nằm trong thư mục tạm: nó được tính trước `mkdtempSync` từ `--output` hoặc thư mục output, và Codex nhận đường dẫn tuyệt đối.
- Chữ ký export giữ nguyên; `runInTempDir` là hàm nội bộ.

## Kiểm chứng

- Test mới về dọn thư mục fail trên code gốc (2 failed, 4 thư mục tạm bị rò) và pass với bản sửa.
- Test "rmSync ném lỗi" fail khi bỏ try/catch và pass khi có.
- `npm run lint`, `typecheck`, `build` sạch. `npm test`: 1159 passed, 11 skipped. Không còn `multix-codex-image-*` trong `/tmp` sau khi chạy.

## Câu hỏi còn mở

- Có nên dọn thư mục khi bị ngắt bằng SIGINT/SIGTERM (như `trackTempDir`) không? Ngoài phạm vi #164.
