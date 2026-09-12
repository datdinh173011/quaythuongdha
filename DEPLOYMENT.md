# Deployment Quay thưởng DHA

Tài liệu này hướng dẫn chạy ứng dụng trên Ubuntu/Debian bằng Node.js, `systemd` và Nginx.

## 1. Mô hình triển khai

```text
Internet
   │ HTTPS :443
   ▼
Nginx (daily.bioamicus.vn)
   ├── /quaythuongdha/       ─┐
   └── /quaythuongdha-admin/ ├── proxy tới 127.0.0.1:3000
                             │
                         Node.js / Express
                             ├── data.db + data.db-wal + data.db-shm
                             └── uploads/
```

Ứng dụng cần filesystem persistent để ghi SQLite và ảnh. Chỉ chạy một Node.js instance: `database.js` mở SQLite local và `syncWorker.js` chạy timer đồng bộ Google Sheets trong cùng process. Service mẫu bind Node.js vào `127.0.0.1:3000` qua biến `HOST`.

Các URL sau được hỗ trợ khi đi qua Nginx:

- Trang quay thưởng: `https://daily.bioamicus.vn/quaythuongdha/`
- Trang quản trị: `https://daily.bioamicus.vn/quaythuongdha-admin/`

Nginx loại bỏ prefix trước khi proxy, nên upstream Node.js vẫn nhận các route hiện có như `/`, `/admin/`, `/api/...`, `/img/...` và `/uploads/...`. Frontend cũng tự thêm prefix theo URL hiện tại.

## 2. Yêu cầu server

- Ubuntu/Debian có quyền `sudo`.
- Node.js **22 trở lên** và npm tương ứng (`better-sqlite3` trong lockfile yêu cầu Node.js ≥22).
- Nginx, DNS trỏ `daily.bioamicus.vn` về IP server, và firewall mở TCP `80/443`.
- Thư mục chạy ứng dụng có quyền ghi cho user service; SQLite cần ghi được cả thư mục chứa database.
- Kết nối mạng để cài dependency, lấy tài nguyên CDN frontend và gọi Google Apps Script nếu bật đồng bộ.

Không triển khai như static site hoặc serverless filesystem tạm thời. Repo hiện chưa có Dockerfile, PM2 config hay pipeline CI/CD.

## 3. Cài source và dependency

Ví dụ dùng user `www-data` và thư mục `/var/www/quaythuongdha`; thay bằng đường dẫn thực tế của server:

```sh
sudo mkdir -p /var/www/quaythuongdha
sudo chown -R "$USER":"$USER" /var/www/quaythuongdha
cd /var/www/quaythuongdha

# Upload/clone source và package-lock.json vào thư mục này trước bước tiếp theo.
npm ci --omit=dev
```

Giữ `package.json` và `package-lock.json` cùng phiên bản. Không copy `node_modules` từ máy khác. Dependency `xlsx@0.18.5` hiện có cảnh báo high severity; deployment này giữ nguyên phiên bản theo yêu cầu và chấp nhận cảnh báo đó.

Tạo file `.env` với quyền hạn chế:

```dotenv
PORT=3000
GOOGLE_SHEET_WEBHOOK_URL=
```

Nếu database đã lưu webhook trong `settings`, giá trị `GOOGLE_SHEET_WEBHOOK_URL` không rỗng sẽ được ưu tiên. Không commit `.env` hoặc URL webhook thật.

Kiểm tra dữ liệu trước khi chạy service. Không ghi đè database production bằng file từ source checkout.

## 4. Tạo service systemd

Tạo `/etc/systemd/system/quaythuongdha.service`:

```ini
[Unit]
Description=Quay thuong DHA Node.js application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/quaythuongdha
EnvironmentFile=/var/www/quaythuongdha/.env
ExecStart=/usr/bin/node /var/www/quaythuongdha/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Nếu Node.js được cài qua `nvm`, `/usr/bin/node` có thể không tồn tại. Dùng đường dẫn tuyệt đối của `command -v node` trong môi trường server, hoặc tạo systemd-compatible installation; không dùng lệnh shell dạng `nvm` trực tiếp trong `ExecStart`.

Đảm bảo user service sở hữu dữ liệu runtime:

```sh
sudo chown -R www-data:www-data /var/www/quaythuongdha
sudo chmod 750 /var/www/quaythuongdha
sudo chmod 640 /var/www/quaythuongdha/.env
sudo systemctl daemon-reload
sudo systemctl enable --now quaythuongdha
sudo systemctl status quaythuongdha
sudo journalctl -u quaythuongdha -f
```

Không khởi động ứng dụng đồng thời bằng `npm start` và `systemd`; instance thứ hai có thể tranh chấp SQLite và chạy thêm worker đồng bộ.

## 5. Cấu hình DNS và Nginx

Tạo bản ghi DNS:

```text
Type: A
Name: daily
Value: <PUBLIC_IP_CUA_SERVER>
```

Nếu dùng IPv6, thêm bản ghi `AAAA` tương ứng. Xác nhận DNS đã trỏ đúng trước khi cấp chứng chỉ.

### HTTP server block ban đầu

Tạo `/etc/nginx/sites-available/daily.bioamicus.vn`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name daily.bioamicus.vn;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
```

Kích hoạt site:

```sh
sudo ln -s /etc/nginx/sites-available/daily.bioamicus.vn /etc/nginx/sites-enabled/daily.bioamicus.vn
sudo nginx -t
sudo systemctl reload nginx
```

### HTTPS server block

Sau khi có chứng chỉ, thay nội dung bằng cấu hình dưới đây. `proxy_pass` có dấu `/` cuối là bắt buộc: nó làm Nginx bỏ `/quaythuongdha` hoặc `/quaythuongdha-admin` trước khi gửi tới Node.js.

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name daily.bioamicus.vn;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name daily.bioamicus.vn;

    ssl_certificate /etc/letsencrypt/live/daily.bioamicus.vn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/daily.bioamicus.vn/privkey.pem;

    client_max_body_size 20m;
    proxy_connect_timeout 10s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location = /quaythuongdha {
        return 301 /quaythuongdha/;
    }

    location /quaythuongdha/ {
        proxy_pass http://127.0.0.1:3000/;
    }

    location = /quaythuongdha-admin {
        return 301 /quaythuongdha-admin/;
    }

    location = /quaythuongdha-admin/ {
        proxy_pass http://127.0.0.1:3000/admin/;
    }

    location = /quaythuongdha-admin/admin.css {
        proxy_pass http://127.0.0.1:3000/admin/admin.css;
    }

    location = /quaythuongdha-admin/admin.js {
        proxy_pass http://127.0.0.1:3000/admin/admin.js;
    }

    # API và tài nguyên Admin dùng các route chung của Node.js.
    location /quaythuongdha-admin/ {
        proxy_pass http://127.0.0.1:3000/;
    }

    # Các route khác của daily.bioamicus.vn được giữ cho website hiện hữu.
    location / {
        # Thay bằng upstream/root config của website hiện hữu.
        proxy_pass http://127.0.0.1:8080;
    }
}
```

Nếu domain này không có website khác, có thể thay `location /` cuối bằng `return 404;` để tránh proxy nhầm. Không thêm `location /api/` ở root: API của ứng dụng phải đi qua đúng prefix, ví dụ `/quaythuongdha/api/provinces` hoặc `/quaythuongdha-admin/api/admin/stats`.

Với cấu hình trên, các request mẫu được chuyển như sau:

| Public URL | Upstream Node.js |
| --- | --- |
| `/quaythuongdha/` | `/` |
| `/quaythuongdha/api/provinces` | `/api/provinces` |
| `/quaythuongdha/img/pc-logo.png` | `/img/pc-logo.png` |
| `/quaythuongdha-admin/` | `/admin/` |
| `/quaythuongdha-admin/admin.css` | `/admin/admin.css` |
| `/quaythuongdha-admin/admin.js` | `/admin/admin.js` |
| `/quaythuongdha-admin/api/admin/stats` | `/api/admin/stats` |
| `/quaythuongdha-admin/uploads/<file>` | `/uploads/<file>` |

Kiểm tra và reload:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

## 6. HTTPS bằng Certbot

Sau khi DNS và HTTP server block hoạt động:

```sh
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d daily.bioamicus.vn
sudo certbot renew --dry-run
```

Nếu Certbot tự sửa server block, rà soát lại hai `location` subpath và đặc biệt giữ `proxy_pass http://127.0.0.1:3000/;` có dấu `/` cuối.

## 7. Dữ liệu, backup và cập nhật

Các dữ liệu runtime cần giữ persistent:

- `data.db`
- `data.db-wal` và `data.db-shm` khi tồn tại
- Toàn bộ thư mục `uploads/`
- `.env` và cấu hình webhook ở nơi lưu trữ bí mật

Backup an toàn khi dừng service:

```sh
sudo systemctl stop quaythuongdha
sudo tar -czf /var/backups/quaythuongdha-$(date +%F-%H%M%S).tar.gz \
  -C /var/www/quaythuongdha data.db data.db-wal data.db-shm uploads
sudo systemctl start quaythuongdha
```

Nếu một file WAL/SHM không tồn tại, loại file đó khỏi lệnh `tar` hoặc dùng công cụ backup phù hợp. Không sao chép riêng `data.db` khi server đang ghi; WAL có thể chứa transaction đã commit chưa được checkpoint. Không xóa WAL/SHM để xử lý lỗi khóa database.

Khi restore, dừng service, khôi phục một bộ database nhất quán cùng ảnh upload, kiểm tra quyền `www-data`, rồi mới start lại. Khi cập nhật source, backup trước, không checkout đè database production, cài bằng `npm ci`, restart service và kiểm tra dữ liệu. Migration chạy khi process khởi động; rollback code không tự rollback dữ liệu/schema.

## 8. Bảo mật trước khi public

Nginx/HTTPS không tự khắc phục các vấn đề trong code hiện tại:

- `express.static(__dirname)` có thể làm lộ `data.db`, WAL/SHM và source backend nếu upstream bị truy cập ngoài ý muốn. Cần harden static serving trong code trước production.
- Mật khẩu Admin mặc định được hardcode, lưu dạng rõ trong SQLite và dùng trực tiếp làm bearer token. Đổi mật khẩu ngay nhưng vẫn cần thiết kế lại cơ chế xác thực/session.
- Không để backup, `.env`, database hoặc source trong vùng có thể tải qua web.
- Chỉ cho phép một process Node.js; giới hạn quyền user service và firewall chỉ mở Nginx ra Internet.
- `xlsx@0.18.5` có cảnh báo high severity; phiên bản được giữ nguyên theo yêu cầu triển khai này.
- Worker đồng bộ chưa kiểm tra trạng thái lỗi trong JSON và chưa chống ghi trùng; kiểm tra trực tiếp Google Sheet sau đồng bộ.

## 9. Checklist nghiệm thu

- [ ] DNS `daily.bioamicus.vn` trỏ đúng IP server.
- [ ] `systemctl status quaythuongdha` đang active và log không có lỗi.
- [ ] `https://daily.bioamicus.vn/quaythuongdha/` tải được CSS, ảnh, JavaScript và gọi được API.
- [ ] `https://daily.bioamicus.vn/quaythuongdha-admin/` đăng nhập được và liên kết quay thưởng mở đúng URL.
- [ ] Quay thử bằng mã hợp lệ; mã đã dùng bị từ chối; tồn kho/lịch sử cập nhật đúng.
- [ ] Upload ảnh, import Excel và export lịch sử hoạt động qua HTTPS.
- [ ] Nếu bật Google Sheets, đồng bộ thủ công và kiểm tra dữ liệu trực tiếp trên sheet.
- [ ] Restart service; database, ảnh và cấu hình vẫn còn.
- [ ] Kiểm tra không thể tải database, WAL/SHM, `.env`, source backend hoặc backup qua public URL.
- [ ] `sudo nginx -t` thành công và `certbot renew --dry-run` thành công.

## 10. Xử lý lỗi nhanh

| Lỗi | Kiểm tra |
| --- | --- |
| `502 Bad Gateway` | `systemctl status quaythuongdha`, `journalctl -u quaythuongdha`, Node.js có listen `127.0.0.1:3000` không |
| Trang trắng hoặc mất CSS/ảnh | Kiểm tra URL có dấu `/` cuối và `proxy_pass` có dấu `/` cuối; xem Network tab để tìm request sai prefix |
| `EADDRINUSE` | Có instance khác đang dùng port; dừng `npm start`/service trùng |
| SQLite readonly/locked | Kiểm tra quyền thư mục, user `www-data`, instance thứ hai và không xóa WAL/SHM |
| Import ảnh/Excel trả lỗi kích thước | Kiểm tra `client_max_body_size` và quyền ghi `uploads/` |
| Không đồng bộ Google Sheets | Kiểm tra `.env`, setting Admin, URL `/exec`, quyền Apps Script và log worker |
