# Quay thưởng DHA — BioAmicus

> Bản cập nhật ngân hàng cần migration `bank-details-v1`, danh mục được duyệt và bộ ảnh mới trước khi phát hành. Xem [hướng dẫn triển khai và đầu vào còn thiếu](docs/bank-details-release.md). Không chạy migration khi server/worker còn ghi dữ liệu.

Ứng dụng quay thưởng bằng mã dự thưởng, gồm giao diện người tham gia và trang quản trị. Một tiến trình Node.js phục vụ cả giao diện, API và tác vụ đồng bộ Google Sheets; dữ liệu được lưu trong SQLite trên máy chạy ứng dụng.

Luật hiện hành: [Luật quay thưởng theo SĐT — phone-v3](docs/luat-quay-thuong.md). [Models và trường dữ liệu](docs/schema.md). SĐT chuẩn hóa là khóa duy nhất, cộng cả lịch sử cũ; không có kỳ thưởng. Lặp lịch 30 lượt, vàng chỉ xét lượt tuyệt đối 14/25, 500k chỉ lượt 8; giới hạn tính cả quà cũ chưa hủy. Giữ nguyên `a < b * 4/3`: nếu b = 0 thì không tự phát vàng. Admin được hủy lượt cuối từng SĐT, kể cả lượt cũ, và quay lại theo luật hiện tại.

> **Cần đánh giá bảo mật trước khi public.** Static đã giới hạn vào tài nguyên giao diện để không lộ database, mã nguồn backend và vị trí trúng. Cơ chế xác thực admin vẫn chưa phù hợp cho production. Đọc mục **Lưu ý bảo mật và giới hạn hiện tại** trước khi triển khai ra Internet.

## 1. Chức năng

- Chọn tỉnh/thành, đại lý, nhập thông tin người tham gia và mã dự thưởng để quay.
- Kiểm tra mã tồn tại, chưa sử dụng và kho quà còn hàng. Backend lặp lịch 30 vị trí theo SĐT, không gộp đại lý; hết vàng tự trả tiền tại hai mốc.
- Lưu lịch sử, trừ tồn kho và đánh dấu mã đã dùng trong cùng một transaction SQLite.
- Tra cứu lịch sử quay theo số điện thoại.
- Quản trị đại lý, giải thưởng/ảnh quà tặng, mã dự thưởng/serial, lịch sử và thống kê.
- Nhập danh sách đại lý, mã dự thưởng từ Excel; xuất lịch sử quay ra Excel.
- Đồng bộ lịch sử sang Google Sheets qua webhook Google Apps Script, tự động hoặc thủ công.

## 2. Công nghệ

| Thành phần | Công nghệ | Vai trò |
| --- | --- | --- |
| Runtime | Node.js ≥22, CommonJS | Chạy backend; yêu cầu ≥22 đến từ `better-sqlite3` trong lockfile |
| HTTP server | Express 5 | API, middleware, phục vụ giao diện và ảnh |
| Database | SQLite, `better-sqlite3` 13 | Database dạng file, transaction, chế độ WAL |
| Upload | Multer 2 | Lưu ảnh vào `uploads/`; nhận file Excel trong bộ nhớ |
| Excel backend | `xlsx` 0.18.5 | Đọc file import và tạo file export |
| Cấu hình | dotenv 17 | Nạp biến môi trường từ `.env` |
| CORS | cors 2 | Middleware CORS, hiện dùng cấu hình mặc định |
| Frontend | HTML, CSS, JavaScript thuần | Không dùng React/Vue, không có bước bundle/build |
| Đồng bộ | `fetch` của Node.js, timer | Gửi lịch sử tới webhook ngay trong tiến trình server |

Phiên bản dependency khai báo nằm trong `package.json`; phiên bản cài đặt được chốt bởi `package-lock.json`.

**Tài nguyên tải từ bên ngoài ở trình duyệt:** Google Fonts (Nunito), `canvas-confetti` qua jsDelivr ở trang quay thưởng và `xlsx` qua jsDelivr ở trang Admin để tạo file mẫu. Đây không phải bước build frontend. Mạng chặn CDN có thể ảnh hưởng font, hiệu ứng hoặc chức năng tải mẫu Excel.

## 3. Cấu trúc thư mục

```text
quaythuongdha/
├── README.md           # Hướng dẫn chạy và vận hành
├── package.json        # Scripts và dependencies Node.js
├── package-lock.json   # Phiên bản dependencies được chốt
├── server.js           # Entry point backend, API, auth, upload, import/export
├── database.js         # Mở SQLite, kiểm tra migration; khởi tạo database mới
├── lottery.js          # Lịch quà theo SĐT, công thức vàng, transaction quay/hủy
├── lotterySchema.js    # Schema SĐT, chuyển đổi lịch sử và bảo vệ dữ liệu
├── docs/luat-quay-thuong.md # Luật nghiệp vụ và checklist vận hành
├── scripts/            # Migration có backup và kiểm chứng database tạm
├── syncWorker.js       # Đồng bộ Google Sheets theo lô và theo lịch
├── index.html          # Trang quay thưởng và tra cứu
├── main.js             # Logic giao diện người tham gia, gọi API
├── style.css           # Giao diện người tham gia
├── admin/
│   ├── index.html      # Trang quản trị, mẫu Apps Script
│   ├── admin.js        # Đăng nhập, quản lý dữ liệu, cấu hình và đồng bộ
│   └── admin.css       # Giao diện quản trị
├── img/                # Logo, nền và ảnh tĩnh của chương trình
├── uploads/            # Ảnh quà tặng được upload, cần lưu bền vững
├── data.db             # Database SQLite, cần lưu bền vững
├── data.db-wal         # Nhật ký WAL, có thể chứa dữ liệu chưa nhập vào data.db
└── data.db-shm         # File hỗ trợ shared-memory của WAL
```

`.env` là file cấu hình tùy chọn do người triển khai tạo; `node_modules/` được tạo khi cài dependency. File WAL/SHM có thể xuất hiện hoặc biến mất theo vòng đời kết nối SQLite.

Database dùng `agencies`, `prizes`, `lucky_codes`, `spin_logs`, `settings`, `phone_participants` và `schema_migrations`. Không có bảng kỳ. Phiên bản luật chỉ dùng đối soát, không chia bộ đếm. Lượt hủy giữ trong `spin_logs` với `status = void`, thời điểm/người hủy và phiên bản; không xóa vật lý.

## 4. Chạy local

### Yêu cầu

- Node.js phiên bản **22 trở lên** và npm tương ứng. Kiểm tra bằng `node --version` và `npm --version`.
- Quyền ghi tại thư mục ứng dụng để SQLite tạo/cập nhật file và server lưu ảnh trong `uploads/`.
- Kết nối mạng khi cài dependencies; mạng tới CDN cho các tài nguyên frontend và tới Google nếu bật đồng bộ.

### Cài đặt và khởi động

Mở terminal tại thư mục dự án:

```sh
npm ci
# Database cũ: dừng mọi server/worker trước khi migration
npm run db:migrate
npm start
```

`npm start` chạy `node server.js`. Không cần `npm run build`, không có dev server riêng và không cần cài một dịch vụ database bên ngoài. Dù trường `main` trong `package.json` là `main.js`, entry point chạy ứng dụng là **`server.js`**, không phải JavaScript frontend.

- Trang người tham gia: `http://localhost:3000/`
- Trang quản trị: `http://localhost:3000/admin/`
- Dừng server chạy trong terminal bằng `Ctrl+C`.

Không mở trực tiếp `index.html` bằng `file://`: giao diện cần API do Express cung cấp. Sau khi sửa backend, khởi động lại tiến trình; dự án chưa có script tự reload.

> Repo hiện theo dõi cả `data.db`, `data.db-wal`, `data.db-shm` và một số ảnh upload bằng Git. Một bản clone không đồng nghĩa với database trống. Database cũ chưa chuyển đổi bị chặn khởi động với `DATABASE_MIGRATION_REQUIRED`; server không tự migration dữ liệu cũ. Database mới hoàn toàn được khởi tạo tự động. Sau khi khởi động, worker có thể gửi dữ liệu tới webhook đã lưu trong database. Chỉ dùng bản dữ liệu thử đã được kiểm tra; không thử nghiệm trực tiếp trên dữ liệu vận hành.

### Biến môi trường

Nếu cần, tạo `.env` trong thư mục gốc **trước khi khởi động**:

```dotenv
PORT=3000
GOOGLE_SHEET_WEBHOOK_URL=
```

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `3000` | Cổng Express lắng nghe |
| `HOST` | `127.0.0.1` | Địa chỉ bind của Express |
| `DATABASE_PATH` | `data.db` trong thư mục ứng dụng | File SQLite; nên dùng đường dẫn tuyệt đối, dùng chung cho server và lệnh kích hoạt |
| `GOOGLE_SHEET_WEBHOOK_URL` | Không có giá trị môi trường | URL webhook; khi có giá trị không rỗng sẽ được ưu tiên hơn cấu hình trong Admin |

Để webhook môi trường trống **không tắt đồng bộ** nếu database đã có URL. Muốn không đồng bộ trên môi trường thử, cần bảo đảm cả biến môi trường và giá trị webhook trong `settings` đều trống trước khi khởi động. Không dùng bản database production để thử lần đầu.

Luôn đặt working directory của tiến trình là thư mục gốc dự án để `.env` được nạp đúng. Thay đổi biến môi trường cần restart server. Không commit `.env`, URL webhook thật hoặc thông tin vận hành nhạy cảm.

Code hiện **không hỗ trợ** biến môi trường cấu hình mật khẩu admin, đường dẫn database hoặc thư mục upload. Database nằm cố định cạnh `database.js`; upload nằm trong `uploads/` cạnh `server.js`.

## 5. Khởi tạo và sử dụng Admin

Database cũ cần chạy riêng `npm run db:migrate` khi server/worker đã dừng. Server không tự chuyển đổi lịch sử, không seed lại database đã có schema sẵn sàng. Chỉ database mới hoàn toàn mới được khởi tạo tự động.

Khi khởi tạo database mới, các bảng danh mục được seed: 7 đại lý, 6 mã quà và 30 mã `BIO001`–`BIO030` với serial `SR-2026-001`–`SR-2026-030`. Dữ liệu mẫu không phải cấu hình chương trình chính thức. Database đã migration giữ nguyên danh mục/kho/mã, không tự bổ sung mẫu khi restart.

1. Mở `/admin/` và đăng nhập bằng mật khẩu admin hiện tại. Khi setting chưa tồn tại, code khởi tạo mật khẩu mặc định **`bioamicus2026`**; database có sẵn có thể đã đổi mật khẩu.
2. Vào **Cài đặt**, đổi mật khẩu ngay. Không xóa database để khôi phục mật khẩu vì sẽ làm mất dữ liệu nghiệp vụ.
3. Kiểm tra hoặc nhập danh sách đại lý và thông tin tỉnh/thành, địa chỉ.
4. Cấu hình các giải, ảnh và số lượng thực tế; bảo đảm còn tồn kho trước khi quay thử.
5. Thêm hoặc import mã dự thưởng. Chỉ dùng mã mẫu khi xác nhận chúng còn tồn tại và chưa sử dụng.
6. Thử quay bằng thông tin giả trên môi trường thử, kiểm tra lịch sử và thống kê trong Admin.

### Nhập/xuất Excel

Dùng chức năng tải file mẫu trong Admin để giữ đúng định dạng. Backend đọc **sheet đầu tiên** của file import.

| Dữ liệu import | Các cột mẫu |
| --- | --- |
| Đại lý | `Mã đại lý`, `Tên đại lý`, `Tỉnh/thành`, `Địa chỉ` |
| Mã dự thưởng | `Mã dự thưởng`, `Serial` |

Import đại lý cập nhật thông tin khi trùng mã đại lý; import mã dự thưởng bỏ qua mã đã tồn tại. Mã dự thưởng được trim và chuyển thành chữ hoa. Định dạng các cột mã/serial là text trong Excel để giữ số 0 ở đầu. Sau import, kiểm tra kết quả trong Admin; lịch sử quay có chức năng xuất `.xlsx` riêng.

### 5.1. Các script quản trị & import dữ liệu qua CLI

Dự án cung cấp sẵn các công cụ tự động hóa dạng script Node.js và câu lệnh SQL phục vụ nạp dữ liệu hàng loạt và chuẩn bị môi trường quay thưởng:

#### 1. Import Danh Sách Đại Lý (`npm run db:import-agencies`)
- **Dữ liệu nguồn**: `docs/import_daily.csv` (gồm 7.235 đại lý với 4 cột: `Mã khách hàng`, `Tên khách hàng`, `Tỉnh/TP`, `Địa chỉ`).
- **Cơ chế**:
  - Tự động sao lưu an toàn CSDL hiện tại vào thư mục `~/.quaythuongdha-backups/` trước khi thao tác.
  - Xóa toàn bộ dữ liệu bảng `agencies` và reset ID tự tăng `sqlite_sequence` về 1.
  - Tự động sinh file SQL hoàn chỉnh: `scripts/import_agencies.sql` (nhóm 200 dòng/lệnh INSERT, escape chuỗi an toàn).
  - Nạp trực tiếp 7.235 đại lý vào SQLite `data.db`.
- **Lệnh thực thi**:
  ```sh
  npm run db:import-agencies
  ```
- Hoặc nạp bằng client SQLite bên ngoài:
  ```sh
  sqlite3 data.db < scripts/import_agencies.sql
  ```

#### 2. Quản Lý Mã Dự Thưởng & Reset Lượt Quay (`npm run db:import-lucky-codes`)
- **Dữ liệu nguồn**: `docs/import_lucky_codes.csv` (gồm 2.500 mã dự thưởng & serial mẫu chuẩn).
- **Cơ chế**:
  - Tự động tạo bản sao lưu an toàn CSDL `data.db`.
  - Tạm thời gỡ bỏ các trigger khóa xóa (`protect_spin_delete`, `protect_used_lucky_code`).
  - **Xóa sạch toàn bộ lượt quay** (`spin_logs`) và reset AUTOINCREMENT.
  - **Xóa sạch người tham gia** (`phone_participants`) để các số điện thoại/đại lý có thể tham gia quay lại từ đầu.
  - **Hoàn trả kho giải thưởng**: Đặt `used_quantity = 0`, `remaining_quantity = total_quantity` cho tất cả các giải trong `prizes`.
  - **Xóa và nạp lại toàn bộ mã dự thưởng**: Nạp danh sách mã và serial mới từ CSV với trạng thái `unused`.
  - Tái thiết lập các trigger bảo vệ tính toàn vẹn hệ thống.
  - Tự động sinh file SQL hoàn chỉnh: `scripts/reset_and_import_lucky_codes.sql`.
- **Lệnh thực thi**:
  ```sh
  # Reset lượt quay và nạp lại mã từ docs/import_lucky_codes.csv
  npm run db:import-lucky-codes

  # Hoặc nếu chỉ muốn xuất mã hiện có trong database ra file CSV:
  node scripts/reset-and-import-lucky-codes.js --export-only
  ```
- Hoặc chạy trực tiếp file SQL:
  ```sh
  sqlite3 data.db < scripts/reset_and_import_lucky_codes.sql
  ```

## 6. Đồng bộ Google Sheets (tùy chọn)

Ứng dụng vẫn phục vụ quay thưởng khi chưa cấu hình webhook. Worker sẽ không gửi dữ liệu nếu không tìm thấy URL ở cả môi trường và database.

### Cấu trúc cột dữ liệu đồng bộ (11 cột)

Google Sheets được đồng bộ tự động theo thứ tự các cột sau (bổ sung 3 trường ngân hàng từ cột 4):

| Cột | Tên Tiêu Đề | Định Dạng | Mô Tả |
| :---: | :--- | :---: | :--- |
| **1** | `ID` | Số | ID bản ghi lượt quay |
| **2** | `Thời Gian` | Ngày/giờ | Thời điểm quay thưởng |
| **3** | `Mã Đại Lý` | Text | Mã đại lý người chơi chọn |
| **4** | `Tên Ngân Hàng` | Text | Ngân hàng người chơi chọn lúc quay |
| **5** | `Số Tài Khoản Ngân Hàng` | Text (`@`) | Số tài khoản nhận thưởng (giữ số 0 ở đầu) |
| **6** | `Tên Chủ Tài Khoản Ngân Hàng` | Text | Tên hiển thị chủ tài khoản ngân hàng |
| **7** | `Số Điện Thoại` | Text (`@`) | Số điện thoại người chơi (giữ số 0 ở đầu) |
| **8** | `Địa Chỉ` | Text | Địa chỉ người chơi nhập |
| **9** | `Mã Dự Thưởng` | Text (`@`) | Mã thẻ cào/dự thưởng đã dùng |
| **10** | `Mã Quà Trúng` | Text | Mã quà nhận được (nếu hủy: `[ĐÃ HỦY] ...`) |
| **11** | `Vị Trí Trong Vòng` | Số | Vị trí lượt trong vòng 30 lượt |

### Thiết lập theo mẫu có sẵn

1. Chuẩn bị một Google Sheet dành riêng cho môi trường đang chạy; không dùng chung sheet thử nghiệm và production.
2. Trong Admin → **Cài đặt**, sao chép mã tại phần hướng dẫn Google Sheets. Mã nguồn mẫu nằm trong `admin/index.html`, không cần tạo file Apps Script trong repo.
3. Mở phần **Extensions → Apps Script** của Google Sheet và đặt mã mẫu vào script gắn với sheet đó.
4. Triển khai script dạng **Web app** và cấp quyền cần thiết. Mẫu hướng dẫn trong Admin dùng quyền truy cập **Anyone**, vì worker không gửi thông tin đăng nhập Google. Chỉ dùng mẫu này cho thử nghiệm có kiểm soát; xem cảnh báo webhook bên dưới.
5. Lấy URL web app dạng `/exec`, lưu trong Admin hoặc đặt `GOOGLE_SHEET_WEBHOOK_URL`. URL trong môi trường được ưu tiên, dù Admin đang hiển thị giá trị khác từ database.
6. Tạo lượt quay thử, chạy chức năng đồng bộ thủ công trong Admin, rồi kiểm tra trực tiếp hàng dữ liệu trong Google Sheet thay vì chỉ dựa vào thông báo thành công.

### Cơ chế đang được triển khai

- Worker chạy trong tiến trình Express, lần đầu sau **15 giây**, sau đó theo timer **2 phút/lần**. Không có dịch vụ worker riêng cần khởi động.
- Mỗi lần lấy tối đa **100** lượt chưa đồng bộ, theo ID tăng dần; phần còn lại chờ lần đồng bộ tiếp theo.
- Gửi POST JSON `{ "action": "sync_spins", "protocol": "spin-record-v3", "data": [...] }`, gồm trạng thái, `record_version` và thông tin ngân hàng.
- Worker chỉ cập nhật `is_synced`/`synced_at` khi HTTP/JSON thành công và nhận đủ xác nhận đúng ID/phiên bản; cập nhật có điều kiện trên phiên bản hiện tại để tránh phản hồi cũ đánh dấu lượt vừa hủy.
- [Mẫu Apps Script](docs/google-sheets-sync.gs) cập nhật theo ID, bỏ qua phiên bản cũ, chống trùng và khóa cập nhật. Lượt hủy cập nhật dòng cũ, lượt quay lại tạo dòng ID mới.

**Cần cập nhật Apps Script trước khi chạy v2.** Script cũ chỉ append không đáp ứng giao thức và sẽ không được đánh dấu đồng bộ. Sao lưu Sheet, xử lý ID trùng/bố cục tùy chỉnh trước khi triển khai mẫu mới. Không dùng chung Sheet cho các database độc lập có ID trùng. Worker gộp các lời gọi đồng thời trong một tiến trình; bản ghi lỗi vẫn chờ retry. Xem chi tiết [đồng bộ và hủy lượt](docs/luat-quay-thuong.md).

## 7. Deployment tổng quát

### Điều kiện trước khi triển khai

Đây là ứng dụng **Node.js chạy lâu dài có dữ liệu trên ổ đĩa**, không phải website static. Chọn môi trường có Node.js ≥22, filesystem ghi được và lưu bền vững. Không triển khai nguyên trạng trên static hosting hoặc môi trường serverless có filesystem tạm.

Chỉ chạy **một instance** theo hướng dẫn này: mỗi instance tự mở database và khởi động timer đồng bộ. Chưa có điều phối worker hay thiết kế dữ liệu để hướng dẫn chạy cluster/nhiều replica an toàn.

Repo chưa có Dockerfile, Compose, cấu hình process manager, reverse proxy hoặc pipeline CI/CD. Các bước dưới đây là yêu cầu vận hành, không phải các cấu hình đã được tích hợp sẵn.

### Quy trình

1. Xử lý các điểm chặn bảo mật ở mục 8 trước khi cho phép truy cập công khai. Chọn tài khoản hệ điều hành riêng, không chạy ứng dụng bằng quyền root.
2. Đưa source và lockfile lên máy chủ, bảo toàn dữ liệu vận hành. Không dùng database/ảnh mẫu từ checkout để ghi đè dữ liệu đang chạy.
3. Tại thư mục gốc ứng dụng, cài dependency trên chính môi trường đích:

   ```sh
   npm ci --omit=dev
   ```

4. Thiết lập `.env` hoặc biến môi trường của dịch vụ, quyền ghi cho thư mục ứng dụng và `uploads/`. Nếu dùng thư mục release mới, phải có phương án đưa database và upload bền vững vào đúng các đường dẫn cố định của code.
5. Cấu hình công cụ quản lý tiến trình của nền tảng chạy `npm start` hoặc `node server.js`, working directory là thư mục ứng dụng, một instance, tự restart khi lỗi/khởi động máy và thu thập stdout/stderr.
6. Đặt reverse proxy có HTTPS phía trước, chuyển tiếp các đường dẫn giao diện và `/api/` tới cổng Node.js. Bảo vệ cổng Node.js bằng firewall/mạng nội bộ; mặc định bind `127.0.0.1`, có thể cấu hình `HOST`. Không cấu hình proxy phục vụ toàn bộ thư mục dự án làm static.
7. Đổi mật khẩu admin, kiểm tra dữ liệu chương trình và webhook đúng môi trường; thực hiện checklist kiểm tra trước khi mở truy cập.

### Dữ liệu bền vững, backup và cập nhật

- Bảo toàn `data.db`, các file WAL/SHM liên quan và `uploads/`. SQLite cần quyền ghi cả thư mục chứa database, không chỉ riêng file `data.db`.
- **Backup đơn giản khi dừng ứng dụng:** dừng tiến trình bằng công cụ quản lý dịch vụ, xác nhận không còn tiến trình dùng database, rồi sao lưu `data.db` cùng `data.db-wal`/`data.db-shm` nếu còn tồn tại và toàn bộ `uploads/` vào nơi riêng tư ngoài thư mục được phục vụ web. Lưu cấu hình môi trường an toàn riêng biệt.
- Không sao chép riêng `data.db` khi server đang ghi và không xóa WAL để “dọn rác”; WAL có thể chứa transaction đã commit chưa được checkpoint vào file chính.
- Khi restore, giữ server dừng; dùng một bộ backup nhất quán, không ghép database với WAL/SHM từ lần khác. Khôi phục cả ảnh upload, cấu hình và quyền sở hữu trước khi khởi động. Cô lập bộ dữ liệu cũ thay vì ghi đè chồng các file phụ.
- Trước mỗi lần cập nhật source, backup dữ liệu và ghi nhận phiên bản đang chạy. Không checkout/đồng bộ đè các file dữ liệu mà Git đang theo dõi. Cài dependencies từ lockfile, khởi động lại và kiểm tra lịch sử, kho quà, ảnh upload.
- Migration chạy ngay khi khởi động; rollback source không tự rollback schema/dữ liệu. Nếu cần phục hồi từ backup, phải đánh giá các lượt quay phát sinh sau thời điểm backup để tránh mất dữ liệu hoặc cho phép dùng lại mã.

## 8. Lưu ý bảo mật và giới hạn hiện tại

Các phát hiện dưới đây dựa trên review source; README này **không sửa code** và không phải xác nhận ứng dụng đã sẵn sàng cho production.

| Phát hiện | Ảnh hưởng và việc cần làm trước production |
| --- | --- |
| Tài nguyên static được giới hạn | Chỉ phục vụ trang chủ, JS/CSS giao diện và thư mục `img`, `uploads`, `admin`. Không đặt database/source backend/backup trong các thư mục công khai hoặc mở lại static thư mục gốc ở reverse proxy |
| Mật khẩu admin mặc định được hardcode; lưu dạng rõ trong SQLite | Đổi mật khẩu là bước tối thiểu, chưa đủ. Cần thiết kế lưu mật khẩu dạng hash và xác thực phù hợp |
| Token admin chính là mật khẩu và được frontend lưu trong `localStorage` | Không có session/token độc lập có hạn dùng; lộ token cũng là lộ mật khẩu. Cần rà soát cơ chế phiên và bảo vệ giao diện admin |
| Database và WAL/SHM đang được Git theo dõi | Không coi clone là dữ liệu sạch; cần tách dữ liệu runtime khỏi source, đánh giá dữ liệu đã nằm trong lịch sử Git và không đưa dữ liệu thật vào repo |
| Webhook mẫu dùng truy cập Anyone, chưa có xác thực người gửi | Đã chống trùng theo ID/phiên bản nhưng người có URL vẫn có thể gửi dữ liệu; cần bổ sung kiểm soát truy cập trước khi dùng dữ liệu thật |
| Hủy lượt hoàn kho trên phần mềm | Admin phải thu hồi/đối soát quà thực tế trước khi xác nhận. Tài khoản admin dùng chung chỉ được ghi nhận là `admin`, không phân biệt nhân viên |

Trước production cũng cần rà soát quyền truy cập lịch sử theo số điện thoại, giới hạn đăng nhập/request, kiểm tra file upload và bảo vệ thông tin người tham gia. Không coi thay đổi cấu hình HTTPS hoặc mật khẩu là đã giải quyết toàn bộ các vấn đề này.

## 9. Kiểm tra sau cài đặt

Chạy `npm run verify:lottery` để kiểm chứng luật quay, rollback, migration/backup, nhiều kết nối SQLite đồng thời, middleware API, Excel và payload webhook. Kịch bản tự tạo/xóa database tạm, không truy cập database vận hành, không mở cổng mạng và không gọi webhook thật. `npm test` vẫn là placeholder; chưa có endpoint health check riêng.

Trước khi nhận quay trên dữ liệu vận hành, dừng mọi server/worker và chạy `npm run db:migrate` với cùng `DATABASE_PATH`: backup nhất quán ngoài dự án rồi chuyển đổi lịch sử theo SĐT. Giữ quà/kho/mã, cộng lượt cũ; chạy lại không reset. Có dữ liệu kỳ/nhóm hoặc vàng giữ chỗ thì dừng để đối soát. Cập nhật Apps Script trước khi bật worker. Xem [hướng dẫn migration và luật đầy đủ](docs/luat-quay-thuong.md).

Chỉ thực hiện checklist sau trên **dữ liệu thử**, với webhook thử hoặc không có webhook; một lần quay thành công sẽ thay đổi kho quà, mã và lịch sử:

- [ ] Mở `/` và `/admin/`; kiểm tra ảnh, CSS/JavaScript và lỗi trong console trình duyệt.
- [ ] Đăng nhập Admin, đổi mật khẩu thử; đăng xuất và đăng nhập lại bằng mật khẩu mới.
- [ ] Thêm/import đại lý, mã và giải thử; kiểm tra số lượng và ảnh upload.
- [ ] Quay bằng mã hợp lệ chưa dùng; xác nhận đúng một lịch sử, tồn kho giảm một và mã chuyển sang đã dùng.
- [ ] Quay lại cùng mã và thử mã không tồn tại; xác nhận bị từ chối, không tạo thêm lịch sử hay trừ kho.
- [ ] Tra cứu bằng số điện thoại thử; đối chiếu với lịch sử và file Excel xuất từ Admin.
- [ ] Nếu có webhook thử, đồng bộ thủ công và đối chiếu trực tiếp Google Sheet; kiểm tra timer mà không bấm đồng bộ chồng lên lượt đang chạy.
- [ ] Restart server; xác nhận lịch sử, mã đã dùng, tồn kho, mật khẩu và ảnh upload còn nguyên.
- [ ] Trước khi public, xác nhận không tải được database, WAL/SHM, source backend hoặc backup qua HTTP. Nếu tải được thì chưa đạt điều kiện triển khai công khai.

## 10. Xử lý lỗi thường gặp

| Hiện tượng | Kiểm tra / hướng xử lý |
| --- | --- |
| `npm ci` lỗi ở `better-sqlite3` hoặc báo engine không phù hợp | Kiểm tra Node.js ≥22, nền tảng/kiến trúc được dependency hỗ trợ và mạng tải package. Cài trên máy đích, không chép `node_modules` từ hệ điều hành khác; nếu phải biên dịch native module, cần bộ công cụ build tương ứng |
| `npm ci` báo package và lockfile không khớp | Dùng source và lockfile cùng phiên bản; sửa lệch dependency ở môi trường phát triển, không bỏ lockfile để chữa cháy trên server |
| `EADDRINUSE` | Kiểm tra tiến trình đang dùng cổng; dừng đúng dịch vụ cũ hoặc đổi `PORT` rồi restart |
| SQLite readonly, không mở được database hoặc upload lỗi quyền | Kiểm tra user chạy dịch vụ, quyền ghi thư mục chứa database và `uploads/`; không chạy root để né lỗi |
| Database bị khóa | Kiểm tra có instance thứ hai hoặc công cụ khác đang ghi database; không xóa WAL/SHM để xử lý |
| Sửa `.env` không có tác dụng | Kiểm tra working directory, biến môi trường do nền tảng cấp và việc restart tiến trình |
| Không đăng nhập được bằng mật khẩu mặc định | Database có sẵn có thể đã đổi mật khẩu; liên hệ người quản trị dữ liệu, không xóa database |
| Không đồng bộ Google Sheets | Kiểm tra URL môi trường có ghi đè URL trong Admin, quyền web app, kết nối mạng, log `[GoogleSheetSync]` và số lượt chưa đồng bộ |
| Báo đồng bộ thành công nhưng thiếu dữ liệu hoặc trùng dòng | Đối chiếu sheet và log Apps Script; xem giới hạn kiểm tra JSON/chống trùng ở mục 6, không tự đánh dấu lại toàn bộ lịch sử để gửi lại |
| Mất font, hiệu ứng hoặc không tải mẫu Excel | Kiểm tra request tới Google Fonts/jsDelivr và console trình duyệt |
| Không quay được | Kiểm tra thông tin bắt buộc, mã tồn tại/chưa dùng và số lượng quà còn lại; các mã seed có thể đã được dùng trong database đi kèm |
