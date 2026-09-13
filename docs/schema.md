# Schema dữ liệu — Quay thưởng DHA

Phiên bản luật **phone-v3**, cập nhật **2026-09-13**. Mô tả schema sau migration, không xác nhận database vận hành đã chuyển đổi. Xem [luật quay](luat-quay-thuong.md).

## 1. Tổng quan

SQLite qua better-sqlite3, không ORM. Nguồn: [database.js](../database.js) tạo schema nền cho database mới; [lotterySchema.js](../lotterySchema.js) chuyển đổi lịch sử/ràng buộc; [lottery.js](../lottery.js) quản lý giao dịch.

File mặc định data.db, đổi bằng DATABASE_PATH. Server dùng WAL, foreign_keys = ON, busy_timeout = 5000. Các liên kết dưới đây là quan hệ logic, **không có FOREIGN KEY SQL trong schema mới**. ID lịch sử và ảnh chụp thông tin được giữ khi danh mục thay đổi.

| Model | Mục đích | Khóa |
| --- | --- | --- |
| agencies | Danh mục đại lý được chọn từng lượt | id; code duy nhất |
| prizes | Quà và tồn kho | id; code duy nhất |
| lucky_codes | Mã dự thưởng và lần sử dụng hiện tại | id; code duy nhất |
| phone_participants | Bộ đếm liên tục theo SĐT chuẩn hóa | phone |
| spin_logs | Lịch sử, quà, dữ liệu quyết định, hủy và đồng bộ | id |
| settings | Cấu hình key/value | key |
| schema_migrations | Phiên bản chuyển đổi cấu trúc/dữ liệu đã hoàn thành | version |

Không có campaigns/campaign_id, bảng nhóm hoặc khóa đại lý trong người tham gia. rule_version không chia bộ đếm; schema_migrations không phải kỳ thưởng.

NN = NOT NULL; PK = PRIMARY KEY; UQ = UNIQUE; AI = AUTOINCREMENT; “—” = không khai báo DEFAULT. Trường không ghi NN có thể NULL ở SQL, dù luồng nghiệp vụ luôn điền. Với PK dạng TEXT của SQLite, không suy diễn NOT NULL khi DDL không khai báo. Thời gian là chuỗi TEXT/DATETIME, không phải timestamp số.

## 2. Models và các trường

### 2.1. agencies

Đại lý chỉ là thông tin lựa chọn, không xác định quyền thưởng. Một SĐT được chọn đại lý khác ở lượt sau.

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AI | ID đại lý |
| `code` | TEXT | UQ; — | Mã đại lý; API quay yêu cầu tồn tại |
| `name` | TEXT | NN; — | Tên đại lý |
| `province` | TEXT | NN; — | Tỉnh/thành |
| `address` | TEXT | NN; — | Địa chỉ danh mục |
| `created_at` | DATETIME | CURRENT_TIMESTAMP | Thời điểm tạo |

### 2.2. prizes

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AI | ID quà để trừ/hoàn kho |
| `code` | TEXT | NN, UQ; — | Mã quà thuộc luật |
| `prize_tier` | TEXT | NN; 'GIẢI THƯỞNG' | Cấp giải |
| `name` | TEXT | NN; — | Tên quà |
| `image_url` | TEXT | NN; — | Đường dẫn ảnh |
| `total_quantity` | INTEGER | NN; 0 | Tổng số lượng quà |
| `remaining_quantity` | INTEGER | NN; 0 | Số lượng còn lại; hủy lượt tăng lại |
| `used_quantity` | INTEGER | NN; 0 | Số đã phát ròng; hủy lượt giảm lại |
| `reserved_quantity` | INTEGER | NN; 0 | Tương thích giữ chỗ cũ; luật hiện tại không tạo giữ chỗ, yêu cầu bằng 0 khi quay |

Mã quà: MAYMAN2 = 50k; MAYMAN1 = 100k; CAOLON = D3K2; BA = 500k; NHI = 0,1 chỉ vàng; NHAT = 0,5 chỉ vàng.

Trigger kiểm tra kiểu lưu trữ integer, reserved >= 0, remaining >= reserved, used >= 0 và total = remaining + used. Code còn kiểm tra số nguyên an toàn JavaScript. Sáu mã thuộc luật không được đổi mã/xóa. Admin được sửa metadata/tổng/tồn theo ràng buộc, không trực tiếp đổi used_quantity qua endpoint sửa quà. Thiếu mã cấu hình khác với hết kho.

### 2.3. lucky_codes

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AI | ID mã |
| `serial_number` | TEXT | — | Serial tùy chọn |
| `code` | TEXT | NN, UQ; — | Mã dự thưởng; API trim/chuyển chữ hoa |
| `status` | TEXT | NN; 'unused' | unused hoặc used theo code; SQL không CHECK enum |
| `used_at` | DATETIME | NULL | Thời điểm dùng, hủy đặt NULL |
| `spin_log_id` | INTEGER | NULL | ID lượt đang sử dụng mã; hủy giải phóng về NULL, không FK SQL |

Một mã có thể xuất hiện ở nhiều lượt void và một lượt active; spin_log_id trỏ lần sử dụng hiện tại. Hủy chỉ hoàn khi status = used và liên kết trỏ đúng lượt. UQ code là phân biệt hoa/thường, còn luồng quay tra UPPER(code); không nhập trực tiếp mã chỉ khác chữ hoa/thường.

### 2.4. phone_participants

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `phone` | TEXT | NN, PK; — | SĐT chuẩn hóa, khóa duy nhất toàn chương trình |
| `spin_count` | INTEGER | NN; 0; CHECK integer và >= 0 | Số lượt active, gồm legacy; tăng khi quay, giảm khi hủy |

Không id riêng, không campaign_id, không agency_code và không giới hạn 30. Quay lấy spin_count + 1. Hủy hết giữ dòng đếm 0; dashboard chỉ tính người đếm > 0. Migration dựng bộ đếm từ lịch sử, không từ danh mục đại lý.

### 2.5. spin_logs

#### Danh tính và thông tin tại thời điểm quay

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `id` | INTEGER | PK, AI | ID bất biến; quay lại tạo ID mới |
| `spin_time` | DATETIME | CURRENT_TIMESTAMP | Thời gian gốc; lượt mới ghi giờ local server |
| `agency_code` | TEXT | — | Mã đại lý được chọn |
| `agency_name` | TEXT | — | Tên chụp từ danh mục |
| `province` | TEXT | — | Tỉnh/thành chụp từ danh mục |
| `owner_name` | TEXT | — | Tên chủ đại lý do người quay nhập |
| `phone` | TEXT | — | Lượt mới lưu SĐT chuẩn hóa; legacy giữ chuỗi gốc |
| `normalized_phone` | TEXT | — | SĐT chuẩn hóa, dùng mọi phép đếm/tra cứu/hủy |
| `address` | TEXT | — | Địa chỉ đại lý chụp lúc quay, không lấy từ client để thay thế |
| `entry_code` | TEXT | — | Mã đã sử dụng; immutable sau ghi |
| `serial_number` | TEXT | — | Serial chụp từ mã |

#### Quà đã nhận

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `prize_id` | INTEGER | — | Liên kết logic prizes.id, không FK SQL |
| `prize_code` | TEXT | — | Mã quà bất biến; xét vàng/500k và hoàn kho |
| `prize_tier` | TEXT | — | Cấp giải tại lúc quay |
| `prize_name` | TEXT | — | Tên quà tại lúc quay |
| `prize_image` | TEXT | — | Ảnh quà tại lúc quay |

Các ảnh chụp không tự sửa khi danh mục đổi. Migration không tính lại quà cũ theo lịch mới.

#### Lượt và dữ liệu quyết định

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `spin_number` | INTEGER | — | Lượt tuyệt đối liên tục của SĐT, tính cả legacy |
| `rule_version` | TEXT | — | legacy cho dữ liệu cũ, phone-v3 cho lượt mới; chỉ kiểm toán |
| `decision_reason` | TEXT | — | Lý do nhận quà; legacy dùng LEGACY_IMPORTED |
| `cycle_number` | INTEGER | — | floor((spin_number - 1) / 30) + 1 |
| `position_in_cycle` | INTEGER | — | ((spin_number - 1) % 30) + 1 |
| `decision_a` | INTEGER | — | a trước lượt tuyệt đối 14/25 |
| `decision_b` | INTEGER | — | b trước lượt tuyệt đối 14/25 |

Vòng/vị trí do code tính, không generated columns/CHECK công thức. decision_reason không enum SQL; xem danh sách trong [luật quay](luat-quay-thuong.md). a/b NULL cho lượt không xét mốc và legacy; không dựng lại quyết định lịch sử. a/b đã lưu không đổi khi người khác bị hủy. Phép đếm hiện tại lấy toàn bộ active, không lọc rule_version.

#### Hủy mềm và đồng bộ

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `status` | TEXT | NN; 'active'; CHECK active/void | Hiệu lực của kết quả |
| `voided_at` | TEXT | — | Thời điểm hủy; NULL trước hủy |
| `voided_by` | TEXT | — | Người hủy; endpoint hiện ghi admin |
| `record_version` | INTEGER | NN; 1; CHECK >= 1 | Phiên bản đồng bộ; migration/hủy tăng một đơn vị |
| `is_synced` | INTEGER | 0 | 0 chờ đồng bộ, 1 đã xác nhận; không NN/CHECK ở SQL nền |
| `synced_at` | DATETIME | — | Thời điểm xác nhận; migration/hủy đặt NULL |

Legacy sau migration thường có record_version = 2 và is_synced = 0. Quay lại có ID mới, version = 1. Không dùng is_synced để đếm hiệu lực; lượt void vẫn cần đồng bộ. Không có bảng outbox riêng.

### 2.6. settings

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `key` | TEXT | PK; — | Tên cấu hình |
| `value` | TEXT | — | Giá trị cấu hình dạng chuỗi |

Code dùng admin_password và google_sheet_webhook_url; không đưa giá trị mật khẩu/webhook thật vào tài liệu. Biến môi trường GOOGLE_SHEET_WEBHOOK_URL được worker ưu tiên khi có giá trị.

### 2.7. schema_migrations

| Trường | Kiểu SQL | Ràng buộc / mặc định | Mô tả |
| --- | --- | --- | --- |
| `version` | TEXT | PK; — | Marker chuyển đổi; hiện phone-only-v3 |
| `applied_at` | TEXT | NN; CURRENT_TIMESTAMP | Thời điểm transaction migration hoàn thành |

Độc lập với rule_version của lượt và SĐT. Marker dùng chặn startup database cũ và bảo đảm migration idempotent; không tạo kỳ hoặc reset bộ đếm. Chỉ ghi khi toàn bộ migration thành công.

## 3. Quan hệ, index và trigger

Quan hệ logic: phone_participants.phone → spin_logs.normalized_phone (1:N); agencies.code → spin_logs.agency_code (1:N, ảnh chụp); prizes.id/code → spin_logs.prize_id/prize_code; lucky_codes.spin_log_id → spin_logs.id cho lần dùng hiện tại. Hủy giải phóng mã, không xóa liên kết kiểm toán trên lịch sử.

| Index | Cột / phạm vi | Mục đích |
| --- | --- | --- |
| unique_active_phone_spin | normalized_phone, spin_number; active | Không trùng lượt có hiệu lực |
| one_active_phone_gold | normalized_phone; active, NHI/NHAT | Một vàng/SĐT, gồm legacy |
| one_active_phone_500k | normalized_phone; active, BA | Một 500k/SĐT, gồm legacy |
| unique_active_entry_code | UPPER(entry_code); active | Một lượt đang dùng mỗi mã |
| spin_milestone_lookup | spin_number, status, prize_code, normalized_phone | Đếm a/b và tra mốc |
| spin_phone_latest | normalized_phone, status, spin_number DESC | Lượt cuối theo SĐT |
| spin_entry_lookup | UPPER(entry_code) | Tra mã trong lịch sử |

Ngoài ra có index tự sinh từ PK/UQ. Partial unique indexes không áp dụng với void để lưu nhiều lần quay lại cùng số lượt/mã.

| Trigger | Bảo vệ |
| --- | --- |
| protect_spin_delete | Chặn xóa vật lý lịch sử có SĐT chuẩn hóa |
| protect_spin_update | Chặn sửa dữ liệu kết quả/định danh/ảnh chụp của lịch sử đã chuẩn hóa |
| protect_spin_void_transition | Chỉ active → void, version + 1, có thời điểm/người hủy và không có lượt active lớn hơn của cùng SĐT; không khóa legacy |
| protect_used_lucky_code | Chặn xóa mã đang được lượt active sử dụng |
| protect_rule_prize_code / protect_rule_prize_delete | Chặn đổi/xóa sáu mã quà thuộc luật |
| validate_prize_stock_insert / validate_prize_stock_update | Kiểm tra integer, không âm và cân bằng kho |

Trigger không thay thế transaction nghiệp vụ. Quay/hủy phải cùng kiểm tra, trừ/hoàn kho, cập nhật mã/bộ đếm và lịch sử trong transaction immediate; webhook ngoài transaction. Dữ liệu cũ NULL không hợp lệ bị migration chặn thay vì dựa vào index để bỏ qua.

## 4. Dữ liệu tính toán qua API

| Trường | Ý nghĩa |
| --- | --- |
| spinNumber, cycleNumber, positionInCycle | Giá trị lượt mới, camelCase; không campaignId |
| canUndo, undoReason | Xét active/lượt cuối trên toàn bộ lịch sử SĐT, không chỉ danh sách lọc |
| nextSpinNumber | Số lượt vừa hủy tại commit; không giữ chỗ cho request tiếp theo |
| rule, rule_locked, available_quantity | Mô tả lịch, khóa mã quà, remaining_quantity - reserved_quantity |
| participantCount | Số SĐT có spin_count > 0 |
| milestones[].eligible_count / gold_count | a/b hiện tại toàn chương trình, khác ảnh chụp a/b của từng lượt |

Sheets giữ giao thức spin-record-v2, upsert theo ID/record_version. Cột 13 tương thích kỳ cũ để trống khi cập nhật, cột 14 là lượt tuyệt đối. SQLite chỉ đánh dấu đã đồng bộ khi phiên bản hiện tại khớp xác nhận; phản hồi cũ không ghi đè trạng thái mới.

## 5. Migration và vận hành

- Server không tự chuyển đổi database cũ: thiếu marker thì DATABASE_MIGRATION_REQUIRED trước khi seed/ghi schema. Database mới hoàn toàn mới được tạo bảng/seed tự động; restart database đã sẵn sàng không seed lại.
- Dừng mọi server/worker, chạy `npm run db:migrate` với đúng DATABASE_PATH. CLI backup nhất quán ngoài static trước migration. Toàn bộ chuyển đổi trong một transaction; chạy lại không reset.
- Migration kiểm tra dữ liệu kỳ/nhóm/giữ chỗ rồi chuẩn hóa SĐT, xếp thời gian và ID, đánh số từng SĐT. Từ chối thời gian/SĐT sai, quà không đối chiếu được, mã không trỏ đúng lượt, vi phạm giới hạn hoặc kho không đủ để hoàn lịch sử.
- Giữ nguyên ID, quà, thông tin gốc, kho/mã; bổ sung normalized_phone/lượt/vòng/mã quà/legacy và tăng record_version, chờ đồng bộ. Không tính lại hoặc phát bù quà cũ.
- Các cấu trúc kỳ rỗng được loại bỏ. Database đã có dữ liệu theo kỳ/luật khác phải đối soát riêng, không tự gộp. Chỉ tên kỳ xuất hiện trong code kiểm tra/chuyển đổi tương thích, không trong luồng quay.
- CURRENT_TIMESTAMP mặc định và datetime('now', 'localtime') có nguồn timezone khác nhau; thống nhất timezone server, kiểm tra lịch sử trước chuyển đổi. Migration sắp bằng julianday(spin_time), rồi id; không sửa chuỗi thời gian gốc.
- Không import database.js để xem schema trên dữ liệu thật. Dùng SQLite read-only hoặc database tạm. Không public DB/WAL/SHM/backup hoặc dữ liệu cá nhân.
