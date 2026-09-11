# Quay thưởng DHA — BioAmicus

Ứng dụng quay thưởng bằng mã dự thưởng, gồm giao diện người tham gia và trang quản trị. Một tiến trình Node.js phục vụ cả giao diện, API và tác vụ đồng bộ Google Sheets; dữ liệu được lưu trong SQLite trên máy chạy ứng dụng.

> **Chưa nên public nguyên trạng.** Server hiện phục vụ toàn bộ thư mục gốc qua static, có nguy cơ lộ database và mã nguồn. Cơ chế xác thực admin cũng chưa phù hợp cho production. Đọc mục **Lưu ý bảo mật và giới hạn hiện tại** trước khi triển khai ra Internet.

## 1. Chức năng

- Chọn tỉnh/thành, đại lý, nhập thông tin người tham gia và mã dự thưởng để quay.
- Kiểm tra mã tồn tại, chưa sử dụng và kho quà còn hàng. Kết quả được chọn ở backend theo tỷ lệ số lượng quà còn lại.
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
├── database.js         # Mở SQLite, tạo bảng, migration và seed dữ liệu mẫu
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

Database gồm các bảng `agencies`, `prizes`, `lucky_codes`, `spin_logs` và `settings`. Mật khẩu admin và webhook cấu hình qua giao diện được lưu trong `settings`.

## 4. Chạy local

### Yêu cầu

- Node.js phiên bản **22 trở lên** và npm tương ứng. Kiểm tra bằng `node --version` và `npm --version`.
- Quyền ghi tại thư mục ứng dụng để SQLite tạo/cập nhật file và server lưu ảnh trong `uploads/`.
- Kết nối mạng khi cài dependencies; mạng tới CDN cho các tài nguyên frontend và tới Google nếu bật đồng bộ.

### Cài đặt và khởi động

Mở terminal tại thư mục dự án:

```sh
npm ci
npm start
```

`npm start` chạy `node server.js`. Không cần `npm run build`, không có dev server riêng và không cần cài một dịch vụ database bên ngoài. Dù trường `main` trong `package.json` là `main.js`, entry point chạy ứng dụng là **`server.js`**, không phải JavaScript frontend.

- Trang người tham gia: `http://localhost:3000/`
- Trang quản trị: `http://localhost:3000/admin/`
- Dừng server chạy trong terminal bằng `Ctrl+C`.

Không mở trực tiếp `index.html` bằng `file://`: giao diện cần API do Express cung cấp. Sau khi sửa backend, khởi động lại tiến trình; dự án chưa có script tự reload.

> Repo hiện theo dõi cả `data.db`, `data.db-wal`, `data.db-shm` và một số ảnh upload bằng Git. Một bản clone không đồng nghĩa với database trống. Khởi động sẽ chạy logic khởi tạo/migration và có thể tự gửi dữ liệu tới webhook đã lưu trong database. Chỉ dùng bản dữ liệu thử đã được kiểm tra; không thử nghiệm trực tiếp trên dữ liệu vận hành.

### Biến môi trường

Nếu cần, tạo `.env` trong thư mục gốc **trước khi khởi động**:

```dotenv
PORT=3000
GOOGLE_SHEET_WEBHOOK_URL=
```

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` | `3000` | Cổng Express lắng nghe |
| `GOOGLE_SHEET_WEBHOOK_URL` | Không có giá trị môi trường | URL webhook; khi có giá trị không rỗng sẽ được ưu tiên hơn cấu hình trong Admin |

Để webhook môi trường trống **không tắt đồng bộ** nếu database đã có URL. Muốn không đồng bộ trên môi trường thử, cần bảo đảm cả biến môi trường và giá trị webhook trong `settings` đều trống trước khi khởi động. Không dùng bản database production để thử lần đầu.

Luôn đặt working directory của tiến trình là thư mục gốc dự án để `.env` được nạp đúng. Thay đổi biến môi trường cần restart server. Không commit `.env`, URL webhook thật hoặc thông tin vận hành nhạy cảm.

Code hiện **không hỗ trợ** biến môi trường cấu hình mật khẩu admin, đường dẫn database hoặc thư mục upload. Database nằm cố định cạnh `database.js`; upload nằm trong `uploads/` cạnh `server.js`.

## 5. Khởi tạo và sử dụng Admin

Khi server khởi động, `database.js` tự tạo các bảng còn thiếu, bổ sung cột `prize_tier` cho database cũ và cập nhật một số dữ liệu giải mẫu. Không có lệnh migration riêng.

Các bảng đại lý, giải thưởng và mã dự thưởng được seed độc lập khi bảng tương ứng rỗng: 7 đại lý, 4 loại giải và 30 mã `BIO001`–`BIO030` với serial `SR-2026-001`–`SR-2026-030`. Điều kiện này được kiểm tra mỗi lần khởi động, không chỉ lần cài đầu tiên. Dữ liệu mẫu không phải cấu hình chương trình chính thức.

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

## 6. Đồng bộ Google Sheets (tùy chọn)

Ứng dụng vẫn phục vụ quay thưởng khi chưa cấu hình webhook. Worker sẽ không gửi dữ liệu nếu không tìm thấy URL ở cả môi trường và database.

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
- Gửi POST JSON có dạng `{ "action": "sync_spins", "data": [...] }`, với `data` là các bản ghi `spin_logs` chưa đồng bộ.
- Khi request được coi là thành công, worker cập nhật `is_synced` và `synced_at` trong SQLite. Lỗi mạng hoặc HTTP không thành công sẽ giữ bản ghi để thử lại lần sau.
- Mẫu Apps Script ghi dữ liệu vào sheet đang active và tạo tiêu đề nếu sheet trống.

**Giới hạn quan trọng:** worker chỉ kiểm tra HTTP status, không kiểm tra trường `status` trong JSON trả về; phản hồi HTTP thành công nhưng JSON báo lỗi, hoặc không phải JSON, vẫn có thể khiến dữ liệu bị đánh dấu đã đồng bộ. Worker chưa có khóa chống chạy chồng; mẫu Apps Script chỉ append, chưa chống trùng theo ID. Retry sau lỗi hoặc bấm đồng bộ khi timer đang chạy có thể tạo dòng trùng. Đây chưa phải cơ chế đồng bộ bảo đảm mỗi bản ghi chỉ được ghi đúng một lần.

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
6. Đặt reverse proxy có HTTPS phía trước, chuyển tiếp các đường dẫn giao diện và `/api/` tới cổng Node.js. Bảo vệ cổng Node.js bằng firewall/mạng nội bộ; code hiện không giới hạn bind chỉ ở localhost. Có reverse proxy **không tự khắc phục** lỗi static phục vụ thư mục gốc.
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
| `express.static(__dirname)` phục vụ thư mục gốc | Các file như `/data.db`, `/data.db-wal`, `/server.js` có thể tải trực tiếp. Cần chỉ cho phép phục vụ tài nguyên công khai; không đặt database, source backend hay backup trong vùng static |
| Mật khẩu admin mặc định được hardcode; lưu dạng rõ trong SQLite | Đổi mật khẩu là bước tối thiểu, chưa đủ. Cần thiết kế lưu mật khẩu dạng hash và xác thực phù hợp |
| Token admin chính là mật khẩu và được frontend lưu trong `localStorage` | Không có session/token độc lập có hạn dùng; lộ token cũng là lộ mật khẩu. Cần rà soát cơ chế phiên và bảo vệ giao diện admin |
| Database và WAL/SHM đang được Git theo dõi | Không coi clone là dữ liệu sạch; cần tách dữ liệu runtime khỏi source, đánh giá dữ liệu đã nằm trong lịch sử Git và không đưa dữ liệu thật vào repo |
| Webhook mẫu dùng truy cập Anyone, không có xác thực hay chống trùng | Người có URL có thể gửi dữ liệu; cần bổ sung kiểm soát truy cập và chống trùng trước khi dùng dữ liệu thật |
| Worker bỏ qua trạng thái lỗi trong JSON phản hồi | Có thể đánh dấu đã đồng bộ dù sheet chưa được cập nhật; cần kiểm tra kết quả nghiệp vụ trước khi cập nhật trạng thái |

Trước production cũng cần rà soát quyền truy cập lịch sử theo số điện thoại, giới hạn đăng nhập/request, kiểm tra file upload và bảo vệ thông tin người tham gia. Không coi thay đổi cấu hình HTTPS hoặc mật khẩu là đã giải quyết toàn bộ các vấn đề này.

## 9. Kiểm tra sau cài đặt

Hiện **chưa có bộ kiểm thử tự động**. `npm test` chỉ in `Error: no test specified` và thoát với mã lỗi 1; đây không phải lệnh kiểm tra sức khỏe ứng dụng. Chưa có endpoint health check riêng.

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
