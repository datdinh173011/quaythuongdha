const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { migrateLottery, isLotteryReady } = require('./lotterySchema');
const { migrateCampaign, isCampaignReady } = require('./campaignSchema');
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data.db');
const db = new Database(dbPath);

const existingSchema = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spin_logs'").get();
if (existingSchema && (!isLotteryReady(db) || !isCampaignReady(db))) {
  db.close();
  throw new Error('DATABASE_MIGRATION_REQUIRED: Dừng server/worker và chạy npm run db:migrate trước khi khởi động.');
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name TEXT NOT NULL,
      province TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      prize_tier TEXT NOT NULL DEFAULT 'GIẢI THƯỞNG',
      name TEXT NOT NULL,
      image_url TEXT NOT NULL,
      total_quantity INTEGER NOT NULL DEFAULT 0,
      remaining_quantity INTEGER NOT NULL DEFAULT 0,
      used_quantity INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS lucky_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial_number TEXT,
      code TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'unused',
      used_at DATETIME NULL,
      spin_log_id INTEGER NULL
    );

    CREATE TABLE IF NOT EXISTS spin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spin_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      agency_code TEXT,
      agency_name TEXT,
      province TEXT,
      bank_code TEXT,
      bank_name TEXT,
      bank_account_number TEXT,
      bank_account_holder_name TEXT,
      phone TEXT,
      address TEXT,
      entry_code TEXT,
      serial_number TEXT,
      prize_id INTEGER,
      prize_tier TEXT,
      prize_name TEXT,
      prize_image TEXT,
      is_synced INTEGER DEFAULT 0,
      synced_at DATETIME NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Migration kiểm tra và thêm cột prize_tier nếu bảng đã tồn tại từ trước
  const prizeColumns = db.prepare("PRAGMA table_info(prizes)").all().map(c => c.name);
  if (!prizeColumns.includes('prize_tier')) {
    db.exec("ALTER TABLE prizes ADD COLUMN prize_tier TEXT NOT NULL DEFAULT 'GIẢI THƯỞNG';");
  }

  const spinColumns = db.prepare("PRAGMA table_info(spin_logs)").all().map(c => c.name);
  if (!spinColumns.includes('prize_tier')) {
    db.exec("ALTER TABLE spin_logs ADD COLUMN prize_tier TEXT;");
  }

  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  insertSetting.run('admin_password', 'bioamicus2026');
  insertSetting.run('google_sheet_webhook_url', '');

  // Cập nhật giá trị prize_tier cho các giải thưởng mẫu hiện có nếu trống
  db.prepare(`UPDATE prizes SET prize_tier = 'GIẢI NHẤT', image_url = '/img/Giải Nhất.png' WHERE code = 'GIAI_NHAT' AND (prize_tier IS NULL OR prize_tier = 'GIẢI THƯỞNG')`).run();
  db.prepare(`UPDATE prizes SET prize_tier = 'GIẢI NHÌ' WHERE code = 'GIAI_NHI' AND (prize_tier IS NULL OR prize_tier = 'GIẢI THƯỞNG')`).run();
  db.prepare(`UPDATE prizes SET prize_tier = 'GIẢI BA' WHERE code = 'GIAI_BA' AND (prize_tier IS NULL OR prize_tier = 'GIẢI THƯỞNG')`).run();
  db.prepare(`UPDATE prizes SET prize_tier = 'GIẢI KHUYẾN KHÍCH' WHERE code = 'GIAI_KHUYEN_KHICH' AND (prize_tier IS NULL OR prize_tier = 'GIẢI THƯỞNG')`).run();

  const agencyCount = db.prepare('SELECT COUNT(*) as count FROM agencies').get().count;
  if (agencyCount === 0) {
    const insertAgency = db.prepare(`
      INSERT INTO agencies (code, name, province, address)
      VALUES (@code, @name, @province, @address)
    `);

    const initialAgencies = [
      { code: 'DL001', name: 'Đại lý An Bình', province: 'Hà Nội', address: '123 Nguyễn Trãi' },
      { code: 'DL002', name: 'Đại lý Bình Minh', province: 'Hà Nội', address: '456 Lê Lợi' },
      { code: 'DL003', name: 'Đại lý Toàn Cầu', province: 'Đà Nẵng', address: '789 Nguyễn Văn Linh' },
      { code: 'DL004', name: 'Đại lý Hùng Vương', province: 'TP.HCM', address: '111 Hùng Vương' },
      { code: 'DL005', name: 'Đại lý Nam Sài Gòn', province: 'TP.HCM', address: '222 Nguyễn Văn Linh' },
      { code: 'DL006', name: 'Đại lý Phương Đông', province: 'Cần Thơ', address: '333 30 Tháng 4' },
      { code: 'DL007', name: 'Đại lý Hải Hà', province: 'Hải Phòng', address: '88 Lạch Tray' }
    ];

    const insertMany = db.transaction((agencies) => {
      for (const a of agencies) insertAgency.run(a);
    });
    insertMany(initialAgencies);
  }

  const prizeCount = db.prepare('SELECT COUNT(*) as count FROM prizes').get().count;
  if (prizeCount === 0) {
    const insertPrize = db.prepare(`
      INSERT INTO prizes (code, prize_tier, name, image_url, total_quantity, remaining_quantity, used_quantity)
      VALUES (@code, @prize_tier, @name, @image_url, @total_quantity, @remaining_quantity, @used_quantity)
    `);

    const initialPrizes = [
      {
        code: 'NHAT',
        prize_tier: 'GIẢI NHẤT',
        name: '0,5 chỉ vàng 999',
        image_url: '/img/Giải Nhất.png',
        total_quantity: 5,
        remaining_quantity: 5,
        used_quantity: 0
      },
      {
        code: 'NHI',
        prize_tier: 'GIẢI NHÌ',
        name: '0,1 chỉ vàng Tiểu Kim Cát',
        image_url: '/img/Artboard 23@2x.png',
        total_quantity: 15,
        remaining_quantity: 15,
        used_quantity: 0
      },
      {
        code: 'BA',
        prize_tier: 'GIẢI BA',
        name: '01 lì xì trị giá 500.000 đồng',
        image_url: '/img/Artboard 23@2x.png',
        total_quantity: 50,
        remaining_quantity: 50,
        used_quantity: 0
      },
      {
        code: 'CAOLON',
        prize_tier: 'GIẢI KHUYẾN KHÍCH',
        name: '01 lọ BioAmicus D3K2',
        image_url: '/img/Artboard 23@2x.png',
        total_quantity: 100,
        remaining_quantity: 100,
        used_quantity: 0
      },
      {
        code: 'MAYMAN1',
        prize_tier: 'GIẢI MAY MẮN 1',
        name: '01 lì xì trị giá 100.000 đồng',
        image_url: '/img/Artboard 23@2x.png',
        total_quantity: 650,
        remaining_quantity: 650,
        used_quantity: 0
      },
      {
        code: 'MAYMAN2',
        prize_tier: 'GIẢI MAY MẮN 2',
        name: '01 lì xì trị giá 50.000 đồng',
        image_url: '/img/Artboard 23@2x.png',
        total_quantity: 900,
        remaining_quantity: 900,
        used_quantity: 0
      }
    ];

    const insertManyPrizes = db.transaction((prizes) => {
      for (const p of prizes) insertPrize.run(p);
    });
    insertManyPrizes(initialPrizes);
  }

  const codeCount = db.prepare('SELECT COUNT(*) as count FROM lucky_codes').get().count;
  if (codeCount === 0) {
    const insertCode = db.prepare(`
      INSERT INTO lucky_codes (serial_number, code, status)
      VALUES (@serial_number, @code, 'unused')
    `);

    const initialCodes = [];
    for (let i = 1; i <= 30; i++) {
      const pad = String(i).padStart(3, '0');
      initialCodes.push({
        serial_number: `SR-2026-${pad}`,
        code: `BIO${pad}`
      });
    }

    const insertManyCodes = db.transaction((codes) => {
      for (const c of codes) insertCode.run(c);
    });
    insertManyCodes(initialCodes);
  }
}

if (!existingSchema) {
  initDatabase();
  migrateLottery(db);
  migrateCampaign(db);
}
module.exports = db;
