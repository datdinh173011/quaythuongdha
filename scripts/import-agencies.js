// scripts/import-agencies.js
// Giữ tương thích ngược với lệnh `npm run db:import-agencies`, chuyển hướng sang bộ nạp Upsert an toàn `import-daily.js`.
require('./import-daily.js');
