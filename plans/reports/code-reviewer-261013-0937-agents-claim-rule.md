# Code review: quy tắc claim issue trong AGENTS.md (#171)

- Commit: `42a4258` `chore(agents): make the issue claim step safe for parallel agent sessions`
- File: `AGENTS.md` (+16/-1), chỉ tài liệu
- Thời điểm review: 2026-10-13 09:37 UTC
- gh dùng để kiểm cú pháp: 2.89.0

## Đánh giá chung

Hướng đi đúng: dùng comment làm khóa (bên nào comment trước thắng) là cách duy nhất phân biệt được các session khi chúng dùng chung một tài khoản GitHub. Thuật toán "comment rồi đọc lại" đúng về mặt logic: session nào post sau sẽ luôn thấy claim trước đó khi đọc lại. Commit type `chore` đúng, không kích hoạt bản npm mới. Có điều chưa thể duyệt nguyên trạng: còn 2 chỗ mơ hồ và một lỗi thực tế ở lệnh mẫu, đủ để tái diễn đúng sự cố #159/#165.

## Mức High

1. **Lệnh re-check dùng search API, mà search API có độ trễ index.** Cả `gh pr list --search` và `gh issue list --search` đều chạy qua GitHub search. Index này thường trễ vài giây đến khoảng một phút, nên PR hoặc issue vừa tạo có thể chưa xuất hiện, trong khi đó lại chính là kịch bản đua "cùng trigger trong vài giây". Cú pháp thì hợp lệ (đã kiểm `gh pr list --help` / `gh issue list --help`; `created:>=` là qualifier hợp lệ). Nhưng lệnh có thể trả kết quả rỗng sai đúng lúc cần nó nhất.
   - Đề xuất dùng nguồn không qua search:
     - `gh issue view <n> --json closedByPullRequestsReferences` (đã kiểm, field có trong gh 2.89) để tìm PR đã link `Closes #<n>`
     - `gh pr list` / `gh issue list` không có `--search` (mặc định sắp xếp mới nhất trước) để xem các mục vừa tạo
   - Ngoài ra, `gh pr list --search "<n>"` khớp mọi PR có token số đó ở bất kỳ đâu (tiêu đề, thân, số version). Kết quả nhiễu, nhưng chưa phải lỗi.

2. **Hai tiêu chí "thắng" mâu thuẫn nhau.** Bước 3 nói "the earliest claim comment wins", còn đoạn re-check nói "close it with a link to the earlier one", tức là PR hoặc issue mở trước. Nếu session A claim trước nhưng session B mở PR trước (trường hợp #159 so với #165), mỗi bên đều có thể viện một câu để giữ PR của mình. Cần một tiêu chí duy nhất: claim sớm nhất thắng, còn "mở trước" chỉ dùng khi không có claim nào.

## Mức Medium

3. **Claim bị bỏ dở hoặc đã cũ không có lối ra.** Claim không có hạn. Nếu một session chết sau khi claim, issue bị khóa vĩnh viễn, vì mọi session sau đều thấy "earlier claim" và dừng lại. Còn thiếu:
   - (a) cách rút claim, ví dụ comment `Released`/`Withdrawn`;
   - (b) điều kiện claim được coi là cũ, ví dụ không có branch, PR hay cập nhật sau N giờ, và khi đó claim mới phải dẫn link claim cũ.

4. **Thứ tự khi trùng giây chưa được nói rõ.** `createdAt` chỉ chính xác đến giây, nên hai claim trong cùng một giây trông như hòa. Tuy vậy, timeline của issue và ID comment luôn có thứ tự tăng dần. Nên ghi "the claim listed first on the issue" thay vì dựa vào timestamp. Đổi ít chữ mà hết mơ hồ.

5. **Bước 2 và bước 3 mâu thuẫn ngầm với nhau.** Bước 2 nói issue "already assigned and labelled `in progress` belongs to someone else". Khi dùng chung tài khoản, session B thấy chính mình (`@me`) là assignee nên kiểm tra này vô tác dụng, và bước 3 phải tự giải thích lý do. Không sai, nhưng người đọc dễ bị rối. Có thể thêm vào bước 2 một mệnh đề ngắn: "(if the assignee is your own account, rely on step 3)".

6. **Đoạn re-check làm vỡ cấu trúc đoạn.** Đoạn này được chèn giữa bước 4 ("status labels") và bảng label mà bước 4 dẫn tới, nên bảng bị tách khỏi câu giới thiệu nó. Nên chuyển đoạn re-check xuống sau khối lệnh `gh issue edit`, hoặc tách thành một tiểu mục riêng.

## Mức Low

- Bước 3 viết "names your session or branch" nhưng mẫu lại yêu cầu cả hai (`<session>, branch <branch>`). Nên thống nhất là cả hai, nếu đã có branch.
- Bước 1 ("comment on it with a link") không xung đột với quy tắc mới: bước 1 nói về issue trùng, bước 3 nói về claim trên issue đang làm. Vẫn nhất quán.
- "issues created in the last hour" là một heuristic hợp lý. Placeholder `<time>` nên ghi rõ định dạng ISO 8601 UTC, ví dụ `2026-10-13T08:30:00Z`.
- Văn phong và độ dài hợp với phần còn lại của file. Đánh số bước liên tục 1–4, không bị lệch.

## Đề xuất sửa (tối thiểu)

Bước 3, câu cuối:

```
... so the assignee and the label alone cannot tell two sessions apart; the
claim listed first on the issue wins. A claim with no branch, PR or update
for 24 hours is stale; a new claim must link it. Post `Released` if you stop.
```

Đoạn re-check (đặt sau khối lệnh `gh issue edit`):

```
Re-check right before you open a new issue or a PR. Search results lag by up
to a minute, so list directly: `gh issue view <n> --json closedByPullRequestsReferences`
for PRs that close the issue, and `gh issue list` / `gh pr list` (newest first)
for anything opened in the last hour. If someone else's PR or issue already
covers it, do not open yours. If you find a duplicate, the one tied to the
earliest claim stays (or the earlier one if nobody claimed); close the other
with a link and carry over any evidence it adds.
```

## Fact-check

- `gh pr list --search`, `gh issue list --search`, và qualifier `created:>=`: hợp lệ (đã kiểm trong `--help` và GitHub search syntax).
- `gh issue view --json closedByPullRequestsReferences`: có trong danh sách JSON fields của gh 2.89.0.
- Commit chỉ đụng tới `AGENTS.md`, không có thay đổi lan sang file khác.

## Metrics

- Không có code, nên không áp dụng lint, typecheck hay test.

## Câu hỏi còn mở

- Ngưỡng coi claim là cũ (24h?) là quyết định của maintainer.
- Có muốn quy tắc claim áp dụng cả cho người, hay chỉ cho các agent session?

Status: DONE_WITH_CONCERNS
Summary: Quy tắc claim đúng hướng và lệnh gh đúng cú pháp, nhưng lệnh re-check qua search API có độ trễ index nên có thể bỏ sót đúng ca đua. Ngoài ra, tiêu chí "earliest claim" và "earlier PR/issue" mâu thuẫn nhau, và chưa có cách xử lý claim bị bỏ dở; đã đề xuất cách sửa tối thiểu.
