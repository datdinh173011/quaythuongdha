const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { migrateCampaign } = require('../campaignSchema');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data.db');
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const backupDir = process.env.DATABASE_BACKUP_DIR || path.join(os.homedir(), '.quaythuongdha-backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `before-bank-details-v1-${Date.now()}-${randomUUID()}.db`);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`Đã sao lưu: ${backupPath}`);
    db.pragma('foreign_keys = ON');
    migrateCampaign(db);
    console.log('Schema bank-details-v1 đã sẵn sàng. Giữ lịch sử, số đã dùng và bộ đếm; bỏ cột chủ đại lý, thông tin ngân hàng cũ để trống.');
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(`Không chuyển đổi database: ${error.message}`);
  process.exitCode = 1;
});
