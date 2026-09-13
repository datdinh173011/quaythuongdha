const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const databasePath = process.env.DATABASE_PATH || path.join(
    process.env.NODE_ENV === 'production' ? '/var/lib/quaythuongdha' : path.join(__dirname, '..', '.runtime'),
    'data.db'
  );
  const backupDir = process.env.BACKUP_DIR || path.join(os.homedir(), '.quaythuongdha-backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `quaythuongdha-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.db`);
  const db = new Database(databasePath, { fileMustExist: true, readonly: true });
  try {
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`Đã sao lưu nhất quán: ${backupPath}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`Không sao lưu database: ${error.message}`);
  process.exitCode = 1;
});
