const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
require('dotenv').config();

const db = require('./database');
const { syncToGoogleSheet, startSyncWorker } = require('./syncWorker');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// Đảm bảo thư mục uploads tồn tại
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Cấu hình Multer lưu ảnh quà tặng
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'prize-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage });
const uploadMemory = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Helper middleware check simple token/session for admin
function verifyAdmin(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Yêu cầu đăng nhập quản trị viên' });
  }
  const cleanToken = token.replace(/^Bearer\s+/i, '');
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  const validPassword = setting ? setting.value : 'bioamicus2026';
  if (cleanToken !== validPassword) {
    return res.status(403).json({ success: false, message: 'Mật khẩu quản trị không chính xác' });
  }
  next();
}

/* ========================================================
   1. CLIENT APIS (QUAY THƯỞNG & TRA CỨU)
======================================================== */

// Lấy danh sách các Tỉnh/Thành duy nhất
app.get('/api/provinces', (req, res) => {
  try {
    const provinces = db.prepare(`
      SELECT DISTINCT province 
      FROM agencies 
      WHERE province IS NOT NULL AND TRIM(province) != '' 
      ORDER BY province ASC
    `).all();
    res.json({ success: true, provinces: provinces.map(p => p.province) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Lấy danh sách Đại lý theo Tỉnh/Thành
app.get('/api/agencies', (req, res) => {
  try {
    const { province } = req.query;
    let query = 'SELECT * FROM agencies';
    let params = [];
    if (province) {
      query += ' WHERE province = ? ORDER BY name ASC';
      params.push(province);
    } else {
      query += ' ORDER BY province ASC, name ASC';
    }
    const agencies = db.prepare(query).all(...params);
    res.json({ success: true, agencies });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// THỰC HIỆN QUAY THƯỞNG
app.post('/api/spin', (req, res) => {
  const { province, agencyCode, agencyName, ownerName, phone, address, entryCode } = req.body;

  if (!province || !agencyName || !ownerName || !phone || !address || !entryCode) {
    return res.status(400).json({ 
      success: false, 
      error: 'MISSING_FIELDS', 
      message: 'Vui lòng điền đầy đủ tất cả các thông tin trước khi quay thưởng!' 
    });
  }

  const cleanCode = entryCode.trim().toUpperCase();

  try {
    const spinTransaction = db.transaction(() => {
      // 1. Kiểm tra mã dự thưởng trong lucky_codes
      const luckyCode = db.prepare('SELECT * FROM lucky_codes WHERE UPPER(code) = ?').get(cleanCode);
      if (!luckyCode) {
        return { 
          error: 'INVALID_CODE', 
          message: `Mã dự thưởng "${cleanCode}" không hợp lệ hoặc không tồn tại trong hệ thống!` 
        };
      }

      if (luckyCode.status !== 'unused') {
        return { 
          error: 'ALREADY_USED', 
          message: `Mã dự thưởng "${cleanCode}" đã được sử dụng để quay thưởng trước đó!` 
        };
      }

      // 2. Lấy danh sách các phần quà còn trong kho (remaining_quantity > 0)
      const availablePrizes = db.prepare('SELECT * FROM prizes WHERE remaining_quantity > 0').all();
      if (!availablePrizes || availablePrizes.length === 0) {
        return { 
          error: 'OUT_OF_STOCK', 
          message: 'Rất tiếc! Toàn bộ kho quà tặng của chương trình hiện đã hết.' 
        };
      }

      // 3. Random quà tặng 100% theo tỷ lệ số lượng quà còn lại trong kho
      const totalRemaining = availablePrizes.reduce((sum, p) => sum + p.remaining_quantity, 0);
      let rand = Math.floor(Math.random() * totalRemaining) + 1; // 1 -> totalRemaining
      let winningPrize = availablePrizes[0];

      let runningSum = 0;
      for (const prize of availablePrizes) {
        runningSum += prize.remaining_quantity;
        if (rand <= runningSum) {
          winningPrize = prize;
          break;
        }
      }

      // 4. Trừ 1 quà trong kho
      db.prepare(`
        UPDATE prizes 
        SET remaining_quantity = remaining_quantity - 1, 
            used_quantity = used_quantity + 1 
        WHERE id = ?
      `).run(winningPrize.id);

      // 5. Lưu bản ghi vào spin_logs (is_synced = 0)
      const now = new Date().toISOString();
      const insertSpin = db.prepare(`
        INSERT INTO spin_logs (
          spin_time, agency_code, agency_name, province, owner_name, 
          phone, address, entry_code, serial_number, prize_id, prize_tier, prize_name, prize_image, is_synced
        ) VALUES (
          datetime('now', 'localtime'), @agencyCode, @agencyName, @province, @ownerName,
          @phone, @address, @entryCode, @serialNumber, @prizeId, @prizeTier, @prizeName, @prizeImage, 0
        )
      `);

      const spinResult = insertSpin.run({
        agencyCode: agencyCode || '',
        agencyName,
        province,
        ownerName,
        phone,
        address,
        entryCode: cleanCode,
        serialNumber: luckyCode.serial_number || '',
        prizeId: winningPrize.id,
        prizeTier: winningPrize.prize_tier || 'GIẢI THƯỞNG',
        prizeName: winningPrize.name,
        prizeImage: winningPrize.image_url
      });

      const spinLogId = spinResult.lastInsertRowid;

      // 6. Đánh dấu mã dự thưởng đã sử dụng
      db.prepare(`
        UPDATE lucky_codes 
        SET status = 'used', used_at = datetime('now', 'localtime'), spin_log_id = ?
        WHERE id = ?
      `).run(spinLogId, luckyCode.id);

      return {
        success: true,
        prize: {
          id: winningPrize.id,
          tier: winningPrize.prize_tier || 'GIẢI THƯỞNG',
          name: winningPrize.name,
          image_url: winningPrize.image_url
        },
        entryCode: cleanCode,
        serialNumber: luckyCode.serial_number || '',
        agencyName,
        spinTime: new Date().toLocaleString('vi-VN')
      };
    });

    const result = spinTransaction();
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error, message: result.message });
    }

    res.json(result);
  } catch (err) {
    console.error('Lỗi khi quay thưởng:', err);
    res.status(500).json({ success: false, message: 'Đã có lỗi xảy ra trên hệ thống: ' + err.message });
  }
});

// TRA CỨU LỊCH SỬ QUAY THƯỞNG THEO SỐ ĐIỆN THOẠI
app.get('/api/history', (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone || !phone.trim()) {
      return res.status(400).json({ success: false, message: 'Vui lòng nhập số điện thoại để tra cứu!' });
    }

    const cleanPhone = phone.trim();
    const rows = db.prepare(`
      SELECT id, agency_name, prize_name, prize_image, entry_code, serial_number, spin_time 
      FROM spin_logs 
      WHERE phone = ? 
      ORDER BY id DESC
    `).all(cleanPhone);

    res.json({ success: true, count: rows.length, history: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


/* ========================================================
   2. ADMIN APIS (QUẢN TRỊ VIÊN)
======================================================== */

// Đăng nhập Admin
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  const validPassword = setting ? setting.value : 'bioamicus2026';

  if (password === validPassword) {
    res.json({ success: true, token: password });
  } else {
    res.status(401).json({ success: false, message: 'Mật khẩu quản trị không đúng!' });
  }
});

// Thống kê Dashboard Admin
app.get('/api/admin/stats', verifyAdmin, (req, res) => {
  try {
    const agencyCount = db.prepare('SELECT COUNT(*) as c FROM agencies').get().c;
    const prizeStock = db.prepare('SELECT SUM(remaining_quantity) as c FROM prizes').get().c || 0;
    const prizeWon = db.prepare('SELECT SUM(used_quantity) as c FROM prizes').get().c || 0;
    const totalSpins = db.prepare('SELECT COUNT(*) as c FROM spin_logs').get().c;
    const unsyncedSpins = db.prepare('SELECT COUNT(*) as c FROM spin_logs WHERE is_synced = 0').get().c;
    const codeTotal = db.prepare('SELECT COUNT(*) as c FROM lucky_codes').get().c;
    const codeUsed = db.prepare("SELECT COUNT(*) as c FROM lucky_codes WHERE status = 'used'").get().c;

    res.json({
      success: true,
      stats: {
        agencyCount,
        prizeStock,
        prizeWon,
        totalSpins,
        unsyncedSpins,
        codeTotal,
        codeUsed
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- QUẢN TRỊ ĐẠI LÝ ---
app.get('/api/admin/agencies', verifyAdmin, (req, res) => {
  try {
    const { q, province } = req.query;
    let sql = 'SELECT * FROM agencies WHERE 1=1';
    const params = [];
    if (q && q.trim()) {
      sql += ' AND (name LIKE ? OR code LIKE ? OR address LIKE ?)';
      const term = `%${q.trim()}%`;
      params.push(term, term, term);
    }
    if (province && province.trim()) {
      sql += ' AND province = ?';
      params.push(province.trim());
    }
    sql += ' ORDER BY id DESC';
    const agencies = db.prepare(sql).all(...params);
    res.json({ success: true, agencies });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/agencies', verifyAdmin, (req, res) => {
  try {
    const { code, name, province, address } = req.body;
    if (!name || !province || !address) {
      return res.status(400).json({ success: false, message: 'Tên đại lý, tỉnh thành và địa chỉ là bắt buộc.' });
    }
    const finalCode = code && code.trim() ? code.trim() : 'DL' + Date.now().toString().slice(-6);
    const insert = db.prepare(`
      INSERT INTO agencies (code, name, province, address)
      VALUES (?, ?, ?, ?)
    `);
    const info = insert.run(finalCode, name.trim(), province.trim(), address.trim());
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/agencies/:id', verifyAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, province, address } = req.body;
    db.prepare(`
      UPDATE agencies 
      SET code = ?, name = ?, province = ?, address = ? 
      WHERE id = ?
    `).run(code, name, province, address, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/agencies/:id', verifyAdmin, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM agencies WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Import đại lý từ file Excel
app.post('/api/admin/agencies/import', verifyAdmin, uploadMemory.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Vui lòng chọn file Excel!' });
    }
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ success: false, message: 'File Excel không có dữ liệu!' });
    }

    const insertOrReplace = db.prepare(`
      INSERT INTO agencies (code, name, province, address)
      VALUES (@code, @name, @province, @address)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        province = excluded.province,
        address = excluded.address
    `);

    let importedCount = 0;
    const importTransaction = db.transaction((rows) => {
      for (const row of rows) {
        let code = '';
        let name = '';
        let province = '';
        let address = '';

        // Tự động nhận diện cột linh hoạt không phân biệt hoa thường/khoảng trắng thừa
        for (const key of Object.keys(row)) {
          const cleanKey = key.trim().toLowerCase();
          if (['mã đại lý', 'ma dai ly', 'mã đl', 'ma dl', 'code', 'mã'].includes(cleanKey)) {
            code = row[key];
          } else if (['tên đại lý', 'ten dai ly', 'tên đl', 'ten dl', 'tên nhà thuốc', 'tên shop', 'tên cửa hàng', 'name'].includes(cleanKey)) {
            name = row[key];
          } else if (['tỉnh/thành', 'tinh/thanh', 'tỉnh thành', 'tinh thanh', 'tỉnh', 'tinh', 'thành phố', 'thanh pho', 'province', 'city'].includes(cleanKey)) {
            province = row[key];
          } else if (['địa chỉ', 'dia chi', 'địa chỉ đại lý', 'address'].includes(cleanKey)) {
            address = row[key];
          }
        }

        // Fallback kiểm tra trực tiếp
        if (!code) code = row['Mã đại lý'] || row['Mã ĐL'] || row['Code'] || row['code'] || ('DL' + Math.floor(100000 + Math.random() * 900000));
        if (!name) name = row['Tên đại lý'] || row['Tên ĐL'] || row['Name'] || row['name'];
        if (!province) province = row['Tỉnh/thành'] || row['Tỉnh thành'] || row['Tỉnh'] || row['Province'] || row['province'];
        if (!address) address = row['Địa chỉ'] || row['Address'] || row['address'];

        if (name && province && address) {
          insertOrReplace.run({
            code: String(code).trim(),
            name: String(name).trim(),
            province: String(province).trim(),
            address: String(address).trim()
          });
          importedCount++;
        }
      }
    });

    importTransaction(rawData);
    res.json({ success: true, count: importedCount, message: `Đã nhập thành công ${importedCount} đại lý.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi đọc file Excel: ' + err.message });
  }
});


// --- QUẢN TRỊ QUÀ TẶNG ---
app.get('/api/admin/prizes', verifyAdmin, (req, res) => {
  try {
    const prizes = db.prepare('SELECT * FROM prizes ORDER BY id ASC').all();
    const totalRemaining = prizes.reduce((sum, p) => sum + p.remaining_quantity, 0);

    // Tính tỷ lệ % trúng thưởng tự động theo lượng tồn kho
    const enrichedPrizes = prizes.map(p => {
      const rate = totalRemaining > 0 ? ((p.remaining_quantity / totalRemaining) * 100).toFixed(2) : '0.00';
      return {
        ...p,
        win_rate: rate + '%'
      };
    });

    res.json({ success: true, prizes: enrichedPrizes, totalRemaining });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/prizes', verifyAdmin, upload.single('image'), (req, res) => {
  try {
    const { code, prize_tier, name, quantity, image_url } = req.body;
    if (!code || !name || !quantity) {
      return res.status(400).json({ success: false, message: 'Vui lòng điền mã quà, tên quà và số lượng!' });
    }

    const qty = parseInt(quantity, 10) || 0;
    let finalImageUrl = '/img/Artboard 23@2x.png';
    if (req.file) {
      finalImageUrl = '/uploads/' + req.file.filename;
    } else if (image_url && image_url.trim()) {
      finalImageUrl = image_url.trim();
    }

    const tier = (prize_tier && prize_tier.trim()) ? prize_tier.trim() : 'GIẢI THƯỞNG';

    const insert = db.prepare(`
      INSERT INTO prizes (code, prize_tier, name, image_url, total_quantity, remaining_quantity, used_quantity)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `);
    const info = insert.run(code.trim().toUpperCase(), tier, name.trim(), finalImageUrl, qty, qty);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/admin/prizes/:id', verifyAdmin, upload.single('image'), (req, res) => {
  try {
    const { id } = req.params;
    const { code, prize_tier, name, total_quantity, remaining_quantity, image_url } = req.body;
    const current = db.prepare('SELECT * FROM prizes WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy quà!' });
    }

    let finalImageUrl = current.image_url;
    if (req.file) {
      finalImageUrl = '/uploads/' + req.file.filename;
    } else if (image_url && image_url.trim()) {
      finalImageUrl = image_url.trim();
    }

    const totalQty = parseInt(total_quantity, 10) >= 0 ? parseInt(total_quantity, 10) : current.total_quantity;
    const remainQty = parseInt(remaining_quantity, 10) >= 0 ? parseInt(remaining_quantity, 10) : current.remaining_quantity;
    const usedQty = Math.max(0, totalQty - remainQty);
    const tier = (prize_tier && prize_tier.trim()) ? prize_tier.trim() : (current.prize_tier || 'GIẢI THƯỞNG');

    db.prepare(`
      UPDATE prizes 
      SET code = ?, prize_tier = ?, name = ?, image_url = ?, total_quantity = ?, remaining_quantity = ?, used_quantity = ?
      WHERE id = ?
    `).run(code ? code.trim().toUpperCase() : current.code, tier, name ? name.trim() : current.name, finalImageUrl, totalQty, remainQty, usedQty, id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/prizes/:id', verifyAdmin, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM prizes WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// --- QUẢN TRỊ MÃ DỰ THƯỞNG & SERIAL ---
app.get('/api/admin/lucky-codes', verifyAdmin, (req, res) => {
  try {
    const { q, status } = req.query;
    let sql = 'SELECT * FROM lucky_codes WHERE 1=1';
    const params = [];
    if (q && q.trim()) {
      sql += ' AND (code LIKE ? OR serial_number LIKE ?)';
      const term = `%${q.trim()}%`;
      params.push(term, term);
    }
    if (status && status !== 'all') {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY id DESC LIMIT 500';
    const codes = db.prepare(sql).all(...params);
    res.json({ success: true, codes });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/lucky-codes', verifyAdmin, (req, res) => {
  try {
    const { code, serial_number } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Mã dự thưởng không được để trống!' });
    }
    const cleanCode = code.trim().toUpperCase();
    const cleanSerial = serial_number ? serial_number.trim() : '';

    db.prepare(`
      INSERT INTO lucky_codes (serial_number, code, status)
      VALUES (?, ?, 'unused')
    `).run(cleanSerial, cleanCode);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/admin/lucky-codes/:id', verifyAdmin, (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM lucky_codes WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Import mã dự thưởng & serial từ file Excel
app.post('/api/admin/lucky-codes/import', verifyAdmin, uploadMemory.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Vui lòng chọn file Excel!' });
    }
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!rawData || rawData.length === 0) {
      return res.status(400).json({ success: false, message: 'File Excel không có dữ liệu!' });
    }

    const insertCode = db.prepare(`
      INSERT OR IGNORE INTO lucky_codes (serial_number, code, status)
      VALUES (@serial_number, @code, 'unused')
    `);

    let importedCount = 0;
    const importTransaction = db.transaction((rows) => {
      for (const row of rows) {
        let code = null;
        let serial = '';

        // Tự động nhận diện cột linh hoạt (không phân biệt hoa/thường, khoảng trắng thừa)
        for (const key of Object.keys(row)) {
          const cleanKey = key.trim().toLowerCase();
          if (['mã dự thưởng', 'ma du thuong', 'mã quay thưởng', 'ma quay thuong', 'mã cào', 'ma cao', 'code', 'mã thẻ'].includes(cleanKey)) {
            code = row[key];
          } else if (['mã serial', 'ma serial', 'số serial', 'so serial', 'serial', 'serial number', 'số seri', 'so seri', 'mã seri'].includes(cleanKey)) {
            serial = row[key];
          }
        }

        // Fallback kiểm tra trực tiếp
        if (!code) {
          code = row['Mã dự thưởng'] || row['Mã quay thưởng'] || row['Mã cào'] || row['Code'] || row['code'];
        }
        if (!serial) {
          serial = row['Mã serial'] || row['Số serial'] || row['Serial'] || row['serial'] || '';
        }

        if (code !== null && code !== undefined && String(code).trim()) {
          const res = insertCode.run({
            code: String(code).trim().toUpperCase(),
            serial_number: serial ? String(serial).trim() : ''
          });
          if (res.changes > 0) importedCount++;
        }
      }
    });

    importTransaction(rawData);
    res.json({ success: true, count: importedCount, message: `Đã nạp thành công ${importedCount} mã dự thưởng mới.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Lỗi đọc file Excel: ' + err.message });
  }
});


// --- QUẢN TRỊ LƯỢT QUAY & ĐỒNG BỘ GOOGLE SHEETS ---
app.get('/api/admin/spins', verifyAdmin, (req, res) => {
  try {
    const { q, synced } = req.query;
    let sql = 'SELECT * FROM spin_logs WHERE 1=1';
    const params = [];
    if (q && q.trim()) {
      sql += ' AND (phone LIKE ? OR entry_code LIKE ? OR serial_number LIKE ? OR agency_name LIKE ? OR owner_name LIKE ?)';
      const term = `%${q.trim()}%`;
      params.push(term, term, term, term, term);
    }
    if (synced !== undefined && synced !== 'all') {
      sql += ' AND is_synced = ?';
      params.push(parseInt(synced, 10));
    }
    sql += ' ORDER BY id DESC LIMIT 500';
    const spins = db.prepare(sql).all(...params);
    res.json({ success: true, spins });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// XÓA LƯỢT QUAY ĐỂ QUAY LẠI (HOÀN MÃ VÀ HOÀN KHO QUÀ)
app.delete('/api/admin/spins/:id', verifyAdmin, (req, res) => {
  const { id } = req.params;

  try {
    const deleteTransaction = db.transaction(() => {
      // 1. Tìm thông tin lượt quay
      const spin = db.prepare('SELECT * FROM spin_logs WHERE id = ?').get(id);
      if (!spin) {
        return { notFound: true };
      }

      // 2. Hoàn lại 1 quà vào kho quà tương ứng
      if (spin.prize_id) {
        db.prepare(`
          UPDATE prizes 
          SET remaining_quantity = remaining_quantity + 1,
              used_quantity = MAX(0, used_quantity - 1)
          WHERE id = ?
        `).run(spin.prize_id);
      }

      // 3. Khôi phục mã dự thưởng về trạng thái 'unused'
      if (spin.entry_code) {
        db.prepare(`
          UPDATE lucky_codes 
          SET status = 'unused', used_at = NULL, spin_log_id = NULL 
          WHERE UPPER(code) = ?
        `).run(spin.entry_code.toUpperCase());
      }

      // 4. Xóa bản ghi lượt quay
      db.prepare('DELETE FROM spin_logs WHERE id = ?').run(id);

      return { success: true };
    });

    const result = deleteTransaction();
    if (result.notFound) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy lượt quay!' });
    }

    res.json({ 
      success: true, 
      message: 'Đã xóa lượt quay thành công! Mã dự thưởng đã được giải phóng để quay lại, số lượng quà đã được cộng hoàn lại vào kho.' 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Kích hoạt đồng bộ Google Sheet ngay lập tức
app.post('/api/admin/sync-sheet', verifyAdmin, async (req, res) => {
  try {
    const result = await syncToGoogleSheet();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Xuất lịch sử quay ra file Excel (.xlsx)
app.get('/api/admin/export-spins', verifyAdmin, (req, res) => {
  try {
    const spins = db.prepare('SELECT * FROM spin_logs ORDER BY id DESC').all();
    const exportData = spins.map((s, idx) => ({
      'STT': idx + 1,
      'Thời gian': s.spin_time,
      'Mã đại lý': s.agency_code || '',
      'Tên đại lý': s.agency_name,
      'Tỉnh/thành': s.province,
      'Chủ đại lý': s.owner_name,
      'Số điện thoại': s.phone,
      'Địa chỉ': s.address,
      'Mã dự thưởng': s.entry_code,
      'Mã serial': s.serial_number || '',
      'Tên giải': s.prize_tier || '',
      'Phần quà trúng': s.prize_name,
      'Đã đồng bộ Google Sheet': s.is_synced === 1 ? 'Đã đồng bộ' : 'Chưa đồng bộ'
    }));

    const worksheet = xlsx.utils.json_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'LichSuQuayThuong');

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="Lich_su_quay_thuong_BioAmicus.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cài đặt Webhook URL & Đổi mật khẩu
app.get('/api/admin/settings', verifyAdmin, (req, res) => {
  try {
    const webhookSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('google_sheet_webhook_url');
    res.json({
      success: true,
      google_sheet_webhook_url: webhookSetting ? webhookSetting.value : ''
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/settings', verifyAdmin, (req, res) => {
  try {
    const { google_sheet_webhook_url, new_password } = req.body;
    if (google_sheet_webhook_url !== undefined) {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('google_sheet_webhook_url', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(google_sheet_webhook_url.trim());
    }
    if (new_password && new_password.trim()) {
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('admin_password', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(new_password.trim());
    }
    res.json({ success: true, message: 'Đã lưu cài đặt thành công!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Khởi động server
app.listen(PORT, HOST, () => {
  console.log(`Server BioAmicus đang chạy tại http://localhost:${PORT}`);
  console.log(`Trang quay thưởng: http://localhost:${PORT}`);
  console.log(`Trang Admin: http://localhost:${PORT}/admin`);
  
  // Khởi động background worker 2 phút/lần đồng bộ Google Sheet
  startSyncWorker();
});
