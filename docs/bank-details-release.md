# Quay số 100% trúng thưởng — bàn giao cập nhật ngân hàng

## Điều kiện trước phát hành

- `config/banks.json` chủ động để trống: chưa có danh mục nghiệp vụ duyệt. Không có ngân hàng mẫu hoặc tùy chọn “Khác” trên form thật. API và nút quay chặn khi danh mục chưa sẵn sàng.
- Điền danh mục đã duyệt vào file này hoặc đặt `BANK_CATALOG_PATH` tới file JSON riêng, dùng mảng `{ "code": "MA_DUOC_DUYET", "name": "Tên hiển thị được duyệt" }`. Code viết hoa, tối đa 32 ký tự A–Z/0–9/_/-, duy nhất; tên cũng duy nhất. Ví dụ cấu trúc này không phải ngân hàng được phép sử dụng.
- Chưa có bộ ảnh được duyệt. Không phát hành với ảnh cũ: `img/pc-background.png`, `img/mobile-background.png`, `img/pc-logo.png` vẫn chứa tên/số lượng/thể lệ cũ. Không tự vẽ hoặc sửa bitmap khi chưa được duyệt.
- Thay ảnh cùng kích thước/tỷ lệ hiện có. CSS đặt form và tra cứu theo chiều cao nội dung; cắt vùng trống phía trên ảnh nền (desktop 47,5% chiều rộng, mobile 230%) để cơ cấu nằm sau form. Giữ phần cơ cấu bắt đầu ở vị trí tương ứng hoặc chỉnh lại tỷ lệ cắt khi duyệt ảnh.
- Header HTML và popup đã dùng tên mới. Logo chính cần artwork “QUAY SỐ 100% TRÚNG THƯỞNG”; popup nếu bổ sung artwork dùng “QUAY SỐ TRÚNG THƯỞNG”.

## Nội dung gửi thiết kế duyệt

- Cơ cấu ở cả bảng giải và thể lệ: 650 giải may mắn 1, mỗi giải 100.000 đồng; 900 giải may mắn 2, mỗi giải 50.000 đồng. Không đổi giá trị tiền hay luật phân phối lượt.
- Bước nhập thông tin: chọn tỉnh/thành theo địa chính cũ, chọn tên đại lý; nhập SĐT, địa chỉ, mã dự thưởng; chọn ngân hàng và nhập số tài khoản, tên chủ tài khoản đúng tên hiển thị. Không yêu cầu tên chủ đại lý hoặc trường TDV không có trên form.
- Note tỉnh: “Theo địa chính cũ — dùng để xác định tỉnh TDV phụ trách”. Note tài khoản: “Vui lòng nhập chính xác tên hiển thị trên tài khoản ngân hàng”.
- Cần nghiệp vụ duyệt lại quy định ảnh đang ghi chỉ chi trả qua tài khoản đã đăng ký trước đó: không tự thay đổi điều kiện nhận thưởng thành tài khoản bất kỳ vừa nhập.

## API và dữ liệu

- `GET /api/banks` trả `{ success: true, banks: [{ code, name }] }`; danh mục trống/lỗi trả 503. Form có tải lại, không submit khi chưa có danh mục.
- `POST /api/spin`: giữ `province`, `agencyCode`, `agencyName`, `phone`, `address`, `entryCode`; bỏ `ownerName`, thêm `bankName` (tên hiển thị trong danh mục), `bankAccountNumber`, `bankAccountHolderName` dạng chuỗi bắt buộc. Backend tự tra mã ngân hàng; vẫn chụp tỉnh/tên/địa chỉ đại lý từ DB như trước.
- Chỉ trim đầu/cuối tài khoản và tên chủ tài khoản; không ép số, bỏ dấu hay tự viết hoa. Giới hạn 100/200 ký tự, từ chối ký tự điều khiển; không khẳng định thông tin nhập đã được ngân hàng xác minh.
- Admin và Excel nhận đủ thông tin; tài khoản Excel giữ kiểu text. Không ghi thông tin tài khoản vào log hoặc localStorage.
- Lịch sử công khai chỉ dựa vào SĐT, chưa có xác thực: chỉ trả tên ngân hàng và `bank_account_number_masked` (tối đa 4 ký tự cuối; tài khoản ngắn che toàn bộ). Không trả tên chủ tài khoản hoặc số tài khoản đầy đủ. Muốn xem đầy đủ phía người dùng cần một task xác thực riêng.

## Migration và triển khai

1. Chuẩn bị danh mục, ảnh đã duyệt và xác minh dữ liệu tỉnh trong danh mục đại lý là địa chính cũ. Chỉ thêm note không chuyển đổi dữ liệu tỉnh tự động.
2. Dừng server và worker. Sao lưu SQLite bằng backup API để bao gồm WAL; không chỉ copy `data.db` khi còn tiến trình ghi.
3. Chạy `npm run db:migrate` trên bản sao trước; `DATABASE_PATH` chọn bản sao và `DATABASE_BACKUP_DIR` chọn thư mục backup riêng. Mặc định backup đặt tại `~/.quaythuongdha-backups` với quyền file 0600.
4. Migration thực hiện một transaction: chạy migration luật nếu cần; thêm bốn cột ngân hàng (gồm mã tra nội bộ), bỏ `owner_name`; giữ ID/kết quả/mã/số lượt và bộ đếm. Bản ghi cũ để NULL ngân hàng, không suy tên chủ tài khoản từ chủ đại lý. Tăng `record_version`, đánh dấu cần đồng bộ để xóa trường cũ trong Sheet.
5. Đặt tổng MAYMAN1/MAYMAN2 = 650/900, giữ `used_quantity`, tính `remaining_quantity = total - used`. Nếu số đã dùng + giữ chỗ vượt tổng mới, rollback toàn bộ và yêu cầu đối soát; không reset hay sửa lịch sử. Marker ngăn lần chạy lại ghi đè kho đã phát sinh tiếp.
6. Backup chứa cột chủ đại lý cũ để có thể khôi phục. Bảo vệ quyền truy cập/retention cho file này. Không triển khai migration production tự động từ task này.
7. Backup Google Sheet, triển khai Apps Script mới từ admin hoặc `docs/google-sheets-sync.gs` trước khi bật worker. Protocol `spin-record-v3` từ chối nhầm script v2. Cột 6 đổi từ chủ đại lý sang ngân hàng; hai cột cuối thêm số/tên tài khoản, giữ vị trí các cột luật/version. Script xóa nội dung cột chủ đại lý cũ, không coi đó là tên ngân hàng. Header tùy biến hoặc ID trùng cần đối soát thủ công.
8. Chạy migration thật khi đã duyệt, khởi động server/worker cùng phiên bản, quay bằng mã kiểm thử được cấp, kiểm tra admin/export/Sheet và màn hình điện thoại. Không dùng mã hoặc dữ liệu người thật cho kiểm thử tự động.

## Rollback

Dừng server/worker, khôi phục cả code và bản backup SQLite trước migration; khôi phục Sheet và Apps Script cùng phiên bản. Nếu đã có lượt mới sau phát hành, phải đối soát trước khi restore, không bỏ các lượt phát sinh.

## Kiểm thử

- `npm test` / `npm run verify:lottery`: dùng DB và danh mục ngân hàng giả trong thư mục tạm; không gọi webhook thật. Bao gồm validation, khóa ảnh chụp, rollback kho, migration từ legacy/phone-v3, đồng thời, undo/replay, API, Excel và mô phỏng Apps Script.
- `npm run verify:form`: kiểm tra Chromium với API giả ở 375/768/1440px, cả root và base path; kiểm tra thiếu danh mục/tải lại, validation, payload, popup/lịch sử và không đè/tràn form. Cần Playwright và Chromium có sẵn trong môi trường QA; có thể đặt `PLAYWRIGHT_MODULE` tới module cài riêng. Không thêm Playwright vào dependency runtime, không tự tải browser. Script chỉ lưu screenshot trong thư mục tạm, không dùng dữ liệu thật.
- Phiên chạy này: 42 kịch bản backend đạt; migration trên SQLite backup có WAL đạt integrity check. Chromium bị chặn bởi sandbox/cơ chế cấp quyền nên script trình duyệt chưa được chạy đến bước nghiệm thu. Chưa xác nhận Chrome mobile thực tế hoặc Safari; vẫn cần QA trên thiết bị và bộ ảnh được duyệt.
