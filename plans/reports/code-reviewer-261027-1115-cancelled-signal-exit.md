# Code review: mã lỗi CANCELLED cho exit do tín hiệu (#375)

Ngày: 2026-10-27 (UTC). Phạm vi: working tree so với HEAD (origin/dev), 7 file, +114/-29.
Các file: `src/core/error-classify.ts`, `src/agent/agent-runtime.ts`, `tests/unit/core/error-classify.test.ts`,
`tests/smoke/media-quality.test.ts`, `docs-site/src/content/docs/{,vi/}reference/for-ai-agents.md`, `skill/SKILL.md`.

Kiểm tra đã chạy (Node 22.22.0): `npm run lint` sạch, `npm run typecheck` sạch, `npm run build` ok,
`vitest run tests/unit/core/error-classify.test.ts tests/smoke/media-quality.test.ts tests/unit/agent` 51/51 pass;
hai smoke test tín hiệu thực sự chạy (có ffmpeg), không bị skip.

## Đánh giá chung

Logic cốt lõi đúng: `finalizeRun` nhận 129/130/143 qua `process.exit` đã bị patch (không có `input.error`),
`classifySignalExit` trả `CANCELLED` với `exit_code` thật, nên cả `--json` (`info.exit_code`) lẫn text
(`input.exitCode || 1`, dòng `code: CANCELLED (exit 130 with --json)`) đều giữ mã thật. Lưu ý: mã exit
không đổi so với trước (trước đây UNKNOWN cũng trả `input.exitCode`); thay đổi chỉ là nhãn và hint.
Vấn đề chính nằm ở nội dung hint: nhánh "request đã gửi" đưa lời khuyên sai cho đúng đường duy nhất
có thể kích hoạt nó.

## High

### H1. Hint "sau khi gửi request" sai cho đường duy nhất kích hoạt nó (atlascloud), dễ dẫn tới trả tiền hai lần

- `run.calls` chỉ được điền bởi fetch telemetry (`src/agent/fetch-telemetry.ts:130,133`). Các lệnh `media`
  không fetch (`src/commands/media/media-source.ts:4` từ chối `http:`), nên với media luôn `requestSent=false`.
- Handler tín hiệu của atlascloud chỉ được cài trong `tryLock` (`src/providers/atlascloud/commands/output-claims.ts:162`),
  tức chỉ khi đang tải output trong `deliverPrediction` (`prediction-runner.ts:333`, `:382`), sau khi prediction
  đã ở trạng thái kết thúc và đã bị tính phí. Ctrl-C trong lúc submit/poll không đi qua handler này
  (Node mặc định giết tiến trình, không có envelope).
- Vậy nhánh `CANCELLED_AFTER_SEND` thực tế chỉ xảy ra khi job **đã xong**, nhưng hint nói
  "the job may still run and bill. Check the provider before rerunning." Câu này sai về trạng thái và
  vẫn gợi ý "rerunning". `nextForError` (`src/agent/result-envelope.ts:137`) trả `[]` cho `CANCELLED`,
  nên agent không nhận được lệnh resume an toàn `multix atlas status <id> --wait --download`
  (`resumeCommand`, `prediction-runner.ts:178`) mà rất có thể chạy `multix rerun <id>` → submit lại, trả phí lần hai.
  Với `atlas status <id>` (chỉ GET), hint còn nói có job "may still run and bill" dù lệnh không tạo job nào.
- Docs EN/VI và SKILL.md lặp lại cùng lời khuyên này.
- Đề xuất: khi có `run.ids` (provider id) thì đưa resume/status command vào `next[]` cho `CANCELLED`, và đổi
  hint thành dạng trung tính, ví dụ: "The run was cancelled after a provider request was sent; it may already
  be billed. Resume with the status command in next[] instead of rerunning." Hoặc để nhánh này do lệnh chủ động
  báo (ví dụ atlascloud ghi resume command ra stderr trước khi exit, để `suggestedCommands` bắt được),
  thay vì suy từ `run.calls.length > 0` (vốn tính cả GET tải file/CDN).
- Thiếu test: không có test nào đi qua `finalizeRun` với `run.calls` không rỗng; test unit chỉ kiểm tra regex
  của hằng chuỗi.

## Medium

### M1. "nothing was left behind" sai khi nhận tín hiệu lần hai ở media
`cancellable` (`src/commands/media/media-quality-commands.ts:65`) gọi `process.exit` ngay ở tín hiệu thứ hai,
trước khi `finally` của `media-frames.ts:206` (`rmSync(stage)`) hay `media-rule.ts:156` chạy; không có
handler `exit` nào dọn `.frames-*`. Envelope/hint vẫn khẳng định "nothing was left behind". Đề xuất: hoặc
nới hint ("Temporary files were removed unless the run was interrupted twice"), hoặc chỉ gắn câu đó khi
cleanup đã chạy (ví dụ hint riêng cho lần exit thứ hai). Docs EN/VI cũng khẳng định "cleaned up its temporary files".

### M2. Các bề mặt liệt kê exit code khác chưa cập nhật
- `src/commands/agent/guide-command.ts:26-29` (`multix guide`, giao thức cho agent "for the installed version",
  được SKILL.md trỏ tới) vẫn chỉ liệt kê 1-6.
- `README.md:84-88` liệt kê exit code `--json` không có 129/130/143 và nói "plain runs keep exit 1", nay
  mâu thuẫn với docs-site mới ("keeps its 128 + signal exit code in both modes").
- `nextForError` không có case `CANCELLED` (xem H1).
- Không tìm thấy nơi nào khác cần cập nhật: `worker/src/api/api-http.ts` có `ApiErrorCode` riêng, không dùng
  `ErrorCode` của CLI; `Record<ErrorCode, …>` (HINTS, EXIT_BY_CODE) được tsc ép đủ; ledger chỉ lưu `code` chuỗi.

## Low

### L1. `EXIT_BY_CODE.CANCELLED = 130` là giá trị ma
Chỉ `classifySignalExit` tạo `CANCELLED` và luôn ghi đè `exit_code`. Không sai, nhưng nên dùng hằng
`EXIT_CODES` có tên hoặc ghi chú để khỏi bị hiểu nhầm là mọi CANCELLED đều 130.

### L2. Docs nói chung "(SIGHUP, Ctrl-C, SIGTERM)" cho mọi lệnh
Atlascloud chỉ xử lý SIGINT/SIGTERM (`output-claims.ts:223-224`); SIGHUP ở đó giết tiến trình, không có envelope.
Nên ghi rõ: chỉ các lệnh tự dọn dẹp (`media inspect/verify/frames`, atlascloud khi tải output) mới trả `CANCELLED`;
tín hiệu không được xử lý kết thúc tiến trình mà không in envelope.

### L3. Bảng docs đặt dòng 129/130/143 với cột "Exit" nhưng câu mở đầu đoạn nói "These exit classes apply in agent mode"
Ngay sau đó có câu bổ sung "keeps … in both modes" nên không sai, chỉ hơi lủng củng. Không chặn.

## Edge case đã kiểm và không có lỗi

- Đường không phải tín hiệu exit 129/130/143: grep `process.exit(`/`process.exitCode =` trong `src/` — chỉ
  `media-quality-commands.ts` và `output-claims.ts` phát các mã này. `check.ts:327` chỉ 0/1. `rerun`
  (`history-command.ts:259-261`) truyền mã của tiến trình con nhưng đặt `run.finalized = true` trước, nên
  `finalizeRun` trả sớm, không gắn nhãn sai. `stdin-file.ts:174` re-raise tín hiệu (chết do tín hiệu,
  không qua `finalizeRun`). Không thấy rủi ro gắn nhãn nhầm.
- `classifySignalExit` đứng trước `classifyMessage(run.lastErrorLine…)`, nên dòng lỗi cũ trong stderr không
  che mất CANCELLED; đúng ý đồ.
- Text mode: `info.exit_code` = mã thật nên dòng `(exit 130 with --json)` chính xác; smoke test xác nhận.
- Tương thích: thêm thành viên union `ErrorCode` là mở rộng; consumer `switch` đầy đủ bên ngoài có thể cần
  case mới nhưng `error.code` vốn đã là chuỗi mở. Không thấy breaking change.

## Chất lượng test

- Unit: bao phủ 3 mã, giá trị biên (131, 137, 0-6) tốt; nhánh `requestSent` chỉ kiểm hằng chuỗi.
- Smoke: thực sự gửi SIGINT/SIGTERM, kiểm dọn staging, exit code thật, envelope JSON. Thiếu SIGHUP (129) và
  thiếu test tích hợp cho nhánh có request (atlascloud qua `finalizeRun`). Không có phantom test.

## Hành động đề xuất (theo ưu tiên)

1. Sửa H1: bỏ lời khuyên "may still run… before rerunning" cho trường hợp job đã xong; đưa resume/status
   command vào `next[]`; thêm test qua `finalizeRun` với `run.calls`/`run.ids` không rỗng.
2. Sửa M1: hint không khẳng định "nothing was left behind" khi cleanup bị bỏ qua ở tín hiệu thứ hai.
3. Cập nhật `guide-command.ts` và `README.md` (M2) cho thống nhất với docs-site và SKILL.md.
4. Tùy chọn: L1, L2.

## Câu hỏi chưa giải quyết

- Có muốn atlascloud cài handler tín hiệu từ lúc submit (để Ctrl-C khi đang poll cũng ra envelope CANCELLED
  kèm resume command) không? Đó là thay đổi hành vi ngoài phạm vi #375, nên mở issue riêng nếu cần.
