# Code review: PR #306 — never report an account credit balance as credits spent (Closes #302)

Reviewer: isolated code-reviewer (không viết code này). Ngày 2026-10-26.
PR head `pr-306` (85b3295, b32e86c), merge-base `5151636`, so với `origin/main` (b9bc563).

## Scope
- src/core/usage-extract.ts (+17): `BALANCE_LEAF`, `BALANCE_PARENT`, `isBalancePath()`, skip trong promotion loop.
- tests/unit/core/usage-extract.test.ts (+58): 3 test mới.
- docs-site for-ai-agents.md EN + VI (1 dòng mỗi file, bảng `usage`).
- plans/reports/code-reviewer-261026-0511-usage-balance-credits.md (review của tác giả, đúng vị trí theo AGENTS.md).

## Overall
Fix đúng chỗ (chỉ promotion loop; `walk()`/metrics không đổi), hẹp, tests có ý nghĩa. Logic vẫn đúng khi ghép với main hiện tại (#301 `ESTIMATE_PATH`, `sources`; #327 budget/receipt). Chặn merge duy nhất là conflict (PR `CONFLICTING`, CI chưa chạy trên kết quả merge).

## Kiểm chứng trên bản merge (scratch, không đụng repo)
Lấy `origin/main:src/core/usage-extract.ts`, chèn `BALANCE_LEAF`/`BALANCE_PARENT`/`isBalancePath` sau `ESTIMATE_PATH`, thêm `if (isBalancePath(path)) continue;` ngay sau dòng skip estimate.
- vitest: test file của main (#301/#327) + test file của PR: 18/18 pass.
- biome check file merge + test: clean.
- Probe:

| Input | Kết quả |
|---|---|
| Leonardo `sdGenerationJob.apiCreditCost: 8` | credits 8, source body.sdGenerationJob.apiCreditCost |
| Runway `cost.credits: 25` | credits 25 |
| OpenRouter `usage.cost`, `data.total_cost` | cost_usd đúng |
| HeyGen `/v3/users/me` shape thật (docs developers.heygen.com: `wallet.remaining_balance`, `wallet.auto_reload.threshold_usd/amount_usd`, `usage_based.*`) | không credits/cost_usd |
| `{credits_used: 5, available: true}` | credits 5 (boolean không bị nhầm) |

## Critical
Không có.

## High
Không có về logic. Conflict là blocker quy trình (xem phần giải conflict).

## Medium
1. Regex leaf rộng theo substring (`included|quota|granted|purchased|allowance|available|remaining`): spend thật có key kiểu `quota_credits_used`, `included_credits_used`, `subscription.credits_used` sẽ bị bỏ (probe xác nhận). Đã grep `src/providers/**` trên main: không provider hiện tại nào trả key như vậy (spend paths: Leonardo `*.apiCreditCost`, Runway `cost.credits`, OpenRouter `usage.cost`/`data.total_cost`, ElevenLabs header `character-cost`). Rủi ro tương lai, không chặn. Gợi ý (tuỳ chọn): loại trừ leaf có `used|spent|consumed|cost` trước khi coi là balance, ví dụ `BALANCE_LEAF.test(leaf) && !/(used|spent|consumed|cost)/i.test(leaf)`.
2. Vẫn lọt một số hình balance chung chung: `credits_left`, `account.credits`, `user.credits`, `organization.credits`, OpenRouter `/credits` `data.total_credits`. Không command nào hiện gọi các endpoint đó (đã grep), nên không phải regression; nếu muốn chặt hơn thêm `left` vào leaf và `account|user|organization` vào parent — nhưng `user` parent có thể quá rộng, nên chỉ làm khi có endpoint thật.

## Low
- Cmt trong code (usage-extract.ts PR:33-38) tốt, giải thích lý do. OK.
- Test thứ 1 gộp nhiều case trong 1 `it` + loop; fail message sẽ không chỉ ra body nào. Có thể dùng `it.each`. Nit.

## Edge cases (scout)
- `run-state.ts` cộng dồn `credits` qua mọi response của run: trước fix, `leonardo me` cộng cả balance vào tổng run và `history stats` (history-command.ts:138). Fix loại bỏ đúng nguồn này.
- #327 `cost-preflight.ts:160` / receipt `provider_reported.credits` đọc `usage.credits` → được hưởng fix, không cần sửa thêm.
- Thứ tự skip: estimate trước, balance sau — không phụ thuộc nhau, cả hai `continue`; "first credit wins" giờ chọn đúng spend khi balance đứng trước (test `remainingCredits` + `apiCreditCost`).
- `tokensFrom()` chỉ đọc `usage`/`usageMetadata`, không bị `subscriptionTokens` của Leonardo ảnh hưởng.
- Worker (`worker/`) không import `usage-extract` theo grep; `check:mcp` không bắt buộc.

## Tuân thủ AGENTS.md
- Conventional commit `fix(agent)`: OK (publish patch).
- Docs EN + VI cập nhật song song: OK, nội dung tương đương.
- Tests không gọi API trả phí: OK.
- PR body có `Closes #302`, evidence: OK. Issue có claim đầu tiên; các claim sau đã Released.
- Có report review isolated trong `plans/reports/`: OK.

## Conflict resolution guidance
1. `src/core/usage-extract.ts`: giữ toàn bộ main (`UsageSources`, `sources`, `ESTIMATE_PATH`, comment). Thêm khối JSDoc + `BALANCE_LEAF` + `BALANCE_PARENT` + `isBalancePath()` ngay sau `ESTIMATE_PATH`. Trong loop:
   ```ts
   // Estimates stay in metrics but are never reported as cost or credits spent.
   if (ESTIMATE_PATH.test(path)) continue;
   // Balances are never reported as cost or credits spent.
   if (isBalancePath(path)) continue;
   ```
   Không được bỏ dòng ESTIMATE_PATH hay phần gán `out.sources` của main.
2. `tests/unit/core/usage-extract.test.ts`: union — giữ mọi test của main (estimate, sources, ...) và thêm 3 test của PR. Không xung đột ngữ nghĩa (đã chạy cả hai: 18/18).
3. Docs EN/VI dòng `usage`: lấy câu của main (có `sources.*` và câu estimate) rồi nối câu balance của PR vào cuối, ví dụ EN: "... is never reported as `cost_usd` or `credits`. An account balance (Leonardo `apiCredit` from `leonardo me`, HeyGen remaining or included credits from `heygen me`) is never reported as `credits` or `cost_usd` either." Có thể bỏ câu PR "`cost_usd` and `credits` are what the run spent" nếu trùng ý với "Nothing is estimated". VI làm tương tự. Chạy `npm run verify:docs`.
4. Sau merge: `npm run lint && npm run typecheck && npm run build && npm test && npm run verify:docs`, chờ CI xanh.

## Recommended actions
1. Rebase/merge main theo hướng dẫn trên, chạy lại full verification, attach output.
2. (Tuỳ chọn) loại trừ leaf có `used|spent|consumed|cost` khỏi balance match + 1 test.

## Unresolved questions
- Có muốn mở rộng sang `credits_left` / `account.credits` ngay bây giờ hay để issue riêng khi có endpoint thật?

Status: DONE
Verdict: FIX_REQUIRED (chỉ vì conflict; logic MERGE được sau khi resolve)
