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
      'ID', 'Thời Gian', 'Mã Đại Lý', 'Số Điện Thoại', 'Địa Chỉ', 'Mã Dự Thưởng', 'Mã Quà Trúng', 'Vị Trí Trong Vòng'
    ];
    var existing = sheet.getLastRow() ? sheet.getDataRange().getValues() : [];
    if (existing.length) {
      existing[0].forEach(function(header, index) {
        var legacyHeader = index < headers.length && ['ID', 'Thời Gian', 'Mã Đại Lý', 'Tên Đại Lý', 'Tỉnh Thành', 'Tên Ngân Hàng', 'Số Điện Thoại', 'Địa Chỉ', 'Mã Dự Thưởng', 'Kỳ Thưởng', 'Lượt Trong Kỳ', 'Chủ Đại Lý'].indexOf(header) !== -1;
        if (header !== '' && index < headers.length && header !== headers[index] && !legacyHeader) {
          throw new Error('Custom sheet headers require manual migration');
        }
      });
      if (existing[0].length > headers.length) {
        sheet.getRange(1, headers.length + 1, 1, existing[0].length - headers.length).clearContent();
      }
    }
    var rowsById = {};
    for (var rowIndex = 1; rowIndex < existing.length; rowIndex++) {
      var existingId = existing[rowIndex][0];
      if (existingId === '' || existingId === null || existingId === undefined) continue;
      if (rowsById[existingId]) throw new Error('Duplicate sheet IDs require reconciliation');
      var isVoid = typeof existing[rowIndex][6] === 'string' && existing[rowIndex][6].indexOf('[ĐÃ HỦY]') === 0;
      rowsById[existingId] = { row: rowIndex + 1, isVoid: isVoid, version: isVoid ? 2 : 1 };
    }
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    var acknowledgements = [];
    payload.data.forEach(function(record) {
      var saved = rowsById[record.id];
      var shouldUpdate = !saved || (saved.isVoid && record.status === 'active' ? false : record.record_version >= saved.version);
      if (shouldUpdate) {
        var prizeText = record.prize_code || '';
        if (record.status === 'void') {
          prizeText = '[ĐÃ HỦY] ' + prizeText;
        }
        var values = [
          record.id, record.spin_time, record.agency_code, record.phone, record.address,
          record.entry_code, prizeText, record.position_in_cycle || ''
        ].map(function(value) {
          if (value === null || value === undefined) return '';
          return typeof value === 'string' && /^[=+@-]/.test(value) ? "'" + value : value;
        });
        var destination = saved ? saved.row : sheet.getLastRow() + 1;
        sheet.getRange(destination, 4, 1, 1).setNumberFormat('@');
        sheet.getRange(destination, 6, 1, 1).setNumberFormat('@');
        sheet.getRange(destination, 1, 1, headers.length).setValues([values]);
        if (saved && existing.length > 0 && existing[0].length > headers.length) {
          sheet.getRange(destination, headers.length + 1, 1, existing[0].length - headers.length).clearContent();
        }
        saved = { row: destination, version: record.record_version, isVoid: record.status === 'void' };
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
