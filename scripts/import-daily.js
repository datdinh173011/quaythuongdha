const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Trình phân tích cú pháp CSV hỗ trợ trường bọc dấu ngoặc kép, dấu phẩy và xuống dòng bên trong ngoặc
 */
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

/**
 * Tự động nhận diện chỉ số cột dựa trên header hoặc fallback theo vị trí mặc định [0, 1, 2, 3]
 */
function detectColumnIndexes(headerRow) {
  let codeIdx = -1;
  let nameIdx = -1;
  let provinceIdx = -1;
  let addressIdx = -1;

  const codeAliases = ['mã khách hàng', 'ma khach hang', 'mã đại lý', 'ma dai ly', 'mã đl', 'ma dl', 'code', 'mã'];
  const nameAliases = ['tên khách hàng', 'ten khach hang', 'tên đại lý', 'ten dai ly', 'tên đl', 'ten dl', 'tên nhà thuốc', 'name', 'tên'];
  const provinceAliases = ['tỉnh/tp', 'tinh/tp', 'tỉnh/thành', 'tinh/thanh', 'tỉnh thành', 'tinh thanh', 'tỉnh', 'tinh', 'thành phố', 'thanh pho', 'province', 'city'];
  const addressAliases = ['địa chỉ', 'dia chi', 'địa chỉ đại lý', 'address'];

  headerRow.forEach((col, idx) => {
    const clean = col.trim().toLowerCase();
    if (codeIdx === -1 && codeAliases.includes(clean)) codeIdx = idx;
    else if (nameIdx === -1 && nameAliases.includes(clean)) nameIdx = idx;
    else if (provinceIdx === -1 && provinceAliases.includes(clean)) provinceIdx = idx;
    else if (addressIdx === -1 && addressAliases.includes(clean)) addressIdx = idx;
  });

  // Fallback nếu không khớp tên
  if (codeIdx === -1) codeIdx = 0;
  if (nameIdx === -1) nameIdx = 1;
  if (provinceIdx === -1) provinceIdx = 2;
  if (addressIdx === -1) addressIdx = 3;

  return { codeIdx, nameIdx, provinceIdx, addressIdx };
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const fileArg = args.find((a) => !a.startsWith('--'));

  const csvPath = fileArg
    ? path.resolve(process.cwd(), fileArg)
    : path.join(__dirname, '..', 'docs', 'import_daily.csv');

  const sqlOutputPath = path.join(__dirname, 'import_agencies.sql');
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data.db');

  console.log('='.repeat(70));
  console.log('   CÔNG CỤ NẠP ĐẠI LÝ UPSERT (THÊM MỚI NẾU THIẾU, CẬP NHẬT NẾU CÓ)');
  console.log('='.repeat(70));
  if (isDryRun) {
    console.log('⚠️  CHẾ ĐỘ DRY-RUN: Chỉ kiểm tra và thống kê, không ghi vào database.');
  }
  console.log(`📁 File CSV nguồn: ${csvPath}`);
  console.log(`🗄️  Database đích: ${dbPath}`);

  if (!fs.existsSync(csvPath)) {
    throw new Error(`Không tìm thấy file CSV tại: ${csvPath}`);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const rawRows = parseCSV(csvContent);

  if (rawRows.length <= 1) {
    throw new Error('File CSV không có dữ liệu hợp lệ hoặc chỉ có dòng tiêu đề!');
  }

  const headerRow = rawRows[0];
  const { codeIdx, nameIdx, provinceIdx, addressIdx } = detectColumnIndexes(headerRow);
  console.log('📋 Tiêu đề CSV:', headerRow);
  console.log(
    `🔍 Ánh xạ cột: Mã=[Cột ${codeIdx + 1}: "${headerRow[codeIdx] || ''}"], ` +
    `Tên=[Cột ${nameIdx + 1}: "${headerRow[nameIdx] || ''}"], ` +
    `Tỉnh/TP=[Cột ${provinceIdx + 1}: "${headerRow[provinceIdx] || ''}"], ` +
    `Địa chỉ=[Cột ${addressIdx + 1}: "${headerRow[addressIdx] || ''}"]`
  );

  const dataRows = rawRows.slice(1).filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  console.log(`📊 Số dòng dữ liệu trong CSV: ${dataRows.length.toLocaleString('vi-VN')}`);

  // Đọc danh sách đại lý hiện có trong CSDL
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Không tìm thấy file CSDL tại: ${dbPath}`);
  }

  const db = new Database(dbPath, { fileMustExist: true });

  try {
    const existingAgencies = db.prepare('SELECT id, code, name, province, address FROM agencies').all();
    const existingMap = new Map();
    for (const a of existingAgencies) {
      existingMap.set(a.code, a);
    }
    const initialDbCount = existingAgencies.length;
    console.log(`📦 Số lượng đại lý hiện có trong Database: ${initialDbCount.toLocaleString('vi-VN')}`);

    // Phân loại các bản ghi từ CSV
    const toInsert = [];
    const toUpdate = [];
    let unchangedCount = 0;
    const skippedRows = [];
    const seenCsvCodes = new Set();
    const allValidAgencies = [];

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const lineNum = i + 2;
      const code = (r[codeIdx] || '').trim();
      const name = (r[nameIdx] || '').trim();
      const province = (r[provinceIdx] || '').trim();
      const address = (r[addressIdx] || '').trim();

      if (!code || !name || !province || !address) {
        skippedRows.push({ lineNum, reason: 'Thiếu trường bắt buộc', data: r });
        continue;
      }

      if (seenCsvCodes.has(code)) {
        skippedRows.push({ lineNum, reason: `Mã trùng lặp trong file CSV: ${code}`, data: r });
        continue;
      }
      seenCsvCodes.add(code);

      const agencyData = { code, name, province, address, lineNum };
      allValidAgencies.push(agencyData);

      if (!existingMap.has(code)) {
        // Chưa có trong Database -> CẦN THÊM MỚI
        toInsert.push(agencyData);
      } else {
        const current = existingMap.get(code);
        const isChanged =
          current.name !== name ||
          current.province !== province ||
          current.address !== address;

        if (isChanged) {
          // Đã có trong Database nhưng thông tin thay đổi -> CẦN CẬP NHẬT LẠI
          toUpdate.push({
            ...agencyData,
            old: { name: current.name, province: current.province, address: current.address }
          });
        } else {
          // Đã có và thông tin hoàn toàn trùng khớp -> GIỮ NGUYÊN
          unchangedCount++;
        }
      }
    }

    console.log('\n--- KẾT QUẢ KIỂM TRA ĐỐI SOÁT ---');
    console.log(`➕ Cần thêm mới (chưa có trong DB)   : ${toInsert.length.toLocaleString('vi-VN')} đại lý`);
    console.log(`🔄 Cần cập nhật lại (có rồi, đổi info): ${toUpdate.length.toLocaleString('vi-VN')} đại lý`);
    console.log(`✔️  Không đổi (đã có và trùng khớp)   : ${unchangedCount.toLocaleString('vi-VN')} đại lý`);
    if (skippedRows.length > 0) {
      console.log(`⚠️  Bỏ qua (thiếu tin/trùng trong CSV): ${skippedRows.length.toLocaleString('vi-VN')} dòng`);
    }

    if (toInsert.length > 0) {
      console.log('\n📌 Mẫu 3 bản ghi sẽ THÊM MỚI:');
      toInsert.slice(0, 3).forEach((a, idx) => {
        console.log(`   ${idx + 1}. [${a.code}] ${a.name} - ${a.province}`);
      });
    }

    if (toUpdate.length > 0) {
      console.log('\n📌 Mẫu 3 bản ghi sẽ CẬP NHẬT:');
      toUpdate.slice(0, 3).forEach((a, idx) => {
        console.log(`   ${idx + 1}. [${a.code}] "${a.old.name}" -> "${a.name}"`);
      });
    }

    if (isDryRun) {
      console.log('\n[DRY RUN] Đã hoàn tất kiểm tra đối soát. Không có thay đổi nào được ghi.');
      return;
    }

    // Sinh file SQL Upsert an toàn (không bao gồm lệnh DELETE)
    console.log(`\n📝 Đang tạo file SQL Upsert: ${sqlOutputPath}`);
    const sqlChunks = [
      '-- SQL Import Danh Sách Đại Lý (UPSERT - KHÔNG XÓA DỮ LIỆU CŨ)',
      `-- File nguồn: ${path.basename(csvPath)}`,
      `-- Thời gian sinh: ${new Date().toISOString()}`,
      `-- Tổng số bản ghi trong CSV: ${allValidAgencies.length}`,
      `-- Thêm mới: ${toInsert.length} | Cập nhật: ${toUpdate.length} | Giữ nguyên: ${unchangedCount}`,
      '',
      'BEGIN TRANSACTION;',
      ''
    ];

    const BATCH_SIZE = 200;
    for (let i = 0; i < allValidAgencies.length; i += BATCH_SIZE) {
      const batch = allValidAgencies.slice(i, i + BATCH_SIZE);
      const valueClauses = batch.map(
        (a) =>
          `  (${escapeSqlString(a.code)}, ${escapeSqlString(a.name)}, ${escapeSqlString(a.province)}, ${escapeSqlString(a.address)})`
      );
      sqlChunks.push(
        'INSERT INTO agencies (code, name, province, address) VALUES\n' +
        valueClauses.join(',\n') +
        '\nON CONFLICT(code) DO UPDATE SET\n' +
        '  name = excluded.name,\n' +
        '  province = excluded.province,\n' +
        '  address = excluded.address;'
      );
    }

    sqlChunks.push('');
    sqlChunks.push('COMMIT;');
    sqlChunks.push('');

    fs.writeFileSync(sqlOutputPath, sqlChunks.join('\n'), 'utf8');
    console.log(`💾 Đã lưu file SQL an toàn: ${sqlOutputPath} (${(fs.statSync(sqlOutputPath).size / 1024).toFixed(1)} KB)`);

    // Tạo bản sao lưu an toàn CSDL trước khi thực thi
    const backupDir = process.env.DATABASE_BACKUP_DIR || path.join(os.homedir(), '.quaythuongdha-backups');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `before-upsert-agencies-${Date.now()}-${randomUUID()}.db`);
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    console.log(`🛡️  Đã sao lưu database an toàn: ${backupPath}`);

    // Thực hiện UPSERT trực tiếp vào database bằng Transaction để đạt tốc độ tối đa
    console.log('⚡ Đang thực thi nạp dữ liệu vào Database...');
    const upsertStmt = db.prepare(`
      INSERT INTO agencies (code, name, province, address)
      VALUES (@code, @name, @province, @address)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        province = excluded.province,
        address = excluded.address
    `);

    const executeUpsert = db.transaction((agencies) => {
      for (const a of agencies) {
        upsertStmt.run(a);
      }
    });

    executeUpsert(allValidAgencies);

    const finalDbCount = db.prepare('SELECT COUNT(*) as c FROM agencies').get().c;
    console.log('\n' + '='.repeat(70));
    console.log('🎉 QUÁ TRÌNH IMPORT HOÀN TẤT THÀNH CÔNG!');
    console.log('='.repeat(70));
    console.log(`📊 Số đại lý ban đầu trong DB : ${initialDbCount.toLocaleString('vi-VN')}`);
    console.log(`➕ Số đại lý vừa thêm mới     : +${toInsert.length.toLocaleString('vi-VN')}`);
    console.log(`🔄 Số đại lý vừa cập nhật lại : ${toUpdate.length.toLocaleString('vi-VN')}`);
    console.log(`📦 Tổng số đại lý hiện tại    : ${finalDbCount.toLocaleString('vi-VN')}`);

    if (finalDbCount !== initialDbCount + toInsert.length) {
      console.warn(
        `⚠️ Cảnh báo: Số lượng đại lý dự kiến (${initialDbCount + toInsert.length}) khác thực tế (${finalDbCount}).`
      );
    } else {
      console.log('✅ Tính toàn vẹn số liệu: Chính xác tuyệt đối 100%!');
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`\n❌ Lỗi thực hiện: ${err.message}`);
  process.exit(1);
});
