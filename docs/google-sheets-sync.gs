function doPost(request) {
  var lock = LockService.getScriptLock();
  var acquired = false;
  try {
    var payload = JSON.parse(request.postData.contents);
    if (payload.action !== 'sync_spins' || payload.protocol !== 'spin-record-v3' || !Array.isArray(payload.data)) {
      throw new Error('Unsupported sync protocol');
    }
    var seen = {};
    payload.data.forEach(function(record) {
      if (!Number.isSafeInteger(record.id) || record.id < 1 || seen[record.id]
        || !Number.isSafeInteger(record.record_version) || record.record_version < 1
        || ['active', 'void'].indexOf(record.status) === -1) {
        throw new Error('Invalid record identity, version or status');
      }
      seen[record.id] = true;
    });
    acquired = lock.tryLock(10000);
    if (!acquired) throw new Error('Sync busy; retry later');
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var headers = [
      'ID', 'Thời Gian', 'Mã Đại Lý', 'Tên Đại Lý', 'Tỉnh Thành', 'Tên Ngân Hàng',
      'Số Điện Thoại', 'Địa Chỉ', 'Mã Dự Thưởng', 'Số Serial', 'Phần Quà Trúng', 'Thời Gian Đồng Bộ',
      'Kỳ Thưởng (Không Sử Dụng)', 'Lượt Tuyệt Đối', 'Phiên Bản Luật', 'Mã Quà', 'Lý Do Nhận Giải',
      'Trạng Thái', 'Thời Điểm Hủy', 'Người Hủy', 'Phiên Bản Bản Ghi',
      'Vòng', 'Vị Trí Trong Vòng', 'a Trước Lượt', 'b Trước Lượt', 'Số Tài Khoản', 'Tên Chủ Tài Khoản'
    ];
    var existing = sheet.getLastRow() ? sheet.getDataRange().getValues() : [];
    if (existing.length) {
      existing[0].forEach(function(header, index) {
        var legacyHeader = (index === 12 && header === 'Kỳ Thưởng') || (index === 13 && header === 'Lượt Trong Kỳ')
          || (index === 5 && header === 'Chủ Đại Lý');
        if (header !== '' && header !== headers[index] && !legacyHeader) throw new Error('Custom sheet headers require manual migration');
      });
    }
    var rowsById = {};
    for (var rowIndex = 1; rowIndex < existing.length; rowIndex++) {
      var existingId = existing[rowIndex][0];
      if (existingId === '') continue;
      if (rowsById[existingId]) throw new Error('Duplicate sheet IDs require reconciliation');
      rowsById[existingId] = { row: rowIndex + 1, version: Number(existing[rowIndex][20]) || 1 };
    }
    if (existing.length > 1 && existing[0][5] === 'Chủ Đại Lý') {
      sheet.getRange(2, 6, existing.length - 1, 1).clearContent();
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    var acknowledgements = [];
    payload.data.forEach(function(record) {
      var saved = rowsById[record.id];
      if (!saved || record.record_version > saved.version) {
        var values = [
          record.id, record.spin_time, record.agency_code, record.agency_name, record.province,
          record.bank_code || record.bank_name, record.phone, record.address, record.entry_code, record.serial_number,
          record.prize_name, new Date(), '', record.spin_number || '',
          record.rule_version, record.prize_code, record.decision_reason, record.status,
          record.voided_at, record.voided_by, record.record_version, record.cycle_number || '',
          record.position_in_cycle || '', record.decision_a, record.decision_b,
          record.bank_account_number, record.bank_account_holder_name
        ].map(function(value) {
          if (value === null || value === undefined) return '';
          return typeof value === 'string' && /^[=+@-]/.test(value) ? "'" + value : value;
        });
        var destination = saved ? saved.row : sheet.getLastRow() + 1;
        sheet.getRange(destination, 26, 1, 1).setNumberFormat('@');
        sheet.getRange(destination, 1, 1, headers.length).setValues([values]);
        saved = { row: destination, version: record.record_version };
        rowsById[record.id] = saved;
      }
      acknowledgements.push({ id: record.id, record_version: saved.version });
    });
    SpreadsheetApp.flush();
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success', protocol: 'spin-record-v3', acknowledgements: acknowledgements
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', protocol: 'spin-record-v3', message: String(error)
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    if (acquired) lock.releaseLock();
  }
}
