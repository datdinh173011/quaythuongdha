const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');
const { Script, createContext } = require('node:vm');
const Database = require('better-sqlite3');
const { createLottery, validatePrizeConfiguration, normalizePhone, milestoneCounts, undoEligibility, SCHEDULE } = require('../lottery');
const { migrateCampaign: migrateLottery } = require('../campaignSchema');

if (!isMainThread) {
  const db = new Database(workerData.dbPath);
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  const engine = createLottery(db, () => 0);
  parentPort.once('message', () => {
    try {
      parentPort.postMessage({ result: workerData.action === 'undo' ? engine.undo(workerData.id) : engine.spin(workerData.input) });
    } catch (error) {
      parentPort.postMessage({ error: error.code || error.message });
    } finally {
      db.close();
      parentPort.close();
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dha-phone-v3-'));
  const oldBankCatalog = process.env.BANK_CATALOG_PATH;
  process.env.BANK_CATALOG_PATH = path.join(directory, 'test-banks.json');
  fs.writeFileSync(process.env.BANK_CATALOG_PATH, JSON.stringify([{ code: 'TEST', name: 'Ngân hàng kiểm thử' }]));
  process.env.DATABASE_PATH = path.join(directory, 'api.db');
  const db = require('../database');
  const openDatabases = new Set([db]);
  const { createSheetSync } = require('../syncWorker');
  const oldWebhook = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  process.env.GOOGLE_SHEET_WEBHOOK_URL = 'https://example.invalid/test-only';
  let checks = 0;
  let sequence = 0;
  const phoneFor = number => `09${String(number).padStart(8, '0')}`;
  const expected = [null, 'MAYMAN2', 'MAYMAN2', 'MAYMAN1', 'MAYMAN1', 'CAOLON', 'MAYMAN1', 'MAYMAN1',
    'BA', 'CAOLON', 'MAYMAN2', 'MAYMAN2', 'MAYMAN1', 'CAOLON', 'MAYMAN2', 'MAYMAN1', 'MAYMAN1',
    'CAOLON', 'MAYMAN1', 'MAYMAN2', 'MAYMAN1', 'CAOLON', 'MAYMAN1', 'MAYMAN2', 'MAYMAN1',
    'MAYMAN1', 'MAYMAN1', 'MAYMAN2', 'MAYMAN1', 'CAOLON', 'MAYMAN1'];
  function input(database, phone = phoneFor(1), agencyCode = 'DL001') {
    const entryCode = `VERIFY${++sequence}`;
    database.prepare("INSERT INTO lucky_codes (code, status) VALUES (?, 'unused')").run(entryCode);
    return { phone, agencyCode, entryCode, bankName: 'Ngân hàng kiểm thử', bankAccountNumber: '00123456789',
      bankAccountHolderName: 'Nguyễn Văn Kiểm Thử', address: 'ignored snapshot', province: 'ignored', agencyName: 'ignored' };
  }
  function advance(database, engine, phone, target) {
    let current = database.prepare('SELECT spin_count FROM phone_participants WHERE phone = ?').get(phone)?.spin_count || 0;
    while (current < target) { engine.spin(input(database, phone)); current++; }
    return latest(database, phone);
  }
  function latest(database, phone = phoneFor(1)) {
    return database.prepare("SELECT * FROM spin_logs WHERE normalized_phone = ? AND status = 'active' ORDER BY spin_number DESC LIMIT 1").get(phone);
  }
  function snapshot(database) {
    return JSON.stringify(['prizes', 'lucky_codes', 'spin_logs', 'phone_participants', 'sqlite_sequence'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  }
  function rollback(database, operation, code) {
    const before = snapshot(database);
    assert.throws(operation, error => error.code === code || error.message === code);
    assert.equal(snapshot(database), before);
  }
  function close(database) { database.close(); openDatabases.delete(database); }
  async function check(name, operation) { await operation(); checks++; console.log(`PASS ${name}`); }
  function seedMilestone(database, phone, milestone, prizeCode) {
    const prize = database.prepare('SELECT * FROM prizes WHERE code = ?').get(prizeCode);
    const entry = input(database, phone);
    database.prepare('UPDATE prizes SET remaining_quantity = remaining_quantity - 1, used_quantity = used_quantity + 1 WHERE id = ?').run(prize.id);
    const result = database.prepare(`INSERT INTO spin_logs (normalized_phone, phone, spin_number, prize_id, prize_code,
      prize_name, rule_version, entry_code, agency_code, cycle_number, position_in_cycle)
      VALUES (?, ?, ?, ?, ?, ?, 'phone-v3', ?, 'DL001', 1, ?)`)
      .run(phone, phone, milestone, prize.id, prize.code, prize.name, entry.entryCode, milestone);
    database.prepare("UPDATE lucky_codes SET status = 'used', spin_log_id = ? WHERE code = ?").run(result.lastInsertRowid, entry.entryCode);
    database.prepare(`INSERT INTO phone_participants VALUES (?, ?) ON CONFLICT(phone)
      DO UPDATE SET spin_count = MAX(spin_count, excluded.spin_count)`).run(phone, milestone);
  }
  try {
    db.exec('UPDATE prizes SET remaining_quantity = 10000, total_quantity = 10000, used_quantity = 0');
    db.pragma('journal_mode = DELETE');
    const template = db.serialize();
    db.pragma('journal_mode = WAL');
    function fixture() {
      const database = new Database(template);
      openDatabases.add(database);
      database.pragma('foreign_keys = ON');
      return database;
    }

    await check('Ngân hàng: bắt buộc, danh mục, giữ số 0/tên có dấu và khóa ảnh chụp', () => {
      const database = fixture();
      const engine = createLottery(database);
      const entry = input(database);
      for (const field of ['bankName', 'bankAccountNumber', 'bankAccountHolderName']) {
        for (const value of [undefined, '', '  ', null, 123]) {
          rollback(database, () => engine.spin({ ...entry, [field]: value }), 'MISSING_FIELDS');
        }
      }
      rollback(database, () => engine.spin({ ...entry, bankName: 'Không trong danh mục' }), 'INVALID_BANK');
      rollback(database, () => engine.spin({ ...entry, bankName: 'TEST' }), 'INVALID_BANK');
      rollback(database, () => engine.spin({ ...entry, bankAccountNumber: '1'.repeat(101) }), 'INVALID_BANK_DETAILS');
      rollback(database, () => engine.spin({ ...entry, bankAccountHolderName: 'a\nb' }), 'INVALID_BANK_DETAILS');
      engine.spin({ ...entry, bankAccountHolderName: '  Nguyễn Thị Ánh  ', bankAccountNumber: '  00123456789  ' });
      const log = latest(database);
      assert.equal(log.bank_code, 'TEST');
      assert.equal(log.bank_name, entry.bankName);
      assert.equal(log.bank_account_number, '00123456789');
      assert.equal(log.bank_account_holder_name, 'Nguyễn Thị Ánh');
      assert.equal(Object.hasOwn(log, 'owner_name'), false);
      for (const column of ['bank_code', 'bank_name', 'bank_account_number', 'bank_account_holder_name']) {
        rollback(database, () => database.prepare(`UPDATE spin_logs SET ${column} = ? WHERE id = ?`).run('changed', log.id), 'SPIN_LOCKED');
      }
      close(database);
    });

    await check('Danh mục thiếu/trống/sai/trùng chặn quay và không tiêu thụ mã', () => {
      const { loadBanks } = require('../bankCatalog');
      const database = fixture();
      const engine = createLottery(database);
      const entry = input(database);
      const original = fs.readFileSync(process.env.BANK_CATALOG_PATH, 'utf8');
      try {
        for (const content of ['[]', '{}', 'invalid-json', '[{"code":"test","name":"Test"}]',
          '[{"code":"TEST","name":"Test"},{"code":"TEST","name":"Other"}]',
          '[{"code":"ONE","name":"Test"},{"code":"TWO","name":"Test"}]']) {
          fs.writeFileSync(process.env.BANK_CATALOG_PATH, content);
          rollback(database, () => engine.spin(entry), 'BANK_CATALOG_UNAVAILABLE');
          if (content !== '[]') assert.throws(loadBanks);
        }
        process.env.BANK_CATALOG_PATH += '.missing';
        rollback(database, () => engine.spin(entry), 'BANK_CATALOG_UNAVAILABLE');
      } finally {
        process.env.BANK_CATALOG_PATH = path.join(directory, 'test-banks.json');
        fs.writeFileSync(process.env.BANK_CATALOG_PATH, original);
      }
      assert.equal(engine.spin(entry).success, true);
      close(database);
    });

    await check('SĐT chuẩn hóa; đổi đại lý; cùng đại lý không gộp lượt', () => {
      const database = fixture();
      const engine = createLottery(database);
      assert.equal(normalizePhone('+84 900-000.001'), phoneFor(1));
      assert.equal(normalizePhone('84900000001'), phoneFor(1));
      for (const invalid of [null, 123, 'abc', '0000000000']) assert.throws(() => normalizePhone(invalid), { code: 'INVALID_PHONE' });
      engine.spin(input(database));
      const changed = engine.spin(input(database, '+84900000001', 'DL002'));
      assert.equal(changed.spinNumber, 2);
      assert.equal(latest(database).agency_code, 'DL002');
      assert.equal(engine.spin(input(database, phoneFor(2))).spinNumber, 1);
      const invalid = { ...input(database), agencyCode: 'NO' };
      rollback(database, () => engine.spin(invalid), 'INVALID_AGENCY');
      close(database);
    });
    await check('Lịch 1–90; b=0 không vàng; không giới hạn 30', () => {
      const database = fixture();
      const engine = createLottery(database, () => { throw new Error('Không được random khi b=0'); });
      assert.deepEqual(SCHEDULE, expected);
      for (let count = 1; count <= 90; count++) {
        const result = engine.spin(input(database));
        const position = ((count - 1) % 30) + 1;
        assert.equal(result.spinNumber, count);
        assert.equal(result.cycleNumber, Math.floor((count - 1) / 30) + 1);
        assert.equal(result.positionInCycle, position);
        assert.equal(latest(database).prize_code, position === 8 && count > 8 ? 'MAYMAN1' : expected[position]);
      }
      advance(database, engine, phoneFor(2), 25);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM spin_logs WHERE prize_code IN ('NHI','NHAT')").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM spin_logs WHERE normalized_phone = ? AND prize_code = 'BA'").get(phoneFor(1)).count, 1);
      close(database);
    });
    for (const milestone of [14, 25]) {
      const multiplier = milestone === 14 ? 4 : 3;
      for (const countA of [multiplier - 1, multiplier, multiplier + 1]) {
        for (const randomValue of milestone === 14 ? [0, 1, 3] : [0, 3332, 3333, 9999]) {
          await check(`Công thức mốc ${milestone}: a=${countA}, b=1, random=${randomValue}`, () => {
            const database = fixture();
            for (let participant = 1; participant <= countA; participant++) {
              const phone = phoneFor(100 + participant);
              if (milestone === 25) seedMilestone(database, phone, 14, 'MAYMAN2');
              seedMilestone(database, phone, milestone, participant === 1 ? (milestone === 14 ? 'NHI' : 'NHAT') : (milestone === 14 ? 'MAYMAN2' : 'MAYMAN1'));
            }
            database.prepare('INSERT INTO phone_participants VALUES (?, ?)').run(phoneFor(1), milestone - 1);
            if (milestone === 25) seedMilestone(database, phoneFor(1), 14, 'MAYMAN2');
            let calls = 0;
            const engine = createLottery(database, (minimum, maximum) => {
              calls++;
              assert.equal(minimum, 0);
              assert.equal(maximum, milestone === 14 ? 4 : 10000);
              return randomValue;
            });
            engine.spin(input(database));
            const log = latest(database);
            const allowed = countA < multiplier;
            const won = allowed && (milestone === 14 ? randomValue === 0 : randomValue < 3333);
            assert.equal(calls, allowed ? 1 : 0);
            assert.equal(log.decision_a, countA);
            assert.equal(log.decision_b, 1);
            assert.equal(log.prize_code, won ? (milestone === 14 ? 'NHI' : 'NHAT') : (milestone === 14 ? 'MAYMAN2' : 'MAYMAN1'));
            close(database);
          });
        }
      }
    }
    await check('Mốc 25 loại SĐT đã vàng/thiếu mốc 14; vàng hết chuyển tiền', () => {
      for (const previous of ['NHI', null, 'MAYMAN2']) {
        const database = fixture();
        seedMilestone(database, phoneFor(99), 14, 'MAYMAN2');
        seedMilestone(database, phoneFor(99), 25, 'NHAT');
        if (previous) seedMilestone(database, phoneFor(1), 14, previous);
        database.prepare('INSERT INTO phone_participants VALUES (?, 24) ON CONFLICT(phone) DO UPDATE SET spin_count = 24').run(phoneFor(1));
        database.prepare("UPDATE prizes SET remaining_quantity = 0, total_quantity = used_quantity WHERE code = 'NHAT'").run();
        createLottery(database, () => { throw new Error('Không được random'); }).spin(input(database));
        assert.equal(latest(database).prize_code, 'MAYMAN1');
        close(database);
      }
      const database = fixture();
      seedMilestone(database, phoneFor(99), 14, 'NHI');
      database.prepare('INSERT INTO phone_participants VALUES (?, 13)').run(phoneFor(1));
      database.prepare("UPDATE prizes SET remaining_quantity = 0, total_quantity = used_quantity WHERE code = 'NHI'").run();
      const engine = createLottery(database, () => { throw new Error('Không được random'); });
      const entry = input(database);
      database.prepare("UPDATE prizes SET remaining_quantity = 0, total_quantity = used_quantity WHERE code = 'MAYMAN2'").run();
      rollback(database, () => engine.spin(entry), 'OUT_OF_STOCK');
      database.prepare("UPDATE prizes SET remaining_quantity = 10, total_quantity = used_quantity + 10 WHERE code = 'MAYMAN2'").run();
      engine.spin(entry);
      assert.equal(latest(database).decision_reason, 'GOLD_OUT_OF_STOCK_CASH');
      close(database);
    });
    await check('Hủy từng SĐT, liên tiếp, giữ audit và quay lại mã cũ/mã mới', () => {
      const database = fixture();
      const engine = createLottery(database);
      advance(database, engine, phoneFor(1), 15);
      const last = latest(database);
      const previous = database.prepare('SELECT * FROM spin_logs WHERE spin_number = 14').get();
      advance(database, engine, phoneFor(2), 20);
      const other = JSON.stringify(latest(database, phoneFor(2)));
      rollback(database, () => engine.undo(previous.id), 'NOT_LATEST_SPIN');
      engine.undo(last.id, 'admin');
      rollback(database, () => engine.undo(last.id), 'SPIN_ALREADY_VOID');
      engine.undo(previous.id);
      assert.deepEqual(milestoneCounts(database, 14), { eligible_count: 1, gold_count: 0 });
      assert.equal(JSON.stringify(latest(database, phoneFor(2))), other);
      const replay = engine.spin({ ...input(database), entryCode: previous.entry_code });
      assert.equal(replay.spinNumber, 14);
      assert.notEqual(latest(database).id, previous.id);
      assert.equal(database.prepare('SELECT status FROM spin_logs WHERE id = ?').get(previous.id).status, 'void');
      assert.equal(database.prepare('SELECT record_version FROM spin_logs WHERE id = ?').get(previous.id).record_version, 2);
      engine.undo(latest(database).id);
      assert.equal(engine.spin(input(database)).spinNumber, 14);
      assert.throws(() => database.prepare('DELETE FROM spin_logs WHERE id = ?').run(previous.id), /SPIN_LOCKED/);
      close(database);
    });
    await check('Hủy vàng cập nhật a/b; replay random mới; không sửa kết quả người khác', () => {
      const database = fixture();
      seedMilestone(database, phoneFor(99), 14, 'NHI');
      database.prepare('INSERT INTO phone_participants VALUES (?, 13)').run(phoneFor(1));
      let draw = 0;
      const engine = createLottery(database, () => draw);
      engine.spin(input(database));
      const winner = latest(database);
      const other = JSON.stringify(latest(database, phoneFor(99)));
      assert.equal(winner.prize_code, 'NHI');
      assert.equal(milestoneCounts(database, 14).gold_count, 2);
      engine.undo(winner.id);
      assert.equal(milestoneCounts(database, 14).gold_count, 1);
      draw = 1;
      engine.spin({ ...input(database), entryCode: winner.entry_code });
      assert.equal(latest(database).prize_code, 'MAYMAN2');
      assert.equal(JSON.stringify(latest(database, phoneFor(99))), other);
      close(database);
    });
    await check('Lỗi giữa transaction quay/hủy rollback cả kho mã và audit', () => {
      const database = fixture();
      const engine = createLottery(database);
      const entry = input(database);
      database.exec("CREATE TRIGGER fail_spin BEFORE UPDATE ON lucky_codes WHEN NEW.status = 'used' BEGIN SELECT RAISE(ABORT, 'INJECTED'); END");
      rollback(database, () => engine.spin(entry), 'INJECTED');
      database.exec('DROP TRIGGER fail_spin');
      engine.spin(entry);
      database.exec("CREATE TRIGGER fail_void BEFORE UPDATE OF status ON spin_logs BEGIN SELECT RAISE(ABORT, 'INJECTED'); END");
      rollback(database, () => engine.undo(latest(database).id), 'INJECTED');
      database.exec('DROP TRIGGER fail_void');
      engine.undo(latest(database).id);
      close(database);
    });
    await check('Thiếu cấu hình khác hết kho; hủy mốc 25 và 500k rồi replay', () => {
      const missing = fixture(false);
      missing.exec("DROP TRIGGER protect_rule_prize_delete; DELETE FROM prizes WHERE code = 'NHAT'");
      assert.throws(() => validatePrizeConfiguration(missing), { code: 'PRIZE_NOT_CONFIGURED' });
      close(missing);
      const database = fixture();
      const engine = createLottery(database);
      const award500 = advance(database, engine, phoneFor(1), 8);
      engine.undo(award500.id);
      engine.spin({ ...input(database), entryCode: award500.entry_code });
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM spin_logs WHERE prize_code = 'BA' AND status = 'active'").get().count, 1);
      seedMilestone(database, phoneFor(99), 14, 'MAYMAN2');
      seedMilestone(database, phoneFor(99), 25, 'NHAT');
      assert.equal(milestoneCounts(database, 25).gold_count, 1);
      engine.undo(latest(database, phoneFor(99)).id);
      assert.equal(milestoneCounts(database, 25).gold_count, 0);
      assert.equal(milestoneCounts(database, 25).eligible_count, 0);
      close(database);
    });

    function legacyFixture(file = ':memory:', awards = ['MAYMAN1', 'MAYMAN2', 'MAYMAN1', 'MAYMAN2', 'MAYMAN1', 'MAYMAN2']) {
      const database = new Database(file);
      openDatabases.add(database);
      database.exec(`CREATE TABLE agencies (id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT, province TEXT, address TEXT);
        CREATE TABLE prizes (id INTEGER PRIMARY KEY, code TEXT UNIQUE, prize_tier TEXT, name TEXT, image_url TEXT,
          total_quantity INTEGER, remaining_quantity INTEGER, used_quantity INTEGER);
        CREATE TABLE lucky_codes (id INTEGER PRIMARY KEY, code TEXT UNIQUE, serial_number TEXT, status TEXT, used_at TEXT, spin_log_id INTEGER);
        CREATE TABLE spin_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, spin_time TEXT, agency_code TEXT, agency_name TEXT, province TEXT,
          owner_name TEXT, phone TEXT, address TEXT, entry_code TEXT, serial_number TEXT, prize_id INTEGER,
          prize_tier TEXT, prize_name TEXT, prize_image TEXT, is_synced INTEGER DEFAULT 0, synced_at TEXT);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
      database.prepare("INSERT INTO agencies VALUES (1, 'DL001', 'Old agency', 'Old province', 'Old address')").run();
      for (const prize of db.prepare('SELECT * FROM prizes').all()) database.prepare('INSERT INTO prizes VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(prize.id, prize.code, prize.prize_tier, prize.name, prize.image_url, 10000, 10000, 0);
      for (const [index, code] of awards.entries()) {
        const prize = database.prepare('SELECT * FROM prizes WHERE code = ?').get(code);
        const phone = index % 2 ? '+84' + phoneFor(1).slice(1) : phoneFor(1);
        const log = database.prepare(`INSERT INTO spin_logs (spin_time, phone, entry_code, prize_id, prize_name, prize_tier, is_synced)
          VALUES (?, ?, ?, ?, ?, ?, 1)`).run('2026-09-10 12:00:00', phone, 'OLD' + index, prize.id, prize.name, prize.prize_tier);
        database.prepare("INSERT INTO lucky_codes (code, status, spin_log_id) VALUES (?, 'used', ?)").run('OLD' + index, log.lastInsertRowid);
        database.prepare('UPDATE prizes SET remaining_quantity = remaining_quantity - 1, used_quantity = used_quantity + 1 WHERE id = ?').run(prize.id);
      }
      return database;
    }
    await check('Migration 6 lượt cũ: backup, giữ kho/mã/ID, undo/replay, restart/idempotent', async () => {
      const legacyPath = path.join(directory, 'legacy.db');
      const legacy = legacyFixture(legacyPath);
      legacy.exec('UPDATE spin_logs SET prize_tier = NULL WHERE id < 6');
      const originalLogs = legacy.prepare('SELECT * FROM spin_logs ORDER BY id').all();
      const originalCodes = legacy.prepare('SELECT * FROM lucky_codes ORDER BY id').all();
      const originalStock = legacy.prepare('SELECT id, remaining_quantity, used_quantity, total_quantity FROM prizes ORDER BY id').all();
      close(legacy);
      const blockedStartup = spawnSync(process.execPath, ['-e', "require('./database')"], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: legacyPath }, encoding: 'utf8',
      });
      assert.notEqual(blockedStartup.status, 0);
      assert(blockedStartup.stderr.includes('DATABASE_MIGRATION_REQUIRED'));
      const home = path.join(directory, 'home');
      fs.mkdirSync(home);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = spawnSync(process.execPath, [path.join(__dirname, 'migrate-database.js')], {
          env: { ...process.env, DATABASE_PATH: legacyPath, HOME: home }, encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr);
      }
      const backups = fs.readdirSync(path.join(home, '.quaythuongdha-backups')).sort();
      assert.equal(backups.length, 2);
      const backup = new Database(path.join(home, '.quaythuongdha-backups', backups[0]), { readonly: true });
      assert.deepEqual(backup.prepare('SELECT * FROM spin_logs ORDER BY id').all(), originalLogs);
      backup.close();
      const migrated = new Database(legacyPath);
      openDatabases.add(migrated);
      assert.deepEqual(migrated.prepare('SELECT * FROM lucky_codes ORDER BY id').all(), originalCodes);
      for (const stock of originalStock) {
        const updated = migrated.prepare('SELECT * FROM prizes WHERE id = ?').get(stock.id);
        const total = { MAYMAN1: 650, MAYMAN2: 900 }[updated.code] ?? stock.total_quantity;
        assert.equal(updated.total_quantity, total);
        assert.equal(updated.used_quantity, stock.used_quantity);
        assert.equal(updated.remaining_quantity, total - stock.used_quantity);
      }
      for (const [index, log] of migrated.prepare('SELECT * FROM spin_logs ORDER BY id').all().entries()) {
        for (const [field, value] of Object.entries(originalLogs[index])) {
          if (!['is_synced', 'synced_at', 'owner_name'].includes(field)) assert.equal(log[field], value);
        }
        assert.equal(log.spin_number, index + 1);
        assert.equal(log.rule_version, 'legacy');
        assert.equal(log.record_version, 3);
        assert.equal(log.bank_account_number, null);
        assert.equal(Object.hasOwn(log, 'owner_name'), false);
        assert.equal(log.is_synced, 0);
      }
      assert(!migrated.prepare('PRAGMA table_info(spin_logs)').all().some(column => column.name === 'campaign_id'));
      assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'campaigns'").get().count, 0);
      assert.deepEqual(migrated.prepare('SELECT * FROM phone_participants').all(), [{ phone: phoneFor(1), spin_count: 6 }]);
      const before = snapshot(migrated);
      migrateLottery(migrated);
      assert.equal(snapshot(migrated), before);
      const engine = createLottery(migrated);
      rollback(migrated, () => engine.undo(1), 'NOT_LATEST_SPIN');
      engine.undo(6);
      rollback(migrated, () => engine.undo(6), 'SPIN_ALREADY_VOID');
      engine.undo(5);
      const replay = engine.spin({ ...input(migrated), entryCode: 'OLD4' });
      assert.equal(replay.spinNumber, 5);
      assert.equal(latest(migrated).prize_code, 'CAOLON');
      assert.equal(latest(migrated).rule_version, 'phone-v3');
      assert(latest(migrated).id > 6);
      close(migrated);
      const reopened = new Database(legacyPath);
      openDatabases.add(reopened);
      assert.equal(createLottery(reopened).spin(input(reopened)).spinNumber, 6);
      close(reopened);
    });
    await check('Migration ngân hàng trên phone-v3 giữ active/void; chạy lại không reset kho', () => {
      const database = legacyFixture();
      require('../lotterySchema').migrateLottery(database);
      createLottery(database).undo(6);
      database.exec('UPDATE spin_logs SET is_synced = 1');
      const logs = database.prepare('SELECT * FROM spin_logs ORDER BY id').all();
      const participants = database.prepare('SELECT * FROM phone_participants').all();
      const codes = database.prepare('SELECT * FROM lucky_codes ORDER BY id').all();
      migrateLottery(database);
      for (const previous of logs) {
        const current = database.prepare('SELECT * FROM spin_logs WHERE id = ?').get(previous.id);
        for (const [field, value] of Object.entries(previous)) {
          if (!['owner_name', 'record_version', 'is_synced', 'synced_at'].includes(field)) assert.equal(current[field], value);
        }
        assert.equal(current.record_version, previous.record_version + 1);
        assert.equal(current.is_synced, 0);
        assert.equal(current.bank_name, null);
      }
      assert.deepEqual(database.prepare('SELECT * FROM phone_participants').all(), participants);
      assert.deepEqual(database.prepare('SELECT * FROM lucky_codes ORDER BY id').all(), codes);
      const engine = createLottery(database);
      engine.spin(input(database));
      const state = snapshot(database);
      migrateLottery(database);
      assert.equal(snapshot(database), state);
      engine.undo(latest(database).id);
      close(database);
    });

    await check('Tổng 650/900: từ chối đã phát quá tổng, rollback DDL; cho phép bằng tổng', () => {
      for (const [code, total] of Object.entries({ MAYMAN1: 650, MAYMAN2: 900 })) {
        const database = legacyFixture();
        require('../lotterySchema').migrateLottery(database);
        database.prepare('UPDATE prizes SET used_quantity = ?, remaining_quantity = total_quantity - ? WHERE code = ?')
          .run(total + 1, total + 1, code);
        const before = database.serialize();
        assert.throws(() => migrateLottery(database), /STOCK_RECONCILIATION_REQUIRED/);
        assert.deepEqual(database.serialize(), before);
        database.prepare('UPDATE prizes SET used_quantity = ?, remaining_quantity = total_quantity - ? WHERE code = ?')
          .run(total, total, code);
        migrateLottery(database);
        const prize = database.prepare('SELECT * FROM prizes WHERE code = ?').get(code);
        assert.equal(prize.total_quantity, total);
        assert.equal(prize.used_quantity, total);
        assert.equal(prize.remaining_quantity, 0);
        close(database);
      }
    });

    await check('Migration chặn dữ liệu không an toàn và rollback cả DDL', () => {
      const faults = [
        "UPDATE spin_logs SET phone = 'invalid' WHERE id = 1",
        "UPDATE spin_logs SET spin_time = '2026-02-30 12:00:00' WHERE id = 2",
        "UPDATE spin_logs SET prize_id = 999 WHERE id = 2",
        "UPDATE lucky_codes SET spin_log_id = NULL WHERE code = 'OLD1'",
        "CREATE TABLE campaigns (id INTEGER PRIMARY KEY); INSERT INTO campaigns VALUES (1)",
        "ALTER TABLE prizes ADD COLUMN reserved_quantity INTEGER DEFAULT 0; UPDATE prizes SET reserved_quantity = 1 WHERE code = 'NHI'",
      ];
      for (const fault of faults) {
        const database = legacyFixture();
        database.exec(fault);
        const before = database.serialize();
        assert.throws(() => migrateLottery(database), { code: 'LEGACY_RECONCILIATION_REQUIRED' });
        assert.deepEqual(database.serialize(), before);
        close(database);
      }
      const duplicate = legacyFixture(':memory:', ['NHI', 'NHAT']);
      assert.throws(() => migrateLottery(duplicate), { code: 'LEGACY_RECONCILIATION_REQUIRED' });
      close(duplicate);
    });
    await check('Giới hạn vàng/500k tính cả quà legacy ngoài mốc; a/b tính cả legacy', () => {
      const database = legacyFixture(':memory:', ['NHI', 'BA']);
      migrateLottery(database);
      const engine = createLottery(database, () => { throw new Error('Không random khi đã nhận vàng'); });
      advance(database, engine, phoneFor(1), 8);
      assert.equal(latest(database).prize_code, 'MAYMAN1');
      assert.equal(latest(database).decision_reason, 'CASH_500K_ALREADY_WON');
      advance(database, engine, phoneFor(1), 14);
      assert.equal(latest(database).prize_code, 'MAYMAN2');
      assert.equal(latest(database).decision_reason, 'GOLD_ALREADY_WON');
      advance(database, engine, phoneFor(1), 25);
      assert.equal(latest(database).prize_code, 'MAYMAN1');
      assert.equal(latest(database).decision_reason, 'GOLD_ALREADY_WON');
      close(database);
      const awards = Array(25).fill('MAYMAN2');
      awards[24] = 'NHAT';
      const history = legacyFixture(':memory:', awards);
      migrateLottery(history);
      assert.deepEqual(milestoneCounts(history, 25), { eligible_count: 1, gold_count: 1 });
      createLottery(history).undo(25);
      assert.deepEqual(milestoneCounts(history, 25), { eligible_count: 0, gold_count: 0 });
      close(history);
    });

    await check('Migration đánh số theo thời gian rồi ID, riêng từng SĐT', () => {
      const database = legacyFixture();
      database.prepare('UPDATE spin_logs SET phone = ? WHERE id IN (2, 4)').run(phoneFor(2));
      database.exec("UPDATE spin_logs SET spin_time = '2026-09-09 12:00:00' WHERE id = 6");
      migrateLottery(database);
      const firstPhone = database.prepare('SELECT id, spin_number FROM spin_logs WHERE normalized_phone = ? ORDER BY spin_number').all(phoneFor(1));
      assert.deepEqual(firstPhone, [{ id: 6, spin_number: 1 }, { id: 1, spin_number: 2 }, { id: 3, spin_number: 3 }, { id: 5, spin_number: 4 }]);
      assert.deepEqual(database.prepare('SELECT spin_count FROM phone_participants ORDER BY phone').all(), [{ spin_count: 4 }, { spin_count: 2 }]);
      assert.equal(undoEligibility(database, database.prepare('SELECT * FROM spin_logs WHERE id = 6').get()).canUndo, false);
      const other = database.prepare('SELECT * FROM spin_logs WHERE id = 4').get();
      assert.equal(undoEligibility(database, other).canUndo, true);
      createLottery(database).undo(other.id);
      assert.equal(database.prepare('SELECT spin_count FROM phone_participants WHERE phone = ?').get(phoneFor(1)).spin_count, 4);
      close(database);
    });

    await check('Migration bỏ cấu trúc kỳ rỗng và marker không reset', () => {
      const database = legacyFixture();
      database.pragma('foreign_keys = ON');
      database.exec(`CREATE TABLE campaigns (id INTEGER PRIMARY KEY, code TEXT, status TEXT, rule_version TEXT);
        CREATE TABLE phone_participants (campaign_id INTEGER REFERENCES campaigns(id), phone TEXT, spin_count INTEGER,
          PRIMARY KEY(campaign_id, phone));
        ALTER TABLE spin_logs ADD COLUMN campaign_id INTEGER;
        CREATE INDEX spin_phone_latest ON spin_logs(campaign_id, phone);
        CREATE TRIGGER protect_campaign_spin_delete BEFORE DELETE ON spin_logs
          WHEN OLD.campaign_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'SPIN_LOCKED'); END;`);
      migrateLottery(database);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'campaigns'").get().count, 0);
      assert.deepEqual(database.prepare('PRAGMA table_info(phone_participants)').all().filter(column => column.pk).map(column => column.name), ['phone']);
      assert.deepEqual(database.pragma('foreign_key_check'), []);
      close(database);
    });

    async function parallel(dbPath, operations) {
      const workers = operations.map(operation => new Worker(__filename, { workerData: { dbPath, ...operation } }));
      try {
        await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
          worker.once('error', reject); worker.once('message', message => message.ready ? resolve() : reject(new Error('Not ready')));
        })));
        const results = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
        workers.forEach(worker => worker.postMessage('start'));
        return await Promise.all(results);
      } finally { await Promise.all(workers.map(worker => worker.terminate())); }
    }
    await check('Đồng thời: mã trùng, lượt cùng SĐT, hủy trùng và quay/hủy', async () => {
      const source = fixture();
      const file = path.join(directory, 'concurrent.db');
      await source.backup(file);
      close(source);
      const database = new Database(file);
      openDatabases.add(database);
      database.pragma('journal_mode = WAL');
      const entry = input(database);
      const duplicates = await parallel(file, [{ input: entry }, { input: entry }]);
      assert.equal(duplicates.filter(result => result.result).length, 1);
      assert.equal(duplicates.filter(result => result.error === 'ALREADY_USED').length, 1);
      const samePhone = await parallel(file, [{ input: input(database) }, { input: input(database) }]);
      assert.deepEqual(samePhone.map(result => result.result.spinNumber).sort(), [2, 3]);
      const last = latest(database);
      const undone = await parallel(file, [{ action: 'undo', id: last.id }, { action: 'undo', id: last.id }]);
      assert.equal(undone.filter(result => result.result).length, 1);
      assert.equal(undone.filter(result => result.error === 'SPIN_ALREADY_VOID').length, 1);
      const previous = latest(database);
      await parallel(file, [{ action: 'undo', id: previous.id }, { input: input(database) }]);
      const active = database.prepare("SELECT spin_number FROM spin_logs WHERE status = 'active' ORDER BY spin_number").all().map(row => row.spin_number);
      assert.deepEqual(active, Array.from({ length: active.length }, (_, index) => index + 1));
      assert.equal(database.prepare('SELECT spin_count FROM phone_participants').get().spin_count, active.length);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM prizes WHERE remaining_quantity < 0 OR used_quantity < 0').get().count, 0);
      close(database);
    });

    function sheetHarness() {
      const rows = [];
      const sheet = {
        getLastRow: () => rows.length,
        getDataRange: () => ({ getValues: () => rows.map(row => [...row]) }),
        getRange: (rowNumber, column, height, width) => ({ setNumberFormat: () => {}, clearContent: () => {
          for (let offset = 0; offset < height; offset++) rows[rowNumber - 1 + offset][column - 1] = '';
        }, setValues: values => {
          assert.equal(values.length, height); assert.equal(values[0].length, width);
          rows[rowNumber - 1] ||= [];
          values[0].forEach((value, offset) => { rows[rowNumber - 1][column - 1 + offset] = value; });
        } }),
      };
      const context = createContext({
        LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
        SpreadsheetApp: { getActiveSpreadsheet: () => ({ getActiveSheet: () => sheet }), flush() {} },
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) },
      });
      const source = fs.readFileSync(path.join(__dirname, '..', 'docs', 'google-sheets-sync.gs'), 'utf8');
      new Script(source).runInContext(context);
      return { rows, receive: payload => context.doPost({ postData: { contents: JSON.stringify(payload) } }) };
    }
    await check('Sheets: upsert, hủy/replay, trùng ID/phiên bản, đảo thứ tự và phản hồi lỗi', async () => {
      const database = fixture();
      const engine = createLottery(database);
      const harness = sheetHarness();
      const entry = input(database);
      engine.spin(entry);
      let captured;
      let mode = 'normal';
      const sync = createSheetSync(database, async (url, options) => {
        captured = JSON.parse(options.body);
        const result = harness.receive(captured);
        if (mode === 'undo-inflight') engine.undo(latest(database).id);
        if (mode === 'malformed') return { ok: true, json: async () => { throw new Error('Invalid JSON'); } };
        if (mode === 'error') return { ok: true, json: async () => ({ status: 'error' }) };
        if (mode === 'missing-ack') return { ok: true, json: async () => ({ status: 'success', protocol: 'spin-record-v3', acknowledgements: [] }) };
        return { ok: true, json: async () => result };
      });
      mode = 'undo-inflight';
      assert.equal((await sync()).count, 0);
      const oldPayload = captured;
      assert.equal(database.prepare('SELECT is_synced FROM spin_logs LIMIT 1').get().is_synced, 0);
      mode = 'normal';
      assert.equal((await sync()).count, 1);
      assert.equal(harness.rows[1][17], 'void');
      assert.equal(harness.rows[1][20], 2);
      assert.equal(harness.rows[1][5], entry.bankName);
      assert.equal(harness.rows[1][25], entry.bankAccountNumber);
      assert.equal(harness.rows[1][26], entry.bankAccountHolderName);
      harness.receive(oldPayload);
      assert.equal(harness.rows[1][17], 'void');
      harness.receive(captured);
      assert.equal(harness.rows.length, 2);
      engine.spin(entry);
      for (const failure of ['malformed', 'error', 'missing-ack']) {
        mode = failure;
        assert.equal((await sync()).success, false);
        assert.equal(latest(database).is_synced, 0);
      }
      mode = 'normal';
      assert.equal((await sync()).success, true);
      assert.equal(harness.rows.length, 3);
      assert.equal(harness.rows[2][17], 'active');
      assert.notEqual(harness.rows[1][0], harness.rows[2][0]);
      harness.rows.push([...harness.rows[2]]);
      assert.equal(harness.receive(captured).status, 'error');
      close(database);
    });

    await check('Sheets chuyển tiêu đề cũ, giữ vị trí cột, từ chối tiêu đề tùy biến', () => {
      const database = legacyFixture();
      migrateLottery(database);
      const record = database.prepare('SELECT * FROM spin_logs WHERE id = 1').get();
      const harness = sheetHarness();
      const payload = { action: 'sync_spins', protocol: 'spin-record-v3', data: [record] };
      assert.equal(harness.receive(payload).status, 'success');
      harness.rows[0][5] = 'Chủ Đại Lý';
      harness.rows[1][5] = 'Không được hiểu là ngân hàng';
      assert.equal(harness.receive(payload).status, 'success');
      assert.equal(harness.rows[0][5], 'Tên Ngân Hàng');
      assert.equal(harness.rows[1][5], '');
      assert.equal(harness.receive({ ...payload, protocol: 'spin-record-v2' }).status, 'error');
      harness.rows[0][12] = 'Kỳ Thưởng';
      harness.rows[0][13] = 'Lượt Trong Kỳ';
      harness.rows[1][12] = 'Lịch sử cũ';
      harness.rows[1][13] = '';
      harness.rows[1][20] = 1;
      const prizeName = harness.rows[1][10];
      assert.equal(harness.receive(payload).status, 'success');
      assert.equal(harness.rows[0][12], 'Kỳ Thưởng (Không Sử Dụng)');
      assert.equal(harness.rows[0][13], 'Lượt Tuyệt Đối');
      assert.equal(harness.rows[1][12], '');
      assert.equal(harness.rows[1][13], 1);
      assert.equal(harness.rows[1][14], 'legacy');
      assert.equal(harness.rows[1][10], prizeName);
      assert.equal(harness.rows[1][20], record.record_version);
      assert.equal(harness.rows[1].length, 27);
      harness.rows[0][13] = 'Custom';
      assert.equal(harness.receive(payload).status, 'error');
      close(database);
    });

    await check('API trong bộ nhớ: canUndo toàn lịch sử, bộ lọc, Excel, lịch sử và static', async () => {
      const app = require('../server');
      const token = db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get().value;
      function dispatch(url, method = 'GET', body, admin = false) {
        return new Promise((resolve, reject) => {
          const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
          const request = new IncomingMessage(socket);
          request.method = method; request.url = url;
          request.headers = { host: 'verification.invalid', ...(admin ? { authorization: `Bearer ${token}` } : {}) };
          if (body !== undefined) {
            const data = Buffer.from(JSON.stringify(body));
            request.headers['content-type'] = 'application/json'; request.headers['content-length'] = String(data.length); request.push(data);
          }
          request.push(null);
          const response = new ServerResponse(request);
          response.assignSocket(socket);
          const chunks = [];
          const write = response.write.bind(response); const end = response.end.bind(response);
          response.write = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return write(chunk, ...args); };
          response.end = (chunk, ...args) => { if (chunk) chunks.push(Buffer.from(chunk)); return end(chunk, ...args); };
          response.once('error', reject);
          response.once('finish', () => { resolve({ status: response.statusCode, body: Buffer.concat(chunks) }); socket.destroy(); });
          app.handle(request, response);
        });
      }
      async function request(...args) { const response = await dispatch(...args); return { status: response.status, data: JSON.parse(response.body.toString()) }; }
      assert.deepEqual((await request('/api/banks')).data.banks, [{ code: 'TEST', name: 'Ngân hàng kiểm thử' }]);
      const entry = input(db);
      const firstResponse = (await request('/api/spin', 'POST', entry)).data;
      assert.equal(firstResponse.cycleNumber, 1);
      assert.equal(Object.hasOwn(firstResponse, 'campaignId'), false);
      const first = latest(db);
      const secondEntry = input(db, phoneFor(1), 'DL002');
      await request('/api/spin', 'POST', secondEntry);
      const second = latest(db);
      const filtered = await request(`/api/admin/spins?q=${entry.entryCode}`, 'GET', undefined, true);
      assert.equal(filtered.data.spins[0].canUndo, false);
      assert.equal(filtered.data.spins[0].undoReason, 'NOT_LATEST_SPIN');
      assert.equal(filtered.data.spins[0].bank_account_number, entry.bankAccountNumber);
      assert.equal(filtered.data.spins[0].bank_account_holder_name, entry.bankAccountHolderName);
      assert.equal(Object.hasOwn(filtered.data.spins[0], 'owner_name'), false);
      assert.equal((await request(`/api/admin/spins?q=${encodeURIComponent(entry.bankAccountHolderName)}`, 'GET', undefined, true)).data.spins.length, 2);
      const newestOnly = await request(`/api/admin/spins?q=${secondEntry.entryCode}`, 'GET', undefined, true);
      assert.equal(newestOnly.data.spins[0].canUndo, true);
      assert.equal((await request(`/api/admin/spins/${first.id}`, 'DELETE', undefined, true)).status, 409);
      assert.equal((await request(`/api/admin/spins/${second.id}`, 'DELETE', undefined, true)).data.status, 'void');
      assert.equal((await request('/api/admin/spins?status=void', 'GET', undefined, true)).data.spins.length, 1);
      const history = await request('/api/history?phone=%2B84900000001');
      assert.equal(history.data.count, 1);
      assert.equal(history.data.history[0].position_in_cycle, 1);
      assert.equal(Object.hasOwn(history.data.history[0], 'campaign_id'), false);
      assert.equal(history.data.history[0].bank_name, entry.bankName);
      assert.equal(history.data.history[0].bank_account_number, entry.bankAccountNumber);
      assert.equal(history.data.history[0].bank_account_holder_name, entry.bankAccountHolderName);
      assert.equal((await request('/api/spin', 'POST', secondEntry)).data.spinNumber, 2);
      assert.equal((await request('/api/admin/stats', 'GET', undefined, true)).data.stats.participantCount, 1);
      const prize = db.prepare("SELECT * FROM prizes WHERE code = 'NHAT'").get();
      assert.equal((await request(`/api/admin/prizes/${prize.id}`, 'DELETE', undefined, true)).status, 409);
      const exported = await dispatch('/api/admin/export-spins', 'GET', undefined, true);
      const xlsx = require('xlsx');
      const workbook = xlsx.read(exported.body, { type: 'buffer' });
      const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      assert(rows.some(row => row['Trạng thái'] === 'Đã hủy' && row['Phiên bản bản ghi'] === 2));
      assert.equal(rows[0]['Vòng'], 1);
      assert(rows.some(row => row['Lượt tuyệt đối'] === 1));
      assert(rows.some(row => row['Lượt tuyệt đối'] === 2));
      assert.equal(Object.hasOwn(rows[0], 'Kỳ thưởng'), false);
      assert.equal(rows[0]['Tên ngân hàng'], entry.bankName);
      assert.equal(rows[0]['Số tài khoản ngân hàng'], '00123456789');
      assert.equal(rows[0]['Tên chủ tài khoản ngân hàng'], entry.bankAccountHolderName);
      assert.equal(Object.hasOwn(rows[0], 'Chủ đại lý'), false);
      assert.equal((await request('/api/admin/spins')).status, 401);
      for (const resource of ['/data.db', '/server.js', '/lottery.js', '/docs/google-sheets-sync.gs']) assert.equal((await dispatch(resource)).status, 404);
      for (const resource of ['/', '/main.js', '/style.css', '/admin/', '/admin/admin.js']) assert.equal((await dispatch(resource)).status, 200);
    });
    await check('Tài liệu và mẫu Apps Script khớp giao diện/code', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'docs', 'google-sheets-sync.gs'), 'utf8').trim();
      const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
      assert.equal(html.match(/<pre id="apps-script-code">([\s\S]*?)<\/pre>/)[1].trim(), source);
      for (const filename of ['main.js', 'admin/admin.js', 'server.js', 'lottery.js', 'lotterySchema.js', 'syncWorker.js']) new Script(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'));
      const rules = fs.readFileSync(path.join(__dirname, '..', 'docs', 'luat-quay-thuong.md'), 'utf8');
      assert(rules.includes('a < b * 4') && rules.includes('a < b * 3') && rules.includes('phone-v3'));
      const documented = new Set();
      for (const line of rules.split('\n')) {
        const match = line.match(/^\| ([0-9, ]+) \| .* \| `([A-Z0-9]+)`/);
        if (!match) continue;
        for (const position of match[1].split(',').map(value => Number(value.trim()))) {
          assert(!documented.has(position)); documented.add(position);
          if (position !== 14 && position !== 25) assert.equal(expected[position], match[2]);
        }
      }
      assert.equal(documented.size, 30);
      const schema = fs.readFileSync(path.join(__dirname, '..', 'docs', 'schema.md'), 'utf8');
      const sections = [...schema.matchAll(/^### 2\.\d+\. (\w+)\n([\s\S]*?)(?=^### 2\.|^## 3\.)/gm)];
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(sections.map(section => section[1]).sort(), tables);
      for (const [, table, content] of sections) {
        const fields = [...content.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
        assert.deepEqual(fields.sort(), db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name).sort());
      }
      assert(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').includes('(docs/luat-quay-thuong.md)'));
    });
    console.log(`\n${checks} kịch bản đạt; chỉ dùng database tạm.`);
  } finally {
    for (const database of openDatabases) if (database.open) database.close();
    if (oldWebhook === undefined) delete process.env.GOOGLE_SHEET_WEBHOOK_URL;
    else process.env.GOOGLE_SHEET_WEBHOOK_URL = oldWebhook;
    if (oldBankCatalog === undefined) delete process.env.BANK_CATALOG_PATH;
    else process.env.BANK_CATALOG_PATH = oldBankCatalog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
