const RULE_VERSION = 'phone-v3';
const MIGRATION_VERSION = 'phone-only-v3';
const PRIZE_CODES = ['MAYMAN2', 'MAYMAN1', 'CAOLON', 'BA', 'NHI', 'NHAT'];

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function isLotteryReady(db) {
  return hasTable(db, 'schema_migrations')
    && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(MIGRATION_VERSION);
}

function reconciliation(message) {
  const error = new Error(message);
  error.code = 'LEGACY_RECONCILIATION_REQUIRED';
  throw error;
}

function validateLegacySource(db) {
  for (const table of ['campaigns', 'campaign_participants', 'phone_participants', 'reward_groups', 'dealer_milestones', 'agency_milestones']) {
    if (hasTable(db, table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      reconciliation(`Bảng ${table} đã có dữ liệu. Cần đối soát riêng, không tự gộp.`);
    }
  }
  const columns = db.prepare('PRAGMA table_info(spin_logs)').all().map(column => column.name);
  for (const column of ['campaign_id', 'spin_number', 'rule_version']) {
    if (columns.includes(column) && db.prepare(`SELECT 1 FROM spin_logs WHERE ${column} IS NOT NULL LIMIT 1`).get()) {
      reconciliation('Lịch sử đã có dữ liệu theo luật/kỳ khác. Không tự đánh số lại.');
    }
  }
  if (columns.includes('status') && db.prepare("SELECT 1 FROM spin_logs WHERE status IS NOT 'active' LIMIT 1").get()) {
    reconciliation('Lịch sử có trạng thái không phù hợp để chuyển đổi tự động.');
  }
  const prizeColumns = db.prepare('PRAGMA table_info(prizes)').all().map(column => column.name);
  if (prizeColumns.includes('reserved_quantity') && db.prepare('SELECT 1 FROM prizes WHERE reserved_quantity != 0 LIMIT 1').get()) {
    reconciliation('Còn vàng giữ chỗ; cần đối soát riêng.');
  }
}

function removeEmptyCampaignSchema(db) {
  const oldNames = ['unique_campaign_spin', 'unique_active_campaign_spin', 'one_active_phone_gold',
    'one_active_phone_500k', 'spin_milestone_lookup', 'spin_phone_latest', 'spin_entry_lookup',
    'protect_campaign_spin_delete', 'protect_campaign_spin_update', 'protect_spin_void_transition', 'protect_used_lucky_code'];
  for (const name of oldNames) {
    const object = db.prepare("SELECT type FROM sqlite_master WHERE name = ? AND type IN ('index', 'trigger')").get(name);
    if (object) db.exec(`DROP ${object.type} ${name}`);
  }
  for (const table of ['phone_participants', 'campaign_participants', 'dealer_milestones', 'agency_milestones', 'reward_groups', 'campaigns']) {
    if (hasTable(db, table)) db.exec(`DROP TABLE ${table}`);
  }
  if (db.prepare('PRAGMA table_info(spin_logs)').all().some(column => column.name === 'campaign_id')) {
    db.exec('ALTER TABLE spin_logs DROP COLUMN campaign_id');
  }
}

function backfillLegacy(db) {
  const { normalizePhone, validatePrizeConfiguration } = require('./lottery');
  validatePrizeConfiguration(db);
  const counts = new Map();
  const awards = new Set();
  const entries = new Set();
  const prizeCounts = new Map();
  const logs = db.prepare('SELECT * FROM spin_logs ORDER BY julianday(spin_time), id').all();
  const update = db.prepare(`UPDATE spin_logs SET normalized_phone = ?, spin_number = ?,
    cycle_number = ?, position_in_cycle = ?, prize_code = ?, rule_version = 'legacy',
    decision_reason = 'LEGACY_IMPORTED', record_version = record_version + 1, is_synced = 0, synced_at = NULL WHERE id = ?`);
  for (const log of logs) {
    let phone;
    try { phone = normalizePhone(log.phone); } catch { reconciliation(`SĐT không hợp lệ tại bản ghi ${log.id}.`); }
    const timestamp = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(log.spin_time || '');
    if (!timestamp || !Number.isFinite(Date.parse(log.spin_time))
      || Number(timestamp[2]) < 1 || Number(timestamp[2]) > 12
      || Number(timestamp[3]) < 1 || Number(timestamp[3]) > new Date(Date.UTC(Number(timestamp[1]), Number(timestamp[2]), 0)).getUTCDate()
      || Number(timestamp[4]) > 23 || Number(timestamp[5]) > 59 || Number(timestamp[6]) > 59) {
      reconciliation(`Thời gian không hợp lệ tại bản ghi ${log.id}.`);
    }
    const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(log.prize_id);
    if (!prize || !PRIZE_CODES.includes(prize.code) || prize.name !== log.prize_name
      || (log.prize_tier && prize.prize_tier !== log.prize_tier)) {
      reconciliation(`Không đối chiếu được quà tại bản ghi ${log.id}.`);
    }
    const entryCode = typeof log.entry_code === 'string' ? log.entry_code.toUpperCase() : '';
    const codes = db.prepare('SELECT * FROM lucky_codes WHERE UPPER(code) = ?').all(entryCode);
    if (!entryCode || entries.has(entryCode) || codes.length !== 1 || codes[0].status !== 'used' || codes[0].spin_log_id !== log.id) {
      reconciliation(`Liên kết mã không đủ để hoàn an toàn tại bản ghi ${log.id}.`);
    }
    entries.add(entryCode);
    if (['NHI', 'NHAT', 'BA'].includes(prize.code)) {
      const awardKey = `${phone}:${prize.code === 'BA' ? '500k' : 'gold'}`;
      if (awards.has(awardKey)) reconciliation(`Lịch sử vi phạm giới hạn thưởng tại bản ghi ${log.id}.`);
      awards.add(awardKey);
    }
    prizeCounts.set(prize.id, (prizeCounts.get(prize.id) || 0) + 1);
    if (prizeCounts.get(prize.id) > prize.used_quantity) reconciliation(`Kho không đủ để hoàn lịch sử của quà ${prize.code}.`);
    const spinNumber = (counts.get(phone) || 0) + 1;
    counts.set(phone, spinNumber);
    update.run(phone, spinNumber, Math.floor((spinNumber - 1) / 30) + 1, ((spinNumber - 1) % 30) + 1, prize.code, log.id);
  }
  const insert = db.prepare('INSERT INTO phone_participants (phone, spin_count) VALUES (?, ?)');
  for (const [phone, count] of counts) insert.run(phone, count);
}

function migrateLottery(db) {
  db.transaction(() => {
    if (isLotteryReady(db)) return;
    validateLegacySource(db);
    const prizeColumns = db.prepare('PRAGMA table_info(prizes)').all().map(column => column.name);
    if (!prizeColumns.includes('reserved_quantity')) {
      db.exec('ALTER TABLE prizes ADD COLUMN reserved_quantity INTEGER NOT NULL DEFAULT 0');
    }
    const spinColumns = db.prepare('PRAGMA table_info(spin_logs)').all().map(column => column.name);
    const additions = {
      normalized_phone: 'TEXT', spin_number: 'INTEGER',
      prize_code: 'TEXT', rule_version: 'TEXT', decision_reason: 'TEXT',
      cycle_number: 'INTEGER', position_in_cycle: 'INTEGER', decision_a: 'INTEGER', decision_b: 'INTEGER',
      status: "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void'))",
      voided_at: 'TEXT', voided_by: 'TEXT',
      record_version: 'INTEGER NOT NULL DEFAULT 1 CHECK (record_version >= 1)',
    };
    for (const [name, type] of Object.entries(additions)) {
      if (!spinColumns.includes(name)) db.exec(`ALTER TABLE spin_logs ADD COLUMN ${name} ${type}`);
    }
    removeEmptyCampaignSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS phone_participants (
        phone TEXT NOT NULL,
        spin_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(spin_count) = 'integer' AND spin_count >= 0),
        PRIMARY KEY (phone)
      );
    `);
    backfillLegacy(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS unique_active_phone_spin
        ON spin_logs(normalized_phone, spin_number)
        WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_phone_gold
        ON spin_logs(normalized_phone)
        WHERE status = 'active' AND prize_code IN ('NHI', 'NHAT');
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_phone_500k
        ON spin_logs(normalized_phone)
        WHERE status = 'active' AND prize_code = 'BA';
      CREATE INDEX IF NOT EXISTS spin_milestone_lookup ON spin_logs(spin_number, status, prize_code, normalized_phone);
      CREATE INDEX IF NOT EXISTS spin_phone_latest ON spin_logs(normalized_phone, status, spin_number DESC);
      CREATE INDEX IF NOT EXISTS spin_entry_lookup ON spin_logs(UPPER(entry_code));
      CREATE TRIGGER IF NOT EXISTS protect_spin_delete BEFORE DELETE ON spin_logs
      WHEN OLD.normalized_phone IS NOT NULL BEGIN SELECT RAISE(ABORT, 'SPIN_LOCKED'); END;
      DROP TRIGGER IF EXISTS protect_spin_update;
      CREATE TRIGGER protect_spin_update
      BEFORE UPDATE OF normalized_phone, spin_number, agency_code, phone, entry_code,
        prize_id, prize_code, rule_version, decision_reason, cycle_number, position_in_cycle, decision_a, decision_b,
        prize_name, prize_tier, prize_image, agency_name, province, address, owner_name, spin_time, serial_number ON spin_logs
      WHEN OLD.normalized_phone IS NOT NULL BEGIN SELECT RAISE(ABORT, 'SPIN_LOCKED'); END;
      CREATE TRIGGER IF NOT EXISTS protect_spin_void_transition
      BEFORE UPDATE OF status, record_version, voided_at, voided_by ON spin_logs
      WHEN NOT (
        OLD.status = 'active' AND NEW.status = 'void'
        AND NEW.record_version = OLD.record_version + 1 AND NEW.voided_at IS NOT NULL
        AND NEW.voided_by IS NOT NULL AND LENGTH(NEW.voided_by) > 0
        AND NOT EXISTS (SELECT 1 FROM spin_logs later WHERE later.normalized_phone = OLD.normalized_phone AND later.status = 'active' AND later.spin_number > OLD.spin_number)
      ) OR OLD.rule_version IS NULL
      BEGIN SELECT RAISE(ABORT, 'INVALID_VOID_TRANSITION'); END;
      DROP TRIGGER IF EXISTS protect_used_lucky_code;
      CREATE TRIGGER protect_used_lucky_code BEFORE DELETE ON lucky_codes
      WHEN EXISTS (SELECT 1 FROM spin_logs WHERE status = 'active' AND UPPER(entry_code) = UPPER(OLD.code))
      BEGIN SELECT RAISE(ABORT, 'CODE_LOCKED'); END;
      CREATE TRIGGER IF NOT EXISTS protect_rule_prize_code BEFORE UPDATE OF code ON prizes
      WHEN OLD.code IN ('MAYMAN2', 'MAYMAN1', 'CAOLON', 'BA', 'NHI', 'NHAT') AND NEW.code IS NOT OLD.code
      BEGIN SELECT RAISE(ABORT, 'PRIZE_LOCKED'); END;
      CREATE TRIGGER IF NOT EXISTS protect_rule_prize_delete BEFORE DELETE ON prizes
      WHEN OLD.code IN ('MAYMAN2', 'MAYMAN1', 'CAOLON', 'BA', 'NHI', 'NHAT')
      BEGIN SELECT RAISE(ABORT, 'PRIZE_LOCKED'); END;
      CREATE TRIGGER IF NOT EXISTS validate_prize_stock_update BEFORE UPDATE ON prizes
      WHEN typeof(NEW.remaining_quantity) != 'integer' OR typeof(NEW.reserved_quantity) != 'integer'
        OR typeof(NEW.total_quantity) != 'integer' OR typeof(NEW.used_quantity) != 'integer'
        OR NEW.reserved_quantity < 0 OR NEW.remaining_quantity < NEW.reserved_quantity
        OR NEW.used_quantity < 0 OR NEW.total_quantity != NEW.remaining_quantity + NEW.used_quantity
      BEGIN SELECT RAISE(ABORT, 'INVALID_STOCK'); END;
      CREATE TRIGGER IF NOT EXISTS validate_prize_stock_insert BEFORE INSERT ON prizes
      WHEN typeof(NEW.remaining_quantity) != 'integer' OR typeof(NEW.reserved_quantity) != 'integer'
        OR typeof(NEW.total_quantity) != 'integer' OR typeof(NEW.used_quantity) != 'integer'
        OR NEW.reserved_quantity < 0 OR NEW.remaining_quantity < NEW.reserved_quantity
        OR NEW.used_quantity < 0 OR NEW.total_quantity != NEW.remaining_quantity + NEW.used_quantity
      BEGIN SELECT RAISE(ABORT, 'INVALID_STOCK'); END;
      CREATE UNIQUE INDEX unique_active_entry_code ON spin_logs(UPPER(entry_code)) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(MIGRATION_VERSION);
  }).immediate();
}

module.exports = { migrateLottery, isLotteryReady, RULE_VERSION, PRIZE_CODES };
