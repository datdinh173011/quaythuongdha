const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { migrateLottery } = require('../lotterySchema');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const dbPath = process.env.DATABASE_PATH || path.join(
    process.env.NODE_ENV === 'production' ? '/var/lib/quaythuongdha' : path.join(__dirname, '..', '.runtime'),
    'data.db'
  );
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const backupDir = path.join(os.homedir(), '.quaythuongdha-backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `before-phone-v3-${Date.now()}-${randomUUID()}.db`);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`Đã sao lưu: ${backupPath}`);
    db.pragma('foreign_keys = ON');
    migrateLottery(db);
    console.log('Schema phone-v3 đã sẵn sàng. Bộ đếm theo SĐT bao gồm lịch sử cũ; không reset dữ liệu.');
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(`Không chuyển đổi database: ${error.message}`);
  process.exitCode = 1;
});
