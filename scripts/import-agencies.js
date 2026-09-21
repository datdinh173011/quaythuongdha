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
  if (!str) return "''";
  return "'" + str.replace(/'/g, "''") + "'";
}

async function main() {
  const csvPath = path.join(__dirname, '..', 'docs', 'import_daily.csv');
  const sqlOutputPath = path.join(__dirname, 'import_agencies.sql');
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data.db');

  console.log(`Đang đọc dữ liệu từ: ${csvPath}`);
  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const rawRows = parseCSV(csvContent);

  if (rawRows.length <= 1) {
    throw new Error('File CSV không có dữ liệu hợp lệ!');
  }

  const header = rawRows[0];
  console.log('Tiêu đề CSV:', header);

  const dataRows = rawRows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  console.log(`Số dòng dữ liệu đọc được: ${dataRows.length}`);

  const agencies = [];
  const codeSet = new Set();

  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i];
    const code = (r[0] || '').trim();
    const name = (r[1] || '').trim();
    const province = (r[2] || '').trim();
    const address = (r[3] || '').trim();

    if (!code || !name || !province || !address) {
      throw new Error(`Dòng ${i + 2} bị thiếu dữ liệu bắt buộc: ${JSON.stringify(r)}`);
    }

    if (codeSet.has(code)) {
      throw new Error(`Phát hiện mã trùng lặp ở dòng ${i + 2}: ${code}`);
    }
    codeSet.add(code);

    agencies.push({ code, name, province, address });
  }

  // Chuẩn bị file SQL
  console.log(`Đang khởi tạo file SQL: ${sqlOutputPath}`);
  const sqlChunks = [
    '-- SQL Import Danh Sách Đại Lý từ docs/import_daily.csv',
    `-- Thời gian sinh: ${new Date().toISOString()}`,
    `-- Tổng số bản ghi: ${agencies.length}`,
    '',
    'BEGIN TRANSACTION;',
    '',
    '-- 1. Xóa toàn bộ dữ liệu đại lý cũ và reset chỉ số AUTOINCREMENT',
    'DELETE FROM agencies;',
    "DELETE FROM sqlite_sequence WHERE name = 'agencies';",
    ''
  ];

  const BATCH_SIZE = 200;
  for (let i = 0; i < agencies.length; i += BATCH_SIZE) {
    const batch = agencies.slice(i, i + BATCH_SIZE);
    const valueClauses = batch.map(
      (a) =>
        `  (${escapeSqlString(a.code)}, ${escapeSqlString(a.name)}, ${escapeSqlString(a.province)}, ${escapeSqlString(a.address)})`
    );
    sqlChunks.push(
      'INSERT INTO agencies (code, name, province, address) VALUES\n' + valueClauses.join(',\n') + ';'
    );
  }

  sqlChunks.push('');
  sqlChunks.push('COMMIT;');
  sqlChunks.push('');

  fs.writeFileSync(sqlOutputPath, sqlChunks.join('\n'), 'utf8');
  console.log(`Đã ghi thành công file SQL: ${sqlOutputPath} (${(fs.statSync(sqlOutputPath).size / 1024).toFixed(1)} KB)`);

  // Sao lưu và thực thi nạp vào data.db nếu database tồn tại
  if (!fs.existsSync(dbPath)) {
    console.log(`Không tìm thấy file database tại ${dbPath}. Bỏ qua bước nạp trực tiếp.`);
    return;
  }

  console.log(`Đang kết nối database: ${dbPath}`);
  const db = new Database(dbPath, { fileMustExist: true });

  try {
    const backupDir = process.env.DATABASE_BACKUP_DIR || path.join(os.homedir(), '.quaythuongdha-backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `before-import-agencies-${Date.now()}-${randomUUID()}.db`);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`Đã sao lưu an toàn: ${backupPath}`);

    const oldCount = db.prepare('SELECT COUNT(*) as c FROM agencies').get().c;
    console.log(`Số đại lý hiện tại trước khi xóa: ${oldCount}`);

    const sqlContent = fs.readFileSync(sqlOutputPath, 'utf8');
    db.exec(sqlContent);

    const newCount = db.prepare('SELECT COUNT(*) as c FROM agencies').get().c;
    console.log(`Số đại lý mới sau khi nạp: ${newCount}`);

    const firstAgency = db.prepare('SELECT * FROM agencies ORDER BY id ASC LIMIT 1').get();
    const lastAgency = db.prepare('SELECT * FROM agencies ORDER BY id DESC LIMIT 1').get();
    console.log('Bản ghi đầu tiên (ID: ' + firstAgency.id + '):', firstAgency);
    console.log('Bản ghi cuối cùng (ID: ' + lastAgency.id + '):', lastAgency);

    if (newCount !== agencies.length) {
      throw new Error(`Số lượng bản ghi không khớp! Kỳ vọng ${agencies.length}, thực tế ${newCount}`);
    }

    console.log('✓ Quá trình nạp đại lý hoàn tất thành công 100%!');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`Lỗi thực hiện: ${err.message}`);
  process.exit(1);
});
