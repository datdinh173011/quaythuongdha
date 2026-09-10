const db = require('./database');

async function syncToGoogleSheet() {
  try {
    const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('google_sheet_webhook_url');
    const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL || (setting ? setting.value : '');

    if (!webhookUrl || !webhookUrl.trim()) {
      // Webhook chưa được cấu hình
      return { success: false, message: 'Google Sheet Webhook URL chưa được cấu hình trong Cài Đặt Admin hoặc file .env' };
    }

    const unsyncedLogs = db.prepare(`
      SELECT * FROM spin_logs 
      WHERE is_synced = 0 
      ORDER BY id ASC 
      LIMIT 100
    `).all();

    if (!unsyncedLogs || unsyncedLogs.length === 0) {
      return { success: true, count: 0, message: 'Không có lượt quay mới nào cần đồng bộ.' };
    }

    console.log(`[GoogleSheetSync] Bắt đầu đồng bộ ${unsyncedLogs.length} lượt quay lên Google Sheet...`);

    // Gửi POST request tới Webhook URL (Google Apps Script Webhook)
    const response = await fetch(webhookUrl.trim(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action: 'sync_spins',
        data: unsyncedLogs
      })
    });

    if (!response.ok) {
      throw new Error(`Google Webhook trả về lỗi HTTP status ${response.status}`);
    }

    const resJson = await response.json().catch(() => ({ status: 'success' }));

    // Cập nhật trạng thái đã đồng bộ trong SQLite
    const ids = unsyncedLogs.map(l => l.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      UPDATE spin_logs 
      SET is_synced = 1, synced_at = CURRENT_TIMESTAMP 
      WHERE id IN (${placeholders})
    `).run(...ids);

    console.log(`[GoogleSheetSync] Đã đồng bộ thành công ${ids.length} lượt quay lên Google Sheet!`);
    return { success: true, count: ids.length, message: `Đã đồng bộ thành công ${ids.length} lượt quay.` };
  } catch (error) {
    console.error('[GoogleSheetSync Error]:', error.message);
    return { success: false, error: error.message };
  }
}

// Bắt đầu background worker chạy mỗi 2 phút (120,000 ms)
function startSyncWorker() {
  const INTERVAL_MS = 2 * 60 * 1000; // 2 phút
  console.log('[GoogleSheetSync] Khởi chạy worker tự động đồng bộ Google Sheet mỗi 2 phút/lần.');
  
  // Chạy lần đầu sau 15 giây khởi động server
  setTimeout(() => {
    syncToGoogleSheet();
  }, 15000);

  setInterval(() => {
    syncToGoogleSheet();
  }, INTERVAL_MS);
}

module.exports = {
  syncToGoogleSheet,
  startSyncWorker
};