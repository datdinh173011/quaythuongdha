# Luật quay thưởng DHA — theo SĐT

Phiên bản luật: **phone-v3**. Cập nhật: **2026-09-13**.

Tài liệu mô tả code hiện tại, không xác nhận database vận hành đã chuyển đổi. Không có kỳ thưởng; SĐT chuẩn hóa là khóa người tham gia duy nhất. Phiên bản luật chỉ phục vụ kiểm toán, không chia/reset bộ đếm.

Nguồn: [bộ máy thưởng](../lottery.js), [schema/migration](../lotterySchema.js), [API](../server.js), [models](schema.md), [worker](../syncWorker.js), [Apps Script](google-sheets-sync.gs), [lệnh migration](../scripts/migrate-database.js), [kiểm chứng](../scripts/verify-lottery.js).

## 1. Q&A đã chốt

| Câu hỏi | Quyết định |
| --- | --- |
| Định danh người tham gia? | SĐT chuẩn hóa; không gộp theo đại lý, không chia theo kỳ. |
| Có được đổi đại lý? | Có. Chọn đại lý hợp lệ ở từng lượt; không reset bộ đếm/quyền nhận thưởng. |
| Lịch sử cũ có tính tiếp? | Có. Đánh số theo thời gian, rồi ID nếu cùng thời điểm, cho từng SĐT; giữ nguyên quà cũ. |
| Có hủy lượt cũ được không? | Có, nếu là lượt có hiệu lực cuối cùng của SĐT; hoàn đúng quà và mã cũ. |
| Công thức vàng? | Giữ nguyên `a < b * 4` ở lượt 14; `a < b * 3` ở lượt 25. |
| Có chia nhóm/giữ chỗ vàng? | Không. Không cam kết đúng một vàng trên 4/3 người. |
| Sau lượt 30? | Lặp lịch 30 vị trí, số lượt tuyệt đối vẫn tăng. |
| Vàng/500k có lặp? | Không; chỉ xét vàng ở lượt tuyệt đối 14/25, 500k ở lượt 8. Giới hạn tính cả quà cũ chưa hủy. |
| Hết vàng? | Mốc 14 trả 50k; mốc 25 trả 100k. Hết quà cần phát thì dừng, không tiêu mã. |
| Quay lại có kết quả cũ? | Không; ID mới, xét dữ liệu/kho hiện tại, random mới nếu đủ điều kiện. |
| Kiểm tra doanh số/OTP? | Chưa. Mã dự thưởng hợp lệ vẫn bắt buộc; “mốc nhập” chưa được kiểm tra bằng dữ liệu doanh số. |

**Hệ quả công thức:** nếu không có lịch sử trúng vàng tại các mốc tương ứng thì `b = 0`, điều kiện nhỏ hơn luôn sai. Hệ thống không tự phát vàng đầu tiên. Không đảo dấu, thêm giải khởi tạo hoặc seed người trúng trong vận hành. Legacy có thể đóng góp `b` nếu đúng mốc và đúng quà; fixture trúng mẫu chỉ dùng kiểm thử.

## 2. Định nghĩa và lịch quà

- SĐT: bỏ khoảng trắng, dấu chấm, gạch ngang, ngoặc; đổi đầu `+84`/`84` thành `0`. Chấp nhận `^0[1-9][0-9]{8,9}$` (10 hoặc 11 chữ số). Không xác minh sở hữu bằng OTP.
- Lượt thành công có hiệu lực: bản ghi `active`, chưa hủy; gồm legacy đã chuyển đổi.
- Người tham gia: một dòng `phone_participants` theo SĐT; `spin_count` bằng số lượt có hiệu lực. Hủy hết có thể để lại dòng với `spin_count = 0`.
- Lần xét vàng: chỉ lượt tuyệt đối 14/25, không dùng vị trí trong vòng để xét lại vàng.
- Không khóa SĐT–đại lý. Tên/tỉnh/địa chỉ đại lý chụp từ database khi quay; thông tin ngân hàng do người quay nhập, tên/mã ngân hàng đối chiếu danh mục được duyệt. Không còn thu thập tên chủ đại lý.

```js
const spinNumber = successfulSpinCount + 1;
const cycleNumber = Math.floor((spinNumber - 1) / 30) + 1;
const positionInCycle = ((spinNumber - 1) % 30) + 1;
```

| Vị trí | Quà theo lịch | Mã quà |
| --- | --- | --- |
| 1, 2, 5, 10, 11, 19, 23, 27 | 50k | `MAYMAN2` |
| 3, 4, 7, 12, 15, 16, 18, 20, 22, 24, 26, 28, 30 | 100k | `MAYMAN1` |
| 6, 9, 13, 17, 21, 29 | D3K2 | `CAOLON` |
| 8 | 500k chỉ lượt tuyệt đối 8 nếu chưa có 500k; còn lại 100k | `BA` hoặc MAYMAN1 |
| 14 | Lượt tuyệt đối 14 xét vàng 0,1 chỉ; vòng sau 50k | `NHI` hoặc MAYMAN2 |
| 25 | Lượt tuyệt đối 25 xét vàng 0,5 chỉ; vòng sau 100k | `NHAT` hoặc MAYMAN1 |

Ví dụ: 31 → vòng 2/vị trí 1 → 50k; 38 → vị trí 8 → 100k; 44 → vị trí 14 → 50k; 55 → vị trí 25 → 100k; 61 → vòng 3/vị trí 1 → 50k. Lượt 68 không phát 500k; 74/85 không xét vàng.

Mỗi SĐT tối đa một vàng (NHI hoặc NHAT) và một BA trên **toàn bộ kết quả chưa hủy**, không phân biệt phiên bản luật. Nếu đã có BA ngoài mốc 8, lượt 8 mới nhận 100k. Nếu đã có vàng tại bất kỳ lượt cũ nào, mốc 14/25 nhận tiền tương ứng. Không phát bù mốc đã đi qua khi chuyển đổi.

## 3. Thuật toán vàng

Đếm trong transaction, trước lượt đang xử lý, chỉ lấy `active`, bao gồm legacy. Unique SĐT/số lượt bảo đảm đếm bản ghi tương đương đếm SĐT.

### Lượt tuyệt đối 14

- `a`: số SĐT đã có kết quả lượt 14; `b`: số SĐT trong tập đó nhận NHI tại lượt 14.
- Lưu a/b để đối soát. Nếu SĐT đã có vàng tại bất kỳ lượt nào hoặc hết NHI: trả 50k.
- Nếu `a < b * 4`: `crypto.randomInt(0, 4) === 0`, 25% NHI và 75% MAYMAN2. Không thỏa: MAYMAN2.

### Lượt tuyệt đối 25

- `a`: số SĐT đã có lượt 25 và có lượt 14 active nhận MAYMAN2; `b`: số SĐT trong tập đó nhận NHAT tại lượt 25.
- Lưu a/b kể cả khi SĐT đang quay không đủ điều kiện. Nếu đã có vàng tại bất kỳ lượt nào: trả 100k.
- Thiếu lượt 14 hoặc lượt 14 không nhận MAYMAN2: trả 100k, không đủ điều kiện xét vàng. Hết NHAT: trả 100k.
- Nếu `a < b * 3`: `crypto.randomInt(0, 10000) < 3333`, đúng 33,33% NHAT và 66,67% MAYMAN1. Không thỏa: MAYMAN1.

Ví dụ: mốc 14 với a = 3, b = 1 được random; a = 4 hoặc 5 chỉ tiền. Mốc 25 với a = 2, b = 1 được random; a = 3 hoặc 4 chỉ tiền. Đây là ví dụ kiểm thử, không phải cơ chế tạo người trúng.

| decision_reason | Ý nghĩa |
| --- | --- |
| SCHEDULE | Quà theo lịch, gồm tiền ở vị trí 14/25 sau vòng đầu |
| REPEATED_500K_CASH | Vị trí 8 sau vòng đầu nhận 100k |
| CASH_500K_ALREADY_WON | Lượt 8 nhận 100k vì đã có BA |
| GOLD_ALREADY_WON | Đã có vàng active, nhận tiền tại mốc |
| MILESTONE_14_INELIGIBLE | Lượt 25 không có lượt 14 nhận MAYMAN2 |
| GOLD_OUT_OF_STOCK_CASH | Hết vàng, chuyển tiền |
| FORMULA_FALSE_CASH | Điều kiện nhỏ hơn không thỏa |
| RANDOM_GOLD / RANDOM_CASH | Kết quả random khi đủ điều kiện |
| LEGACY_IMPORTED | Quà cũ giữ nguyên, nhập vào chuỗi lượt theo SĐT |

## 4. Kho, giao dịch và hủy lượt

- Mỗi lượt phải có đủ sáu mã quà. Số lượng nguyên an toàn; tổng = còn lại + đã phát, không âm. Thiếu cấu hình khác hết kho.
- Không giữ chỗ vàng. `reserved_quantity` là trường tương thích, phải bằng 0 khi quay; còn giữ chỗ phải đối soát, không tự giải phóng.
- Hết vàng chuyển tiền. Quà được chọn hết thì `OUT_OF_STOCK`, rollback; không tự đổi quà hoặc random lại vì thiếu tiền.
- Kiểm tra mã, tính lượt, đọc a/b, chọn quà, trừ kho, ghi lịch sử, tăng lượt, tiêu mã trong một transaction immediate.
- Request trùng mã không phát hai lần. Nếu commit nhưng mất response, gửi lại báo mã đã dùng; tra lịch sử để xác nhận.
- Webhook ngoài transaction. Lỗi ghi/tiêu mã/hoàn dữ liệu phải ném ngoại lệ và rollback toàn bộ.

### Hủy và quay lại

`DELETE /api/admin/spins/:id` chỉ hủy lượt active có số lượt lớn nhất của **SĐT đó**, kể cả legacy. Muốn hủy 14 khi đã đến 25, hủy 25 → 24 → … → 14. Không cần hủy lượt người khác dù họ quay sau.

Trong cùng transaction: kiểm tra lượt cuối; hoàn đúng `prize_id`/`prize_code`; giảm `used_quantity`; giải phóng mã đang trỏ tới ID cần hủy; giảm `spin_count`; đổi void, ghi thời điểm/người hủy, tăng `record_version`, đưa về chờ đồng bộ. Hủy lặp không hoàn lần hai; không xóa vật lý bằng chứng.

Quay lại tạo ID mới cùng số lượt, dùng mã được hoàn hoặc mã khác. Không phục hồi quà cũ: lượt legacy từng nhận 100k nhưng được đánh số 6 khi quay lại nhận D3K2 theo luật hiện tại nếu còn kho. Mốc vàng random mới khi đủ điều kiện.

Hủy thay đổi a/b tương lai, không sửa kết quả hoặc a/b đã lưu của người khác. Admin phải thu hồi/đối soát quà thực tế, không chỉ hoàn kho phần mềm. Xác thực admin hiện dùng mật khẩu chung; `voided_by = admin`, không phải tài khoản cá nhân.

## 5. API, quản trị và Google Sheets

- Spin giữ cấu trúc quà, trả `spinNumber`, `cycleNumber`, `positionInCycle`; không còn `campaignId`, không trả a/b nội bộ.
- Lịch sử chỉ trả active theo SĐT chuẩn hóa, gồm legacy đã chuyển đổi.
- Admin xem active/void; `canUndo`/`undoReason` xét toàn bộ lịch sử, không chỉ 500 dòng/bộ lọc. Backend kiểm tra lại khi hủy.
- Dashboard đếm SĐT có spin_count > 0 và a/b toàn chương trình. Excel có lượt tuyệt đối, vòng/vị trí, trạng thái/thời điểm/người hủy, phiên bản và dữ liệu quyết định; bỏ cột kỳ.
- Worker dùng `spin-record-v3` (độc lập phiên bản luật), tối đa 100 dòng/lô; mỗi 120 giây, lần đầu sau 15 giây. Gửi cả active/void chờ đồng bộ, gồm thông tin ngân hàng.
- Sheets upsert theo ID, chỉ nhận nội dung có phiên bản cao hơn. Gửi trùng không thêm dòng. Phản hồi phải xác nhận đúng toàn bộ ID/phiên bản; lỗi/JSON sai/thiếu xác nhận không đánh dấu đã đồng bộ.
- UPDATE xác nhận kiểm tra phiên bản hiện tại; phản hồi quay cũ không thể đánh dấu trạng thái hủy mới đã đồng bộ.
- Giữ **25 cột**: cột 13 “Kỳ Thưởng (Không Sử Dụng)” ghi rỗng khi cập nhật, cột 14 “Lượt Tuyệt Đối”. Chấp nhận tiêu đề cũ “Kỳ Thưởng”/“Lượt Trong Kỳ”, không dịch dữ liệu. Dòng chưa đồng bộ lại có thể tạm còn nội dung cũ.
- Dừng nếu tiêu đề tùy biến hoặc trùng ID; không tự xóa cột. Cập nhật deployment Apps Script trước khi bật worker; mẫu Admin khớp file .gs.

## 6. Migration và vận hành

1. Dừng tất cả server/worker; chọn đúng `DATABASE_PATH`, giữ nguyên múi giờ server.
2. Chạy `npm run db:migrate`. Lệnh yêu cầu database tồn tại, đọc .env, backup nhất quán bằng SQLite backup API vào `~/.quaythuongdha-backups/before-phone-v3-<timestamp>-<uuid>.db` trước migration. Backup ngoài static, file quyền 0600.
3. Transaction immediate kiểm tra sáu mã quà, không có dữ liệu kỳ/nhóm hoặc giữ chỗ. Dữ liệu đã có luật/kỳ khác phải đối soát riêng, không tự gộp.
4. Chuẩn hóa SĐT, sắp thời gian rồi ID, đánh số liên tục từng SĐT. Giữ ID, thông tin người quay, quà thực nhận, thời gian, kho và mã; không suy ra quà cũ từ lịch mới.
5. Dừng và rollback DDL/dữ liệu nếu SĐT/thời gian sai, không đối chiếu được ID/mã/tên quà, cấp giải đã lưu mâu thuẫn danh mục, mã used không trỏ đúng lượt, lịch sử trùng vàng/500k hoặc used_quantity không đủ để hoàn lịch sử. Cấp giải cũ trống được giữ nguyên khi ID/tên xác định được quà; không tự điền hay đổi kết quả.
6. Lượt cũ: `rule_version = legacy`, `decision_reason = LEGACY_IMPORTED`; a/b giữ NULL vì không thể dựng quyết định cũ. Tăng phiên bản một đơn vị (thường 1 → 2), `is_synced = 0`, `synced_at = NULL`.
7. Dựng bộ đếm/ràng buộc, bỏ cấu trúc kỳ rỗng nếu có; ghi `schema_migrations` phiên bản `phone-only-v3`. Chạy lại không đánh số/reset, CLI vẫn backup mỗi lần.
8. Cập nhật Apps Script; đối soát lượt/SĐT, kho/mã/ID trước–sau rồi khởi động. Theo dõi dòng chờ đồng bộ và lỗi webhook.

Server **không tự chuyển đổi database cũ**: thiếu marker thì dừng `DATABASE_MIGRATION_REQUIRED` trước khi seed/ghi schema. Database mới hoàn toàn được tạo schema/dữ liệu mẫu theo chức năng khởi tạo sẵn có, không cần kích hoạt kỳ. Database sẵn sàng không seed lại khi restart.

Không restore backup sau khi có lượt mới nếu chưa đối soát. Mọi tiến trình dùng chung một file SQLite, không chạy bản sao độc lập. Không public database/WAL/SHM/backup; không đưa SĐT thật hoặc dữ liệu người trúng vào tài liệu.

### Lỗi chính

| Mã | Xử lý |
| --- | --- |
| DATABASE_MIGRATION_REQUIRED | Dừng dịch vụ, migration có backup |
| LEGACY_RECONCILIATION_REQUIRED | Dữ liệu cũ/giữ chỗ chưa an toàn, đối soát riêng |
| INVALID_PHONE, MISSING_FIELDS, INVALID_AGENCY | Sửa đầu vào; đại lý phải tồn tại |
| INVALID_CODE, ALREADY_USED | Kiểm tra mã/lịch sử |
| PRIZE_NOT_CONFIGURED, INVALID_STOCK | Đối soát cấu hình/kho |
| OUT_OF_STOCK | Mã/lượt không đổi; bổ sung đúng quà |
| NOT_LATEST_SPIN, SPIN_ALREADY_VOID, SPIN_NOT_FOUND | Chỉ hủy ID active cuối của SĐT |
| CODE_STATE_CONFLICT, SPIN_STATE_CONFLICT | Mã/bộ đếm không khớp; rollback, đối soát |
| SPIN_LOCKED, INVALID_VOID_TRANSITION, CODE_LOCKED, PRIZE_LOCKED | Chặn sửa/xóa không hợp lệ |
| INVALID_SPIN_NUMBER | Vượt miền số nguyên an toàn, không tăng tiếp |

## 7. Nghiệm thu

`npm run verify:lottery` dùng database tạm: lịch 1–90; SĐT/đại lý; nhánh nhỏ hơn/bằng/lớn hơn, biên random; legacy/bộ đếm/giới hạn; thiếu kho/rollback; hủy/quay lại; nhiều kết nối đồng thời; migration/backup/idempotent/restart/dữ liệu sai; Sheets sai thứ tự/phiên bản; API, Excel, static và tài liệu. Không gọi webhook thật hoặc phát thưởng trên database vận hành.
