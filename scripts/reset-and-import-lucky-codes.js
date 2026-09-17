const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function parseCSV(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let currentField = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(currentField);
      currentField = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      row.push(currentField);
      lines.push(row);
      row = [];
      currentField = '';
    } else {
      currentField += char;
    }
  }
  if (currentField || row.length > 0) {
    row.push(currentField);
    lines.push(row);
  }
  return lines;
}

function escapeSqlString(str) {
  if (str === null || str === undefined) return "''";
  return "'" + String(str).replace(/'/g, "''") + "'";
}

async function main() {
  const csvPath = path.join(__dirname, '..', 'docs', 'import_lucky_codes.csv');
  const sqlOutputPath = path.join(__dirname, 'reset_and_import_lucky_codes.sql');
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data.db');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Không tìm thấy file database tại ${dbPath}`);
  }

  const db = new Database(dbPath, { fileMustExist: true });

  try {
    // 1. Nếu chưa có file CSV, tự động trích xuất danh sách mã hiện tại trong database ra docs/import_lucky_codes.csv
    if (!fs.existsSync(csvPath) || process.argv.includes('--export-only')) {
      console.log('Chưa có file CSV hoặc có tham số --export-only. Đang export từ bảng lucky_codes...');
      const currentCodes = db.prepare('SELECT serial_number, code FROM lucky_codes ORDER BY id ASC').all();
      const csvLines = ['Mã serial,Mã dự thưởng'];
      for (const item of currentCodes) {
        const serial = item.serial_number ? `"${item.serial_number.replace(/"/g, '""')}"` : '""';
        const code = item.code ? `"${item.code.replace(/"/g, '""')}"` : '""';
        csvLines.push(`${serial},${code}`);
      }
      fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
      console.log(`Đã export thành công ${currentCodes.length} mã vào file: ${csvPath}`);
      if (process.argv.includes('--export-only')) return;
    }

    // 2. Đọc file CSV
    console.log(`Đang đọc dữ liệu từ: ${csvPath}`);
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const rawRows = parseCSV(csvContent);

    if (rawRows.length <= 1) {
      throw new Error('File CSV không có dữ liệu hợp lệ!');
    }

    const header = rawRows[0];
    console.log('Tiêu đề CSV:', header);

    const dataRows = rawRows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
    console.log(`Số dòng dữ liệu mã dự thưởng: ${dataRows.length}`);

    const luckyCodes = [];
    const codeSet = new Set();

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      let serial = (r[0] || '').trim();
      let code = (r[1] || '').trim().toUpperCase();

      // Trường hợp đảo cột: nếu cột 1 dài và trông như mã code, cột 2 là serial số
      if (!code && serial) {
        code = serial.toUpperCase();
        serial = '';
      }

      if (!code) {
        throw new Error(`Dòng ${i + 2} bị thiếu mã dự thưởng: ${JSON.stringify(r)}`);
      }

      if (codeSet.has(code)) {
        throw new Error(`Phát hiện mã dự thưởng trùng lặp ở dòng ${i + 2}: ${code}`);
      }
      codeSet.add(code);

      luckyCodes.push({ serial, code });
    }

    // 3. Chuẩn bị file SQL hoàn chỉnh
    console.log(`Đang khởi tạo file SQL: ${sqlOutputPath}`);
    const sqlChunks = [
      '-- SQL Reset Toàn Bộ Lượt Quay & Import Mã Dự Thưởng Mới',
      `-- Thời gian sinh: ${new Date().toISOString()}`,
      `-- Tổng số mã dự thưởng: ${luckyCodes.length}`,
      '',
      'BEGIN TRANSACTION;',
      '',
      '-- 1. Tạm gỡ bỏ trigger bảo vệ trước khi xóa toàn bộ lịch sử quay và mã đã dùng',
      'DROP TRIGGER IF EXISTS protect_spin_delete;',
      'DROP TRIGGER IF EXISTS protect_used_lucky_code;',
      '',
      '-- 2. Xóa toàn bộ lịch sử quay spin_logs và reset AUTOINCREMENT',
      'DELETE FROM spin_logs;',
      "DELETE FROM sqlite_sequence WHERE name = 'spin_logs';",
      '',
      '-- 3. Xóa toàn bộ dữ liệu người tham gia phone_participants để đại lý/SĐT có thể quay lại từ đầu',
      'DELETE FROM phone_participants;',
      '',
      '-- 4. Reset kho giải thưởng về số lượng ban đầu (used_quantity = 0, remaining_quantity = total_quantity)',
      'UPDATE prizes SET remaining_quantity = total_quantity, used_quantity = 0, reserved_quantity = 0;',
      '',
      '-- 5. Xóa toàn bộ mã dự thưởng cũ và reset AUTOINCREMENT',
      'DELETE FROM lucky_codes;',
      "DELETE FROM sqlite_sequence WHERE name = 'lucky_codes';",
      '',
      '-- 6. Tái lập trigger bảo vệ tính toàn vẹn hệ thống',
      'CREATE TRIGGER IF NOT EXISTS protect_spin_delete BEFORE DELETE ON spin_logs',
      "WHEN OLD.normalized_phone IS NOT NULL BEGIN SELECT RAISE(ABORT, 'SPIN_LOCKED'); END;",
      '',
      'CREATE TRIGGER IF NOT EXISTS protect_used_lucky_code BEFORE DELETE ON lucky_codes',
      "WHEN EXISTS (SELECT 1 FROM spin_logs WHERE status = 'active' AND UPPER(entry_code) = UPPER(OLD.code))",
      "BEGIN SELECT RAISE(ABORT, 'CODE_LOCKED'); END;",
      ''
    ];

    const BATCH_SIZE = 200;
    for (let i = 0; i < luckyCodes.length; i += BATCH_SIZE) {
      const batch = luckyCodes.slice(i, i + BATCH_SIZE);
      const valueClauses = batch.map(
        (c) =>
          `  (${escapeSqlString(c.serial)}, ${escapeSqlString(c.code)}, 'unused')`
      );
      sqlChunks.push(
        'INSERT INTO lucky_codes (serial_number, code, status) VALUES\n' + valueClauses.join(',\n') + ';'
      );
    }

    sqlChunks.push('');
    sqlChunks.push('COMMIT;');
    sqlChunks.push('');

    fs.writeFileSync(sqlOutputPath, sqlChunks.join('\n'), 'utf8');
    console.log(`Đã ghi thành công file SQL: ${sqlOutputPath} (${(fs.statSync(sqlOutputPath).size / 1024).toFixed(1)} KB)`);

    // 4. Sao lưu an toàn database
    const backupDir = process.env.DATABASE_BACKUP_DIR || path.join(os.homedir(), '.quaythuongdha-backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `before-reset-codes-${Date.now()}-${randomUUID()}.db`);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`Đã sao lưu an toàn: ${backupPath}`);

    // 5. Thực thi câu lệnh SQL vào data.db
    console.log('Đang thực thi reset lượt quay và import mã dự thưởng vào database...');
    const sqlContent = fs.readFileSync(sqlOutputPath, 'utf8');
    db.exec(sqlContent);

    // 6. Kiểm tra đối soát
    const spinLogsCount = db.prepare('SELECT COUNT(*) as c FROM spin_logs').get().c;
    const participantsCount = db.prepare('SELECT COUNT(*) as c FROM phone_participants').get().c;
    const totalPrizesUsed = db.prepare('SELECT SUM(used_quantity) as s FROM prizes').get().s || 0;
    const luckyCodesCount = db.prepare('SELECT COUNT(*) as c FROM lucky_codes').get().c;
    const luckyCodesUnused = db.prepare("SELECT COUNT(*) as c FROM lucky_codes WHERE status = 'unused'").get().c;

    console.log('--- KẾT QUẢ ĐỐI SOÁT SAU RESET & IMPORT ---');
    console.log(`- Số lượt quay trong spin_logs: ${spinLogsCount} (kỳ vọng: 0)`);
    console.log(`- Số người tham gia (phone_participants): ${participantsCount} (kỳ vọng: 0)`);
    console.log(`- Tổng giải thưởng đã phát (prizes used): ${totalPrizesUsed} (kỳ vọng: 0)`);
    console.log(`- Tổng số mã dự thưởng: ${luckyCodesCount} (kỳ vọng: ${luckyCodes.length})`);
    console.log(`- Số mã ở trạng thái unused: ${luckyCodesUnused} (kỳ vọng: ${luckyCodes.length})`);

    const sample = db.prepare('SELECT * FROM lucky_codes LIMIT 3').all();
    console.log('Mẫu 3 mã dự thưởng đầu tiên:', sample);

    console.log('✓ Hoàn tất reset và import mã dự thưởng thành công 100%!');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`Lỗi thực hiện: ${err.message}`);
  process.exit(1);
});
