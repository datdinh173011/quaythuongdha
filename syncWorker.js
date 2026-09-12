const db = require('./database');

function createSheetSync(database, send = (...args) => fetch(...args)) {
  let inFlight;

  async function run() {
    try {
      const setting = database.prepare('SELECT value FROM settings WHERE key = ?').get('google_sheet_webhook_url');
      const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || setting?.value || '';
      if (!webhookUrl.trim()) return { success: false, message: 'Google Sheet Webhook URL chưa được cấu hình.' };
      const logs = database.prepare('SELECT * FROM spin_logs WHERE is_synced = 0 ORDER BY id ASC LIMIT 100').all();
      if (logs.length === 0) return { success: true, count: 0, message: 'Không có thay đổi cần đồng bộ.' };
      const response = await send(webhookUrl.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_spins', protocol: 'spin-record-v2', data: logs }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`Google Webhook trả về HTTP ${response.status}`);
      const result = await response.json();
      if (result?.status !== 'success' || result.protocol !== 'spin-record-v2' || !Array.isArray(result.acknowledgements)) {
        throw new Error('Webhook chưa xác nhận đúng giao thức/phiên bản. Cần cập nhật Apps Script.');
      }
      const acknowledged = new Map();
      for (const item of result.acknowledgements) {
        if (!Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.record_version) || acknowledged.has(item.id)) {
          throw new Error('Xác nhận đồng bộ không hợp lệ hoặc trùng ID.');
        }
        acknowledged.set(item.id, item.record_version);
      }
      if (acknowledged.size !== logs.length || logs.some(log => acknowledged.get(log.id) !== log.record_version)) {
        throw new Error('Webhook chưa xác nhận đúng phiên bản của mọi bản ghi đã gửi.');
      }
      const count = database.transaction(() => {
        const mark = database.prepare(`UPDATE spin_logs SET is_synced = 1, synced_at = datetime('now', 'localtime')
          WHERE id = ? AND record_version = ? AND is_synced = 0`);
        return logs.reduce((total, log) => total + mark.run(log.id, log.record_version).changes, 0);
      }).immediate();
      return { success: true, count, message: `Đã đồng bộ ${count} bản ghi đúng phiên bản.` };
    } catch (error) {
      return { success: false, error: error.message, message: error.message };
    }
  }

  return function sync() {
    if (!inFlight) inFlight = run().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

const syncToGoogleSheet = createSheetSync(db);

function startSyncWorker() {
  setTimeout(syncToGoogleSheet, 15000);
  setInterval(syncToGoogleSheet, 120000);
}

module.exports = { createSheetSync, syncToGoogleSheet, startSyncWorker };
