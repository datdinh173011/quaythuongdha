const { randomInt } = require('node:crypto');
const { RULE_VERSION, PRIZE_CODES } = require('./lotterySchema');

const SCHEDULE = [
  null, 'MAYMAN2', 'MAYMAN2', 'MAYMAN1', 'MAYMAN1', 'CAOLON', 'MAYMAN1', 'MAYMAN1',
  'BA', 'CAOLON', 'MAYMAN2', 'MAYMAN2', 'MAYMAN1', 'CAOLON', 'MAYMAN2', 'MAYMAN1',
  'MAYMAN1', 'CAOLON', 'MAYMAN1', 'MAYMAN2', 'MAYMAN1', 'CAOLON', 'MAYMAN1',
  'MAYMAN2', 'MAYMAN1', 'MAYMAN1', 'MAYMAN1', 'MAYMAN2', 'MAYMAN1', 'CAOLON', 'MAYMAN1',
];

class LotteryError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function normalizePhone(value) {
  if (typeof value !== 'string') throw new LotteryError('INVALID_PHONE', 'Số điện thoại không hợp lệ.');
  let phone = value.replace(/[\s.()\-]/g, '');
  if (phone.startsWith('+84')) phone = '0' + phone.slice(3);
  else if (phone.startsWith('84')) phone = '0' + phone.slice(2);
  if (!/^0[1-9][0-9]{8,9}$/.test(phone)) throw new LotteryError('INVALID_PHONE', 'Vui lòng nhập số điện thoại Việt Nam hợp lệ.');
  return phone;
}

function validatePrizeConfiguration(db) {
  const prizes = new Map();
  for (const code of PRIZE_CODES) {
    const prize = db.prepare('SELECT * FROM prizes WHERE code = ?').get(code);
    if (!prize) throw new LotteryError('PRIZE_NOT_CONFIGURED', `Thiếu cấu hình quà ${code}.`, 409);
    if (![prize.total_quantity, prize.remaining_quantity, prize.used_quantity, prize.reserved_quantity].every(Number.isSafeInteger)
      || prize.reserved_quantity < 0 || prize.remaining_quantity < prize.reserved_quantity
      || prize.used_quantity < 0 || prize.total_quantity !== prize.remaining_quantity + prize.used_quantity) {
      throw new LotteryError('INVALID_STOCK', `Cần đối soát tồn kho ${code}.`, 409);
    }
    prizes.set(code, prize);
  }
  return prizes;
}

function assertNoReservations(db) {
  const reservedPrize = db.prepare('SELECT id FROM prizes WHERE reserved_quantity != 0 LIMIT 1').get();
  const hasGroups = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reward_groups'").get();
  const reservedGroup = hasGroups && db.prepare('SELECT id FROM reward_groups WHERE gold_reserved != 0 LIMIT 1').get();
  if (reservedPrize || reservedGroup) {
    throw new LotteryError('LEGACY_RECONCILIATION_REQUIRED', 'Còn vàng giữ chỗ từ luật cũ. Cần đối soát trước khi chuyển sang phone-v3.', 409);
  }
}

function milestoneCounts(db, milestone) {
  if (milestone === 14) {
    return db.prepare(`SELECT COUNT(*) AS eligible_count,
      COALESCE(SUM(CASE WHEN prize_code = 'NHI' THEN 1 ELSE 0 END), 0) AS gold_count
      FROM spin_logs WHERE spin_number = 14 AND status = 'active'`).get();
  }
  return db.prepare(`SELECT COUNT(*) AS eligible_count,
    COALESCE(SUM(CASE WHEN later.prize_code = 'NHAT' THEN 1 ELSE 0 END), 0) AS gold_count
    FROM spin_logs later JOIN spin_logs earlier
      ON earlier.normalized_phone = later.normalized_phone
      AND earlier.spin_number = 14 AND earlier.status = 'active' AND earlier.prize_code = 'MAYMAN2'
    WHERE later.spin_number = 25 AND later.status = 'active'`).get();
}

function undoEligibility(db, log) {
  if (!log) return { canUndo: false, undoReason: 'SPIN_NOT_FOUND' };
  if (log.status === 'void') return { canUndo: false, undoReason: 'SPIN_ALREADY_VOID' };
  const later = db.prepare(`SELECT id FROM spin_logs WHERE normalized_phone = ?
    AND status = 'active' AND spin_number > ? LIMIT 1`).get(log.normalized_phone, log.spin_number);
  return later ? { canUndo: false, undoReason: 'NOT_LATEST_SPIN' } : { canUndo: true, undoReason: null };
}

function createLottery(db, drawInteger = randomInt) {
  function decidePrize(phone, spinNumber, prizes) {
    const position = ((spinNumber - 1) % 30) + 1;
    const decision = { prizeCode: position === 8 && spinNumber !== 8 ? 'MAYMAN1' : SCHEDULE[position],
      reason: position === 8 && spinNumber !== 8 ? 'REPEATED_500K_CASH' : 'SCHEDULE', countA: null, countB: null };
    const previousAwards = db.prepare(`SELECT prize_code FROM spin_logs
      WHERE normalized_phone = ? AND status = 'active' AND prize_code IN ('BA', 'NHI', 'NHAT')`).all(phone);
    if (decision.prizeCode === 'BA' && previousAwards.some(award => award.prize_code === 'BA')) {
      decision.prizeCode = 'MAYMAN1';
      decision.reason = 'CASH_500K_ALREADY_WON';
    }
    if (spinNumber !== 14 && spinNumber !== 25) return decision;
    const counts = milestoneCounts(db, spinNumber);
    decision.countA = counts.eligible_count;
    decision.countB = counts.gold_count;
    if (previousAwards.some(award => award.prize_code === 'NHI' || award.prize_code === 'NHAT')) {
      decision.reason = 'GOLD_ALREADY_WON';
      return decision;
    }
    if (spinNumber === 25) {
      const earlier = db.prepare(`SELECT prize_code FROM spin_logs WHERE normalized_phone = ?
        AND spin_number = 14 AND status = 'active'`).get(phone);
      if (!earlier || earlier.prize_code !== 'MAYMAN2') {
        decision.reason = earlier?.prize_code === 'NHI' ? 'GOLD_ALREADY_WON' : 'MILESTONE_14_INELIGIBLE';
        return decision;
      }
    }
    const goldCode = spinNumber === 14 ? 'NHI' : 'NHAT';
    if (prizes.get(goldCode).remaining_quantity === 0) {
      decision.reason = 'GOLD_OUT_OF_STOCK_CASH';
      return decision;
    }
    const multiplier = spinNumber === 14 ? 4 : 3;
    if (!(decision.countA < decision.countB * multiplier)) {
      decision.reason = 'FORMULA_FALSE_CASH';
      return decision;
    }
    const winsGold = spinNumber === 14 ? drawInteger(0, 4) === 0 : drawInteger(0, 10000) < 3333;
    decision.prizeCode = winsGold ? goldCode : decision.prizeCode;
    decision.reason = winsGold ? 'RANDOM_GOLD' : 'RANDOM_CASH';
    return decision;
  }

  const spinTransaction = db.transaction(input => {
    if (!input || ['agencyCode', 'ownerName', 'phone', 'entryCode', 'address'].some(key => typeof input[key] !== 'string' || !input[key].trim())) {
      throw new LotteryError('MISSING_FIELDS', 'Vui lòng điền đầy đủ thông tin và chọn đại lý.');
    }
    const phone = normalizePhone(input.phone);
    const entryCode = input.entryCode.trim().toUpperCase();
    const luckyCode = db.prepare('SELECT * FROM lucky_codes WHERE UPPER(code) = ?').get(entryCode);
    if (!luckyCode) throw new LotteryError('INVALID_CODE', 'Mã dự thưởng không hợp lệ.');
    if (luckyCode.status !== 'unused' || db.prepare("SELECT id FROM spin_logs WHERE UPPER(entry_code) = ? AND status = 'active'").get(entryCode)) {
      throw new LotteryError('ALREADY_USED', 'Mã dự thưởng đã được sử dụng. Vui lòng tra cứu lịch sử.');
    }
    const agency = db.prepare('SELECT * FROM agencies WHERE code = ?').get(input.agencyCode.trim());
    if (!agency) throw new LotteryError('INVALID_AGENCY', 'Đại lý không tồn tại.');
    const participant = db.prepare('SELECT spin_count FROM phone_participants WHERE phone = ?').get(phone);
    const spinNumber = (participant ? participant.spin_count : 0) + 1;
    if (!Number.isSafeInteger(spinNumber)) throw new LotteryError('INVALID_SPIN_NUMBER', 'Số lượt vượt miền số nguyên hỗ trợ.', 409);
    const cycleNumber = Math.floor((spinNumber - 1) / 30) + 1;
    const positionInCycle = ((spinNumber - 1) % 30) + 1;
    const prizes = validatePrizeConfiguration(db);
    assertNoReservations(db);
    const decision = decidePrize(phone, spinNumber, prizes);
    const prize = prizes.get(decision.prizeCode);
    const stockChange = db.prepare(`UPDATE prizes SET remaining_quantity = remaining_quantity - 1,
      used_quantity = used_quantity + 1 WHERE id = ? AND remaining_quantity > 0 AND reserved_quantity = 0`).run(prize.id);
    if (stockChange.changes !== 1) throw new LotteryError('OUT_OF_STOCK', 'Quà của lượt này đã hết. Mã chưa sử dụng.', 409);
    db.prepare(`INSERT INTO phone_participants (phone, spin_count) VALUES (?, ?)
      ON CONFLICT(phone) DO UPDATE SET spin_count = excluded.spin_count`).run(phone, spinNumber);
    const inserted = db.prepare(`INSERT INTO spin_logs
      (spin_time, agency_code, agency_name, province, owner_name, phone, address, entry_code, serial_number,
       prize_id, prize_tier, prize_name, prize_image, normalized_phone, spin_number, prize_code,
       rule_version, decision_reason, cycle_number, position_in_cycle, decision_a, decision_b, is_synced)
      VALUES (datetime('now', 'localtime'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(agency.code, agency.name, agency.province, input.ownerName.trim(), phone, agency.address, entryCode,
        luckyCode.serial_number || '', prize.id, prize.prize_tier, prize.name, prize.image_url, phone,
        spinNumber, prize.code, RULE_VERSION, decision.reason, cycleNumber, positionInCycle, decision.countA, decision.countB);
    const consumed = db.prepare(`UPDATE lucky_codes SET status = 'used', used_at = datetime('now', 'localtime'),
      spin_log_id = ? WHERE id = ? AND status = 'unused'`).run(inserted.lastInsertRowid, luckyCode.id);
    if (consumed.changes !== 1) throw new LotteryError('ALREADY_USED', 'Mã dự thưởng đã được sử dụng.');
    return { success: true, prize: { id: prize.id, tier: prize.prize_tier, name: prize.name, image_url: prize.image_url },
      entryCode, serialNumber: luckyCode.serial_number || '', agencyName: agency.name,
      spinTime: new Date().toLocaleString('vi-VN'), spinNumber, cycleNumber, positionInCycle };
  });

  const undoTransaction = db.transaction((id, actor) => {
    const log = db.prepare('SELECT * FROM spin_logs WHERE id = ?').get(id);
    const eligibility = undoEligibility(db, log);
    if (!eligibility.canUndo) {
      throw new LotteryError(eligibility.undoReason, 'Chỉ được hủy lượt chưa hủy mới nhất của SĐT trên toàn chương trình.', log ? 409 : 404);
    }
    const restored = db.prepare(`UPDATE prizes SET remaining_quantity = remaining_quantity + 1, used_quantity = used_quantity - 1
      WHERE id = ? AND code = ? AND used_quantity > 0`).run(log.prize_id, log.prize_code);
    if (restored.changes !== 1) throw new LotteryError('INVALID_STOCK', 'Không thể hoàn kho; cần đối soát quà đã phát.', 409);
    const released = db.prepare(`UPDATE lucky_codes SET status = 'unused', used_at = NULL, spin_log_id = NULL
      WHERE UPPER(code) = ? AND status = 'used' AND spin_log_id = ?`).run(log.entry_code.toUpperCase(), log.id);
    if (released.changes !== 1) throw new LotteryError('CODE_STATE_CONFLICT', 'Mã không còn gắn với lượt cần hủy.', 409);
    const participant = db.prepare(`UPDATE phone_participants SET spin_count = spin_count - 1
      WHERE phone = ? AND spin_count = ?`).run(log.normalized_phone, log.spin_number);
    if (participant.changes !== 1) throw new LotteryError('SPIN_STATE_CONFLICT', 'Bộ đếm SĐT không khớp lượt cần hủy.', 409);
    db.prepare(`UPDATE spin_logs SET status = 'void', voided_at = datetime('now', 'localtime'), voided_by = ?,
      record_version = record_version + 1, is_synced = 0, synced_at = NULL WHERE id = ?`).run(actor, log.id);
    return { success: true, spinId: log.id, status: 'void', nextSpinNumber: log.spin_number,
      message: 'Đã hủy lượt, hoàn quà và mã. Quay lại sẽ xét thưởng theo dữ liệu hiện tại.' };
  });

  return { spin: input => spinTransaction.immediate(input), undo: (id, actor = 'admin') => undoTransaction.immediate(id, actor) };
}

module.exports = { createLottery, normalizePhone, validatePrizeConfiguration, LotteryError, SCHEDULE, milestoneCounts, undoEligibility };
