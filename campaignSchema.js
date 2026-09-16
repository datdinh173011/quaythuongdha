const { migrateLottery } = require('./lotterySchema');

const MIGRATION_VERSION = 'bank-details-v1';
const PRIZE_TOTALS = { MAYMAN1: 650, MAYMAN2: 900 };

function isCampaignReady(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    && !!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(MIGRATION_VERSION);
}

function migrateCampaign(db) {
  db.transaction(() => {
    migrateLottery(db);
    if (isCampaignReady(db)) return;
    const { validatePrizeConfiguration } = require('./lottery');
    const prizes = validatePrizeConfiguration(db);
    for (const [code, total] of Object.entries(PRIZE_TOTALS)) {
      const prize = prizes.get(code);
      if (prize.used_quantity + prize.reserved_quantity > total) {
        throw new Error(`STOCK_RECONCILIATION_REQUIRED: ${code} đã dùng/giữ chỗ vượt ${total}. Không thay đổi dữ liệu.`);
      }
    }
    const updateTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'protect_spin_update'").get();
    const voidTrigger = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'protect_spin_void_transition'").get();
    if (!updateTrigger || !voidTrigger) throw new Error('MISSING_LOTTERY_PROTECTION');
    const columns = db.prepare('PRAGMA table_info(spin_logs)').all().map(column => column.name);
    for (const name of ['bank_code', 'bank_name', 'bank_account_number', 'bank_account_holder_name']) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE spin_logs ADD COLUMN ${name} TEXT`);
    }
    db.exec('DROP TRIGGER protect_spin_update; DROP TRIGGER protect_spin_void_transition;');
    if (columns.includes('owner_name')) db.exec('ALTER TABLE spin_logs DROP COLUMN owner_name');
    db.exec(`UPDATE spin_logs SET record_version = record_version + 1, is_synced = 0, synced_at = NULL`);
    db.exec(updateTrigger.sql.replace('owner_name', 'bank_code, bank_name, bank_account_number, bank_account_holder_name'));
    db.exec(voidTrigger.sql);
    const updateStock = db.prepare('UPDATE prizes SET total_quantity = ?, remaining_quantity = ? - used_quantity WHERE code = ?');
    for (const [code, total] of Object.entries(PRIZE_TOTALS)) updateStock.run(total, total, code);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(MIGRATION_VERSION);
  }).immediate();
}

module.exports = { migrateCampaign, isCampaignReady, PRIZE_TOTALS };
