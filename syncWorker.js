const db = require('./database');

const INITIAL_SYNC_DELAY_MS = 15000;
const SYNC_INTERVAL_MS = 120000;

function maskWebhookUrl(value) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return '[invalid-url]';
  }
}

function createSheetSync(database, send = (...args) => fetch(...args)) {
  let inFlight;

  async function run() {
    const startedAt = Date.now();
    console.log('[GoogleSheetSync] Checking for unsynced records');
    try {
      const setting = database.prepare('SELECT value FROM settings WHERE key = ?').get('google_sheet_webhook_url');
      const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || setting?.value || '';
      if (!webhookUrl.trim()) {
        const message = 'Google Sheet Webhook URL chưa được cấu hình.';
        console.warn(`[GoogleSheetSync] Failed: ${message}`);
        return { success: false, message };
      }
      const logs = database.prepare('SELECT * FROM spin_logs WHERE is_synced = 0 ORDER BY id ASC LIMIT 100').all();
      if (logs.length === 0) {
        console.log('[GoogleSheetSync] No records to sync');
        return { success: true, count: 0, message: 'Không có thay đổi cần đồng bộ.' };
      }
      console.log(`[GoogleSheetSync] Sending ${logs.length} records to ${maskWebhookUrl(webhookUrl.trim())}`);
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
      console.log(`[GoogleSheetSync] Synced ${count} records successfully`);
      return { success: true, count, message: `Đã đồng bộ ${count} bản ghi đúng phiên bản.` };
    } catch (error) {
      console.error(`[GoogleSheetSync] Failed: ${error.message}`);
      return { success: false, error: error.message, message: error.message };
    } finally {
      console.log(`[GoogleSheetSync] Finished in ${Date.now() - startedAt}ms`);
    }
  }

  return function sync() {
    if (!inFlight) inFlight = run().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

const syncToGoogleSheet = createSheetSync(db);

function startSyncWorker() {
  console.log(`[GoogleSheetSync] Worker started; first run in ${INITIAL_SYNC_DELAY_MS}ms, interval ${SYNC_INTERVAL_MS}ms`);
  setTimeout(syncToGoogleSheet, INITIAL_SYNC_DELAY_MS);
  setInterval(syncToGoogleSheet, SYNC_INTERVAL_MS);
}

module.exports = { createSheetSync, syncToGoogleSheet, startSyncWorker };
