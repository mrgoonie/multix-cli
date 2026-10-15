# Review: commit 6ddc5e8 — Cloudflare secrets vào environment `production` (#220)

## Phạm vi
- `.github/workflows/deploy-mcp.yml`, `.github/workflows/deploy-docs.yml`, `AGENTS.md` (+10 dòng)
- Đã kiểm tra live qua `gh api`: env `production` có đúng 1 rule `branch_policy`, policy `{name: main, type: branch}`, `protected_branches: false`; env secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; repo secrets cùng tên vẫn còn (sẽ xoá sau).

## Kết luận
Không có blocker. Thay đổi đúng, tối thiểu, đúng phạm vi issue.

## Câu hỏi đã kiểm tra

1. **Workflow/job khác dùng `secrets.CLOUDFLARE_*`?** Không. `grep` toàn bộ `.github/workflows/`: chỉ `deploy-mcp.yml` (2 step) và `deploy-docs.yml` (1 step), cả hai job đều đã có `environment: production`. `ci.yml`, `publish.yml` (npm OIDC), `release-please*.yml` chỉ dùng `GITHUB_TOKEN`. Không có `workflow_call`/`workflow_run` nào gọi lại deploy. Xoá repo secrets sau đó an toàn.
2. **Hành vi concurrency/push/PR:**
   - Không có required reviewers hay wait timer (protection_rules chỉ có branch_policy) → không có bước chờ duyệt; push lên `main` deploy ngay như trước.
   - Cả hai workflow chỉ chạy `push: main` + `workflow_dispatch`, không chạy trên `pull_request` → không có deployment hiện trên PR. Mỗi run sẽ tạo một Deployment record trong tab Deployments / trang commit (chỉ là hiển thị).
   - Env secrets ghi đè repo secrets cùng tên → trong giai đoạn chuyển tiếp job đọc từ env; thành công của lần deploy sau merge chứng minh env secrets đúng.
   - Commit sửa chính hai file workflow, nằm trong `paths` của cả hai → merge sẽ kích hoạt cả hai deploy, đủ làm lần kiểm chứng trước khi xoá repo secrets.
   - `concurrency` không đổi; environment không tự serialize giữa hai workflow (giống trước).
3. **Step "Require main" trong deploy-mcp.yml:** vẫn nhất quán nhưng giờ không còn chạm tới được: dispatch từ ref khác bị GitHub từ chối ở mức job ("not allowed to deploy to production") trước khi step nào chạy. Giữ lại làm defense-in-depth là hợp lý (nếu ai đó nới branch policy). Comment concurrency ("they fail at 'Require main' anyway") giờ hơi lệch — thực tế fail ở cổng environment. Không ảnh hưởng chức năng.

## Low / thông tin
- **deploy-docs.yml concurrency** dùng group cố định `deploy-docs` cho mọi ref (khác deploy-mcp). Một `workflow_dispatch` từ nhánh khác có thể thay thế một run `main` đang pending trong cùng group, rồi tự fail ở cổng environment → run main bị bỏ. Có từ trước, hiếm; nếu muốn đồng bộ thì dùng cùng biểu thức group như deploy-mcp. Lưu ý thay đổi này còn là cải thiện bảo mật: trước đây dispatch docs từ nhánh bất kỳ deploy được lên production, giờ bị chặn.
- `can_admins_bypass: true` chỉ áp dụng cho required reviewers, không bỏ qua branch policy → không rủi ro.
- Tuỳ chọn: thêm `environment: { name: production, url: https://multix.zuey.me/mcp }` để link deployment; không bắt buộc.
- Bất kỳ ai có quyền push `main` vẫn đọc được token (by design); hiệu quả thực sự phụ thuộc branch protection của `main`, nằm ngoài phạm vi issue.

## Hành động đề xuất
1. Merge, xác nhận cả hai deploy chạy xanh trên `main`, rồi xoá repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
2. (Tuỳ chọn) sửa comment concurrency trong deploy-mcp.yml; đồng bộ group của deploy-docs — có thể mở issue riêng.

## Câu hỏi chưa giải quyết
- Không có.

Status: DONE
Summary: Không workflow nào khác dùng CLOUDFLARE_*; environment không thêm bước chờ hay deployment trên PR; "Require main" nay dư thừa nhưng vô hại. Chỉ có ghi chú low (comment lệch, group concurrency của deploy-docs).
