const APP_BASE_PATH = /^\/quaythuongdha-admin(?:\/|$)/.test(window.location.pathname) ? '/quaythuongdha-admin' : '';

function apiFetch(endpoint, options) {
  return window.fetch(APP_BASE_PATH + endpoint, options);
}

function assetUrl(url, fallback = '') {
  const value = url || fallback;
  return /^\/?(?:img|uploads)\//.test(value) ? `${APP_BASE_PATH}/${value.replace(/^\//, '')}` : value;
}

function formatSpinTime(value) {
  if (typeof value !== 'string' || !value.trim()) return '—';
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]} · ${parts[4]}${parts[5] ? ` ${parts[5]}` : ''}` : value;
}

// Global State
let token = localStorage.getItem('admin_token') || '';
let currentTab = 'agencies';
let allProvinces = [];

// API Helpers
function getAuthHeaders() {
  return {
    'Authorization': `Bearer ${token}`
  };
}

// 1. Khởi động ứng dụng Admin
document.addEventListener('DOMContentLoaded', () => {
  const userAppLink = document.querySelector('[data-user-app-link]');
  if (userAppLink) {
    userAppLink.href = APP_BASE_PATH ? '/quaythuongdha/' : '/';
  }
  if (token) {
    showAdminApp();
  } else {
    showLogin();
  }

  // Lắng nghe sự kiện login
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // Lắng nghe tìm kiếm & lọc
  document.getElementById('agency-search-input').addEventListener('input', debounce(loadAgencies, 300));
  document.getElementById('agency-province-filter').addEventListener('change', loadAgencies);

  document.getElementById('code-search-input').addEventListener('input', debounce(loadCodes, 300));
  document.getElementById('code-status-filter').addEventListener('change', loadCodes);

  document.getElementById('spin-search-input').addEventListener('input', debounce(loadSpins, 300));
  document.getElementById('spin-sync-filter').addEventListener('change', loadSpins);
});

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// 2. Xác thực Đăng Nhập / Đăng Xuất
async function handleLogin(e) {
  e.preventDefault();
  const pass = document.getElementById('admin-pass-input').value.trim();
  const errorMsg = document.getElementById('login-error');
  errorMsg.style.display = 'none';

  try {
    const res = await apiFetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    });
    const data = await res.json();
    if (data.success) {
      token = data.token;
      localStorage.setItem('admin_token', token);
      showAdminApp();
    } else {
      errorMsg.textContent = data.message || 'Mật khẩu không chính xác';
      errorMsg.style.display = 'block';
    }
  } catch (err) {
    errorMsg.textContent = 'Lỗi kết nối máy chủ';
    errorMsg.style.display = 'block';
  }
}

function handleLogout() {
  if (confirm('Bạn có chắc chắn muốn đăng xuất?')) {
    localStorage.removeItem('admin_token');
    token = '';
    showLogin();
  }
}

function showLogin() {
  document.getElementById('login-container').style.display = 'flex';
  document.getElementById('admin-app').style.display = 'none';
  document.getElementById('admin-pass-input').value = '';
}

function showAdminApp() {
  document.getElementById('login-container').style.display = 'none';
  document.getElementById('admin-app').style.display = 'flex';
  loadDashboardStats();
  loadProvincesFilter();
  switchTab(currentTab);
}

// 3. Chuyển đổi Tab
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));

  // Active tab button & section
  const activeBtn = Array.from(document.querySelectorAll('.nav-item')).find(btn => btn.getAttribute('onclick').includes(tabName));
  if (activeBtn) activeBtn.classList.add('active');

  const tabSection = document.getElementById(`tab-${tabName}`);
  if (tabSection) tabSection.classList.add('active');

  const titleMap = {
    'agencies': '🏢 Quản Lý Danh Sách Đại Lý',
    'prizes': '🎁 Quản Lý Kho Quà Tặng & Tỷ Lệ Trúng',
    'lucky-codes': '🎫 Quản Lý Mã Dự Thưởng & Serial',
    'spins': '🎰 Quản Trị Lượt Quay & Đồng Bộ Google Sheets',
    'settings': '⚙️ Cài Đặt Hệ Thống & Webhook'
  };
  document.getElementById('page-title').textContent = titleMap[tabName] || 'Admin Dashboard';

  // Load data for the tab
  if (tabName === 'agencies') loadAgencies();
  if (tabName === 'prizes') loadPrizes();
  if (tabName === 'lucky-codes') loadCodes();
  if (tabName === 'spins') loadSpins();
  if (tabName === 'settings') loadSettings();
  loadDashboardStats();
}

// 4. Thống Kê Tổng Quan (Stats)
async function loadDashboardStats() {
  const overview = document.querySelector('.reward-overview');
  const summaryStatus = document.getElementById('reward-summary-status');
  overview.setAttribute('aria-busy', 'true');
  summaryStatus.classList.remove('is-error');
  summaryStatus.textContent = 'Đang tải thống kê…';
  try {
    const res = await apiFetch('/api/admin/stats', { headers: getAuthHeaders() });
    const data = await res.json();
    if (!res.ok || !data.success || !data.stats) throw new Error('Không tải được thống kê');
    if (data.success && data.stats) {
      document.getElementById('stat-agencies').textContent = data.stats.agencyCount;
      document.getElementById('stat-prizes').textContent = data.stats.prizeStock;
      document.getElementById('stat-spins').textContent = data.stats.totalSpins;
      document.getElementById('stat-unsynced').textContent = data.stats.unsyncedSpins;
      const formatCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('vi-VN') : '—';
      document.getElementById('stat-participants').textContent = formatCount(data.stats.participantCount);
      for (const milestoneNumber of [14, 25]) {
        const milestone = data.stats.milestones?.find(item => item.milestone === milestoneNumber);
        document.getElementById(`stat-milestone-${milestoneNumber}-eligible`).textContent = formatCount(milestone?.eligible_count);
        document.getElementById(`stat-milestone-${milestoneNumber}-gold`).textContent = formatCount(milestone?.gold_count);
      }
      summaryStatus.textContent = 'Chỉ tính lượt có hiệu lực · Không bao gồm lượt đã hủy';
    }
  } catch (err) {
    summaryStatus.textContent = 'Chưa cập nhật được thống kê. Vui lòng tải lại trang để thử lại.';
    summaryStatus.classList.add('is-error');
    console.error('Lỗi tải stats:', err);
  } finally {
    overview.setAttribute('aria-busy', 'false');
  }
}

/* ========================================================
   TAB 1: QUẢN LÝ ĐẠI LÝ
======================================================== */
async function loadProvincesFilter() {
  try {
    const res = await apiFetch('/api/provinces');
    const data = await res.json();
    if (data.success && data.provinces) {
      allProvinces = data.provinces;
      const select = document.getElementById('agency-province-filter');
      select.innerHTML = '<option value="">-- Tất cả tỉnh thành --</option>';
      data.provinces.forEach(p => {
        select.innerHTML += `<option value="${p}">${p}</option>`;
      });
    }
  } catch (err) {
    console.error('Lỗi load provinces:', err);
  }
}

async function loadAgencies() {
  const tbody = document.getElementById('agencies-table-body');
  const q = document.getElementById('agency-search-input').value.trim();
  const province = document.getElementById('agency-province-filter').value;

  tbody.innerHTML = '<tr><td colspan="6" class="text-center">Đang tải danh sách...</td></tr>';

  try {
    const url = `/api/admin/agencies?q=${encodeURIComponent(q)}&province=${encodeURIComponent(province)}`;
    const res = await apiFetch(url, { headers: getAuthHeaders() });
    const data = await res.json();

    if (!data.success || !data.agencies || data.agencies.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Không tìm thấy đại lý nào.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.agencies.forEach((a, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="text-align: center;">${idx + 1}</td>
        <td><strong style="color: #0284c7;">${a.code || '-'}</strong></td>
        <td><strong>${a.name}</strong></td>
        <td><span class="badge badge-info">${a.province}</span></td>
        <td>${a.address}</td>
        <td style="text-align: center;">
          <button class="btn btn-secondary btn-sm" onclick='editAgency(${JSON.stringify(a)})'>Sửa</button>
          <button class="btn btn-danger-outline btn-sm" onclick="deleteAgency(${a.id}, '${a.name}')">Xóa</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center error-msg">Lỗi tải danh sách đại lý.</td></tr>';
  }
}

function openAgencyModal() {
  document.getElementById('agency-modal-title').textContent = 'Thêm Đại Lý Mới';
  document.getElementById('agency-edit-id').value = '';
  document.getElementById('agency-form-code').value = '';
  document.getElementById('agency-form-name').value = '';
  document.getElementById('agency-form-province').value = '';
  document.getElementById('agency-form-address').value = '';
  document.getElementById('agency-modal').classList.add('active');
}

function editAgency(a) {
  document.getElementById('agency-modal-title').textContent = 'Chỉnh Sửa Đại Lý';
  document.getElementById('agency-edit-id').value = a.id;
  document.getElementById('agency-form-code').value = a.code || '';
  document.getElementById('agency-form-name').value = a.name;
  document.getElementById('agency-form-province').value = a.province;
  document.getElementById('agency-form-address').value = a.address;
  document.getElementById('agency-modal').classList.add('active');
}

function closeAgencyModal() {
  document.getElementById('agency-modal').classList.remove('active');
}

async function handleSaveAgency(e) {
  e.preventDefault();
  const id = document.getElementById('agency-edit-id').value;
  const code = document.getElementById('agency-form-code').value.trim();
  const name = document.getElementById('agency-form-name').value.trim();
  const province = document.getElementById('agency-form-province').value.trim();
  const address = document.getElementById('agency-form-address').value.trim();

  const isEdit = Boolean(id);
  const url = isEdit ? `/api/admin/agencies/${id}` : '/api/admin/agencies';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await apiFetch(url, {
      method,
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, province, address })
    });
    const data = await res.json();
    if (data.success) {
      closeAgencyModal();
      loadAgencies();
      loadProvincesFilter();
      loadDashboardStats();
    } else {
      alert('Lỗi: ' + (data.message || 'Không thể lưu'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ!');
  }
}

async function deleteAgency(id, name) {
  if (confirm(`Bạn có chắc chắn muốn xóa đại lý "${name}"?`)) {
    try {
      const res = await apiFetch(`/api/admin/agencies/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (data.success) {
        loadAgencies();
        loadDashboardStats();
      } else {
        alert('Lỗi khi xóa: ' + data.message);
      }
    } catch (err) {
      alert('Lỗi kết nối máy chủ!');
    }
  }
}

// Import Excel Đại Lý
async function handleImportAgencyExcel(e) {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/api/admin/agencies/import', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      alert(data.message);
      loadAgencies();
      loadProvincesFilter();
      loadDashboardStats();
    } else {
      alert('Lỗi: ' + data.message);
    }
  } catch (err) {
    alert('Lỗi khi tải file Excel lên!');
  } finally {
    e.target.value = '';
  }
}

function downloadSampleAgencyExcel() {
  const sampleData = [
    { "Mã đại lý": "DL001", "Tên đại lý": "Đại lý Hà Nội 1", "Tỉnh/thành": "Hà Nội", "Địa chỉ": "123 Cầu Giấy" },
    { "Mã đại lý": "DL002", "Tên đại lý": "Đại lý Sài Gòn 1", "Tỉnh/thành": "TP.HCM", "Địa chỉ": "456 Quận 1" }
  ];
  const ws = XLSX.utils.json_to_sheet(sampleData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "DaiLy");
  XLSX.writeFile(wb, "Mau_Danh_Sach_Dai_Ly.xlsx");
}


/* ========================================================
   TAB 2: QUẢN LÝ QUÀ TẶNG
======================================================== */
async function loadPrizes() {
  const tbody = document.getElementById('prizes-table-body');
  tbody.innerHTML = '<tr><td colspan="9" class="text-center">Đang tải danh sách quà...</td></tr>';

  try {
    const res = await apiFetch('/api/admin/prizes', { headers: getAuthHeaders() });
    const data = await res.json();

    if (!data.success || !data.prizes || data.prizes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Chưa có quà tặng nào trong kho.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.prizes.forEach((p, idx) => {
      const tr = document.createElement('tr');

      tr.innerHTML = `
        <td style="text-align: center;">${idx + 1}</td>
        <td>
          <img src="${assetUrl(p.image_url, '/img/Artboard 23@2x.png')}" alt="quà" class="table-img">
        </td>
        <td><strong>${p.code}</strong></td>
        <td><strong style="color: #f7961d; text-transform: uppercase;">${p.prize_tier || 'GIẢI THƯỞNG'}</strong></td>
        <td><strong>${p.name}</strong></td>
        <td style="text-align: center;">${p.total_quantity}</td>
        <td style="text-align: center;"><strong style="color: ${p.remaining_quantity > 0 ? '#10b981' : '#ef4444'}; font-size: 1.05rem;">${p.remaining_quantity}</strong></td>
        <td style="text-align: center;">${p.used_quantity}</td>
        <td style="text-align: center;">
          <button class="btn btn-secondary btn-sm" onclick='editPrize(${JSON.stringify(p)})'>Sửa</button>
          ${p.rule_locked ? '<span class="badge badge-info">Khóa mã quà</span>' : `<button class="btn btn-danger-outline btn-sm" onclick="deletePrize(${p.id}, '${p.name}')">Xóa</button>`}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center error-msg">Lỗi tải danh sách quà.</td></tr>';
  }
}

function openPrizeModal() {
  document.getElementById('prize-form-code').readOnly = false;
  document.getElementById('prize-form-remain').min = '0';
  document.getElementById('prize-modal-title').textContent = 'Thêm Quà Tặng Mới';
  document.getElementById('prize-edit-id').value = '';
  document.getElementById('prize-form-code').value = '';
  document.getElementById('prize-form-tier').value = '';
  document.getElementById('prize-form-name').value = '';
  document.getElementById('prize-form-total').value = '10';
  document.getElementById('prize-form-url').value = '';
  document.getElementById('prize-form-file').value = '';
  document.getElementById('prize-remain-group').style.display = 'none';
  document.getElementById('prize-modal').classList.add('active');
}

function editPrize(p) {
  document.getElementById('prize-form-code').readOnly = Boolean(p.rule_locked);
  document.getElementById('prize-form-remain').min = String(p.reserved_quantity || 0);
  document.getElementById('prize-modal-title').textContent = 'Chỉnh Sửa Quà Tặng';
  document.getElementById('prize-edit-id').value = p.id;
  document.getElementById('prize-form-code').value = p.code;
  document.getElementById('prize-form-tier').value = p.prize_tier || 'GIẢI THƯỞNG';
  document.getElementById('prize-form-name').value = p.name;
  document.getElementById('prize-form-total').value = p.total_quantity;
  document.getElementById('prize-form-remain').value = p.remaining_quantity;
  document.getElementById('prize-form-url').value = p.image_url;
  document.getElementById('prize-form-file').value = '';
  document.getElementById('prize-remain-group').style.display = 'block';
  document.getElementById('prize-modal').classList.add('active');
}

function closePrizeModal() {
  document.getElementById('prize-modal').classList.remove('active');
}

async function handleSavePrize(e) {
  e.preventDefault();
  const id = document.getElementById('prize-edit-id').value;
  const isEdit = Boolean(id);

  const formData = new FormData();
  formData.append('code', document.getElementById('prize-form-code').value.trim());
  formData.append('prize_tier', document.getElementById('prize-form-tier').value.trim());
  formData.append('name', document.getElementById('prize-form-name').value.trim());
  formData.append('quantity', document.getElementById('prize-form-total').value);
  formData.append('total_quantity', document.getElementById('prize-form-total').value);
  formData.append('image_url', document.getElementById('prize-form-url').value.trim());

  if (isEdit) {
    formData.append('remaining_quantity', document.getElementById('prize-form-remain').value);
  }

  const fileInput = document.getElementById('prize-form-file');
  if (fileInput.files.length > 0) {
    formData.append('image', fileInput.files[0]);
  }

  const url = isEdit ? `/api/admin/prizes/${id}` : '/api/admin/prizes';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await apiFetch(url, {
      method,
      headers: getAuthHeaders(),
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      closePrizeModal();
      loadPrizes();
      loadDashboardStats();
    } else {
      alert('Lỗi: ' + (data.message || 'Không thể lưu quà'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ!');
  }
}

async function deletePrize(id, name) {
  if (confirm(`Bạn có chắc chắn muốn xóa phần quà "${name}"?`)) {
    try {
      const res = await apiFetch(`/api/admin/prizes/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (data.success) {
        loadPrizes();
        loadDashboardStats();
      } else {
        alert('Lỗi khi xóa: ' + data.message);
      }
    } catch (err) {
      alert('Lỗi kết nối máy chủ!');
    }
  }
}


/* ========================================================
   TAB 3: QUẢN LÝ MÃ DỰ THƯỞNG & SERIAL
======================================================== */
async function loadCodes() {
  const tbody = document.getElementById('codes-table-body');
  const q = document.getElementById('code-search-input').value.trim();
  const status = document.getElementById('code-status-filter').value;

  tbody.innerHTML = '<tr><td colspan="6" class="text-center">Đang tải danh sách mã...</td></tr>';

  try {
    const url = `/api/admin/lucky-codes?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`;
    const res = await apiFetch(url, { headers: getAuthHeaders() });
    const data = await res.json();

    if (!data.success || !data.codes || data.codes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Không tìm thấy mã dự thưởng nào.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.codes.forEach((c, idx) => {
      const tr = document.createElement('tr');
      const isUsed = c.status === 'used';
      tr.innerHTML = `
        <td style="text-align: center;">${idx + 1}</td>
        <td><strong style="color: #0284c7; font-family: monospace; font-size: 1.05rem;">${c.code}</strong></td>
        <td><span style="font-family: monospace;">${c.serial_number || '-'}</span></td>
        <td style="text-align: center;">
          <span class="badge ${isUsed ? 'badge-danger' : 'badge-success'}">
            ${isUsed ? 'Đã quay trúng' : 'Chưa sử dụng'}
          </span>
        </td>
        <td>${c.used_at || '-'}</td>
        <td style="text-align: center;">
          <button class="btn btn-danger-outline btn-sm" onclick="deleteCode(${c.id}, '${c.code}')">Xóa</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center error-msg">Lỗi tải danh sách mã.</td></tr>';
  }
}

function openCodeModal() {
  document.getElementById('code-form-code').value = '';
  document.getElementById('code-form-serial').value = '';
  document.getElementById('code-modal').classList.add('active');
}

function closeCodeModal() {
  document.getElementById('code-modal').classList.remove('active');
}

async function handleSaveCode(e) {
  e.preventDefault();
  const code = document.getElementById('code-form-code').value.trim();
  const serial_number = document.getElementById('code-form-serial').value.trim();

  try {
    const res = await apiFetch('/api/admin/lucky-codes', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, serial_number })
    });
    const data = await res.json();
    if (data.success) {
      closeCodeModal();
      loadCodes();
      loadDashboardStats();
    } else {
      alert('Lỗi: ' + (data.message || 'Mã đã tồn tại'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ!');
  }
}

async function deleteCode(id, code) {
  if (confirm(`Bạn có chắc muốn xóa mã "${code}"?`)) {
    try {
      const res = await apiFetch(`/api/admin/lucky-codes/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (data.success) {
        loadCodes();
        loadDashboardStats();
      } else {
        alert('Lỗi khi xóa: ' + data.message);
      }
    } catch (err) {
      alert('Lỗi kết nối máy chủ!');
    }
  }
}

async function handleImportCodeExcel(e) {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await apiFetch('/api/admin/lucky-codes/import', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      alert(data.message);
      loadCodes();
      loadDashboardStats();
    } else {
      alert('Lỗi: ' + data.message);
    }
  } catch (err) {
    alert('Lỗi khi tải file Excel lên!');
  } finally {
    e.target.value = '';
  }
}

function downloadSampleCodeExcel() {
  const sampleData = [
    { "Mã dự thưởng": "BIO101", "Mã serial": "SR-2026-101" },
    { "Mã dự thưởng": "BIO102", "Mã serial": "SR-2026-102" },
    { "Mã dự thưởng": "BIO103", "Mã serial": "SR-2026-103" }
  ];
  const ws = XLSX.utils.json_to_sheet(sampleData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "MaDuThuong");
  XLSX.writeFile(wb, "Mau_Danh_Sach_Ma_Va_Serial.xlsx");
}


/* ========================================================
   TAB 4: QUẢN TRỊ LƯỢT QUAY & ĐỒNG BỘ GOOGLE SHEETS
======================================================== */
async function loadSpins() {
  const tbody = document.getElementById('spins-table-body');
  const q = document.getElementById('spin-search-input').value.trim();
  const synced = document.getElementById('spin-sync-filter').value;
  const status = document.getElementById('spin-status-filter').value;

  tbody.innerHTML = '<tr><td colspan="10" class="text-center">Đang tải lịch sử quay...</td></tr>';

  try {
    const url = `/api/admin/spins?q=${encodeURIComponent(q)}&synced=${encodeURIComponent(synced)}&status=${encodeURIComponent(status)}`;
    const res = await apiFetch(url, { headers: getAuthHeaders() });
    const data = await res.json();

    if (!data.success || !data.spins || data.spins.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">Chưa có lượt quay thưởng nào.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.spins.forEach((s) => {
      const tr = document.createElement('tr');
      const isSynced = s.is_synced === 1;

      tr.innerHTML = `
        <td>
          <div class="spin-summary">
            <strong class="spin-summary-title">Lượt quay thứ ${s.spin_number}</strong>
            <span class="spin-summary-time">${formatSpinTime(s.spin_time)}</span>
            <span class="badge ${s.status === 'void' ? 'badge-danger' : 'badge-success'}">${s.status === 'void' ? 'Đã hủy' : 'Đã ghi nhận'}</span>
            ${s.status === 'void' ? `<span class="spin-summary-voided">Thời điểm hủy: ${formatSpinTime(s.voided_at)}</span>` : ''}
          </div>
        </td>
        <td><strong>${s.agency_code || '-'}</strong></td>
        <td><strong>${s.agency_name}</strong></td>
        <td>${s.province}</td>
        <td>
          <strong style="color: #0284c7;">${s.phone}</strong>
          <div class="spin-bank"></div>
          <div class="spin-account-holder"></div>
        </td>
        <td style="font-size: 0.85rem;">${s.address}</td>
        <td>
          <div style="color: #0284c7; font-weight: bold; font-family: monospace;">${s.entry_code}</div>
          <div style="font-size: 0.8rem; color: #64748b;">Serial: ${s.serial_number || '-'}</div>
        </td>
        <td>
          <div style="display: flex; align-items: center; gap: 8px;">
            <img src="${assetUrl(s.prize_image, '/img/Artboard 23@2x.png')}" alt="quà" style="width: 28px; height: 28px; border-radius: 4px; object-fit: contain;">
            <strong style="color: #d97706;">${s.prize_name}</strong>
          </div>
        </td>
        <td style="text-align: center;">
          <span class="badge ${isSynced ? 'badge-success' : 'badge-warning'}">
            ${isSynced ? '✓ Đã Sync' : '⏳ Chờ Sync'}
          </span>
        </td>
        <td style="text-align: center;">
          ${s.canUndo ? `<button class="btn btn-danger-outline btn-sm" onclick="deleteSpin(${s.id})">Hủy lượt cuối</button>` : `<span class="badge badge-info">${s.undoReason === 'SPIN_ALREADY_VOID' ? 'Đã hủy' : s.undoReason === 'NOT_LATEST_SPIN' ? 'Không phải lượt cuối' : 'Không thể hủy'}</span>`}
        </td>
      `;
      tr.querySelector('.spin-bank').textContent = `${s.bank_name || '-'} · ${s.bank_account_number || '-'}`;
      tr.querySelector('.spin-account-holder').textContent = s.bank_account_holder_name || '-';
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center error-msg">Lỗi tải lịch sử quay.</td></tr>';
  }
}

// XÓA LƯỢT QUAY & HOÀN LẠI MÃ, HOÀN KHO QUÀ
async function deleteSpin(id) {
  const confirmText = 'Hủy lượt cuối của SĐT này?\n\nQuà và mã sẽ được hoàn lại, bộ đếm giảm một. Bản ghi vẫn được giữ để đối soát. Quay lại sẽ xét theo dữ liệu hiện tại và có thể nhận kết quả khác.\n\nChỉ xác nhận sau khi đã thu hồi/đối soát quà thực tế đã phát.';

  if (confirm(confirmText)) {
    try {
      const res = await apiFetch(`/api/admin/spins/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message || 'Đã xóa lượt quay và hoàn mã thành công!');
        loadSpins();
        loadPrizes();
        loadCodes();
        loadDashboardStats();
      } else {
        alert('Lỗi: ' + data.message);
      }
    } catch (err) {
      alert('Lỗi kết nối máy chủ!');
    }
  }
}

// ĐỒNG BỘ GOOGLE SHEET THỦ CÔNG
async function triggerManualSync() {
  const btn = document.getElementById('btn-sync-now');
  const oldText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ ĐANG ĐỒNG BỘ...';

  try {
    const res = await apiFetch('/api/admin/sync-sheet', {
      method: 'POST',
      headers: getAuthHeaders()
    });
    const data = await res.json();

    if (data.success) {
      alert(`Đồng bộ thành công! ${data.message || ''}`);
      loadSpins();
      loadDashboardStats();
    } else {
      alert(`Đồng bộ thất bại: ${data.message || data.error}`);
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ!');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldText;
  }
}

// XUẤT BÁO CÁO EXCEL LỊCH SỬ QUAY
async function exportSpinsExcel() {
  try {
    const response = await apiFetch('/api/admin/export-spins', { headers: getAuthHeaders() });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'Không thể xuất lịch sử quay thưởng.');
    }
    const downloadUrl = URL.createObjectURL(await response.blob());
    const downloadLink = document.createElement('a');
    downloadLink.href = downloadUrl;
    downloadLink.download = 'Lich_su_quay_thuong_BioAmicus.xlsx';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
  } catch (error) {
    alert(error.message || 'Lỗi kết nối máy chủ!');
  }
}


/* ========================================================
   TAB 5: CÀI ĐẶT & WEBHOOK
======================================================== */
async function loadSettings() {
  try {
    const res = await apiFetch('/api/admin/settings', { headers: getAuthHeaders() });
    const data = await res.json();
    if (data.success) {
      document.getElementById('setting-webhook-url').value = data.google_sheet_webhook_url || '';
    }
  } catch (err) {
    console.error('Lỗi load settings:', err);
  }
}

async function saveWebhookSetting() {
  const url = document.getElementById('setting-webhook-url').value.trim();

  try {
    const res = await apiFetch('/api/admin/settings', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ google_sheet_webhook_url: url })
    });
    const data = await res.json();
    if (data.success) {
      alert('Đã lưu cấu hình Google Sheet Webhook thành công!');
    } else {
      alert('Lỗi: ' + data.message);
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ!');
  }
}

async function changeAdminPassword() {
  const newPass = document.getElementById('setting-new-password').value.trim();
  if (!newPass) {
    alert('Vui lòng nhập mật khẩu mới!');
    return;
  }

  try {
    const res = await apiFetch('/api/admin/settings', {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPass })
    });
    const data = await res.json();
    if (data.success) {
      alert('Đã đổi mật khẩu quản trị thành công! Vui lòng sử dụng mật khẩu mới trong lần đăng nhập tiếp theo.');
      token = newPass;
      localStorage.setItem('admin_token', token);
      document.getElementById('setting-new-password').value = '';
    } else {
      alert('Lỗi: ' + data.message);
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ!');
  }
}

function copyScriptCode() {
  const code = document.getElementById('apps-script-code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    alert('Đã sao chép mã Apps Script vào clipboard! Hãy dán vào Google Apps Script.');
  });
}
