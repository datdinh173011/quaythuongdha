// DOM Elements
const provinceInput = document.getElementById("province-input");
const provinceHidden = document.getElementById("province");
const provinceDropdown = document.getElementById("province-dropdown");

const agencyInput = document.getElementById("agency-input");
const agencyHidden = document.getElementById("agency-name");
const agencyDropdown = document.getElementById("agency-dropdown");

const submitForm = document.getElementById("submit-form");
const searchForm = document.getElementById("search-form");
const phoneSearchInput = document.getElementById("phone-search");

// Modal Elements
const modalReward = document.getElementById("modal-reward");
const modalHistory = document.getElementById("modal-history");
const modalAlert = document.getElementById("modal-alert");

// Reward Result Elements
const rewardResultImg = document.getElementById("reward-result-img");
const rewardTierName = document.getElementById("reward-tier-name");
const rewardResultName = document.getElementById("reward-result-name");
const rewardAgencyText = document.getElementById("reward-agency-text");
const rewardCodeText = document.getElementById("reward-code-text");
const rewardSerialText = document.getElementById("reward-serial-text");
const rewardSerialRow = document.getElementById("reward-serial-row");
const rewardTimeText = document.getElementById("reward-time-text");

// History Elements
const historyPhoneTitle = document.getElementById("history-phone-title");
const historyTableBody = document.getElementById("history-table-body");
const historyEmpty = document.getElementById("history-empty");

// Alert Elements
const alertIcon = document.getElementById("alert-icon");
const alertTitle = document.getElementById("alert-title");
const alertMessage = document.getElementById("alert-message");

let allProvinces = [];
let currentAgencies = [];

// Hàm loại bỏ dấu tiếng Việt để tìm kiếm thông minh (search không dấu)
function removeVietnameseTones(str) {
  if (!str) return "";
  str = str.toLowerCase();
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/\u0300|\u0301|\u0303|\u0309|\u0323/g, "");
  str = str.replace(/\u02C6|\u0306|\u031B/g, "");
  return str.trim();
}

// 1. Tải danh sách tỉnh/thành từ máy chủ khi load trang
async function loadProvinces() {
  try {
    const res = await fetch('/api/provinces');
    const data = await res.json();
    if (data.success && data.provinces) {
      allProvinces = data.provinces;
    }
  } catch (err) {
    console.error("Lỗi khi tải tỉnh/thành:", err);
  }
}

// Render dropdown Tỉnh/Thành theo từ khóa gõ
function renderProvinceDropdown(filterText = "") {
  const cleanFilter = removeVietnameseTones(filterText);
  const matched = allProvinces.filter(p => removeVietnameseTones(p).includes(cleanFilter));

  provinceDropdown.innerHTML = "";
  if (matched.length === 0) {
    provinceDropdown.innerHTML = '<div class="combobox-empty">Không tìm thấy tỉnh/thành phù hợp</div>';
  } else {
    matched.forEach(p => {
      const item = document.createElement("div");
      item.className = "combobox-item";
      item.textContent = p;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // Tránh blur sớm
        selectProvince(p);
      });
      provinceDropdown.appendChild(item);
    });
  }
  provinceDropdown.classList.add("active");
}

// Khi người dùng chọn 1 Tỉnh/Thành
async function selectProvince(provinceName) {
  provinceInput.value = provinceName;
  provinceHidden.value = provinceName;
  provinceDropdown.classList.remove("active");

  // Reset ô Đại lý
  agencyInput.value = "";
  agencyHidden.value = "";
  agencyInput.placeholder = "Đang tải danh sách đại lý...";
  currentAgencies = [];

  try {
    const res = await fetch(`/api/agencies?province=${encodeURIComponent(provinceName)}`);
    const data = await res.json();
    if (data.success && data.agencies) {
      currentAgencies = data.agencies;
      agencyInput.placeholder = "Tên đại lý (gõ để tìm...)";
    }
  } catch (err) {
    console.error("Lỗi tải đại lý:", err);
    agencyInput.placeholder = "Lỗi tải đại lý";
  }
}

// Sự kiện người dùng gõ / click ô Tỉnh/Thành
provinceInput.addEventListener("focus", () => {
  renderProvinceDropdown(provinceInput.value);
});
provinceInput.addEventListener("input", () => {
  provinceHidden.value = ""; // Chưa chốt lựa chọn
  renderProvinceDropdown(provinceInput.value);
});
provinceInput.addEventListener("blur", () => {
  setTimeout(() => {
    provinceDropdown.classList.remove("active");
    // Nếu người dùng gõ đúng y nguyên tên tỉnh thì tự chọn
    if (!provinceHidden.value && provinceInput.value) {
      const match = allProvinces.find(p => p.toLowerCase() === provinceInput.value.trim().toLowerCase());
      if (match) {
        selectProvince(match);
      }
    }
  }, 200);
});

// Render dropdown Đại Lý theo từ khóa gõ
function renderAgencyDropdown(filterText = "") {
  if (!provinceHidden.value) {
    agencyDropdown.innerHTML = '<div class="combobox-empty">Vui lòng chọn Tỉnh/thành trước</div>';
    agencyDropdown.classList.add("active");
    return;
  }

  const cleanFilter = removeVietnameseTones(filterText);
  const matched = currentAgencies.filter(a => {
    const nameNorm = removeVietnameseTones(a.name);
    const addrNorm = removeVietnameseTones(a.address);
    return nameNorm.includes(cleanFilter) || addrNorm.includes(cleanFilter);
  });

  agencyDropdown.innerHTML = "";
  if (matched.length === 0) {
    agencyDropdown.innerHTML = '<div class="combobox-empty">Không tìm thấy đại lý phù hợp</div>';
  } else {
    matched.forEach(a => {
      const item = document.createElement("div");
      item.className = "combobox-item";
      item.innerHTML = `<strong>${a.name}</strong> <span style="font-size: 0.85rem; color: #64748b;">(${a.address})</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectAgency(a);
      });
      agencyDropdown.appendChild(item);
    });
  }
  agencyDropdown.classList.add("active");
}

function selectAgency(agency) {
  agencyInput.value = `${agency.name} - ${agency.address}`;
  agencyHidden.value = agency.code || agency.id;
  agencyDropdown.classList.remove("active");
}

agencyInput.addEventListener("focus", () => {
  renderAgencyDropdown(agencyInput.value);
});
agencyInput.addEventListener("input", () => {
  agencyHidden.value = "";
  renderAgencyDropdown(agencyInput.value);
});
agencyInput.addEventListener("blur", () => {
  setTimeout(() => {
    agencyDropdown.classList.remove("active");
  }, 200);
});


// 2. Xử lý Quay Thưởng
submitForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  const province = provinceHidden.value;
  const agencyVal = agencyHidden.value;
  const ownerName = document.getElementById("owner-name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const address = document.getElementById("adress").value.trim();
  const entryCode = document.getElementById("entry-code").value.trim();

  if (!province) {
    showAlert("Thông Báo", "Vui lòng chọn hoặc gõ tìm kiếm Tỉnh/thành của bạn.", "⚠️");
    provinceInput.focus();
    return;
  }
  if (!agencyVal) {
    showAlert("Thông Báo", "Vui lòng chọn hoặc gõ tìm kiếm Tên đại lý từ danh sách.", "⚠️");
    agencyInput.focus();
    return;
  }
  if (!ownerName || !phone || !address || !entryCode) {
    showAlert("Thông Báo", "Vui lòng nhập đầy đủ các trường thông tin!", "⚠️");
    return;
  }

  // Lấy tên đại lý từ danh sách hiện tại
  const selectedAgencyObj = currentAgencies.find(a => (a.code === agencyVal || String(a.id) === agencyVal));
  const agencyName = selectedAgencyObj ? selectedAgencyObj.name : agencyInput.value;
  const agencyCode = selectedAgencyObj ? selectedAgencyObj.code : agencyVal;

  const btnSubmit = submitForm.querySelector("button[type='submit']");
  const originalBtnText = btnSubmit.textContent;
  btnSubmit.disabled = true;
  btnSubmit.textContent = "ĐANG QUAY THƯỞNG...";

  try {
    const res = await fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        province,
        agencyCode,
        agencyName,
        ownerName,
        phone,
        address,
        entryCode
      })
    });

    const result = await res.json();

    if (!result.success) {
      showAlert("Không Thể Quay Thưởng", result.message || "Đã có lỗi xảy ra.", "❌");
      return;
    }

    // Hiển thị kết quả trúng thưởng
    if (rewardTierName) {
      const tier = result.prize.tier || result.prize.prize_tier || "GIẢI THƯỞNG";
      rewardTierName.textContent = String(tier).toUpperCase();
    }
    rewardResultName.textContent = result.prize.name;
    rewardResultImg.src = result.prize.image_url || '/img/Giải Nhất.png';
    rewardAgencyText.textContent = result.agencyName;
    rewardCodeText.textContent = result.entryCode;
    
    if (result.serialNumber) {
      rewardSerialText.textContent = result.serialNumber;
      rewardSerialRow.style.display = 'flex';
    } else {
      rewardSerialRow.style.display = 'none';
    }
    
    rewardTimeText.textContent = result.spinTime;

    // Mở popup kết quả và bắn pháo hoa Confetti
    openRewardModal();
    fireConfetti();

    // Reset ô mã dự thưởng để tránh bấm lại
    document.getElementById("entry-code").value = "";

  } catch (err) {
    console.error("Lỗi khi gửi yêu cầu quay thưởng:", err);
    showAlert("Lỗi Kết Nối", "Không thể kết nối đến máy chủ. Vui lòng thử lại!", "❌");
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.textContent = originalBtnText;
  }
});

// 3. Xử lý Tra Cứu Lịch Sử Quay Thưởng
searchForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  const phone = phoneSearchInput.value.trim();
  if (!phone) {
    showAlert("Thông Báo", "Vui lòng nhập số điện thoại để tra cứu!", "ℹ️");
    return;
  }

  const btnSearch = searchForm.querySelector("button[type='submit']");
  btnSearch.disabled = true;
  btnSearch.textContent = "...";

  try {
    const res = await fetch(`/api/history?phone=${encodeURIComponent(phone)}`);
    const data = await res.json();

    if (!data.success) {
      showAlert("Lỗi Tra Cứu", data.message || "Không thể tra cứu lịch sử.", "❌");
      return;
    }

    historyPhoneTitle.textContent = phone;
    historyTableBody.innerHTML = "";

    if (!data.history || data.history.length === 0) {
      historyEmpty.style.display = "block";
    } else {
      historyEmpty.style.display = "none";
      data.history.forEach((item, index) => {
        const tr = document.createElement("tr");

        let timeStr = item.spin_time;
        try {
          const d = new Date(item.spin_time);
          if (!isNaN(d.getTime())) {
            timeStr = d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
          }
        } catch(e) {}

        tr.innerHTML = `
          <td style="text-align: center; font-weight: bold; color: #64748b;">${index + 1}</td>
          <td>
            <strong>${item.agency_name}</strong>
            <div style="font-size: 0.8rem; color: #0284c7;">Mã: ${item.entry_code || ''}</div>
          </td>
          <td>
            <div class="prize-cell">
              <img src="${item.prize_image || '/img/Artboard 23@2x.png'}" alt="quà" />
              <span>${item.prize_name}</span>
            </div>
          </td>
          <td style="font-size: 0.85rem; color: #475569;">${timeStr}</td>
        `;
        historyTableBody.appendChild(tr);
      });
    }

    openHistoryModal();
  } catch (err) {
    console.error("Lỗi khi tra cứu lịch sử:", err);
    showAlert("Lỗi Kết Nối", "Không thể kết nối đến máy chủ tra cứu.", "❌");
  } finally {
    btnSearch.disabled = false;
    btnSearch.textContent = "TRA CỨU";
  }
});

// Các hàm đóng/mở Modal
function openRewardModal() {
  modalReward.classList.add("active");
}
function closeRewardModal() {
  modalReward.classList.remove("active");
}

function openHistoryModal() {
  modalHistory.classList.add("active");
}
function closeHistoryModal() {
  modalHistory.classList.remove("active");
}

function showAlert(title, message, icon = "⚠️") {
  alertTitle.textContent = title;
  alertMessage.textContent = message;
  alertIcon.textContent = icon;
  modalAlert.classList.add("active");
}
function closeAlertModal() {
  modalAlert.classList.remove("active");
}

// Đóng modal khi bấm ra ngoài vùng nền mờ
[modalReward, modalHistory, modalAlert].forEach(modal => {
  modal.addEventListener("click", function (e) {
    if (e.target === modal) {
      modal.classList.remove("active");
    }
  });
});

// Hiệu ứng pháo hoa Confetti
function fireConfetti() {
  if (typeof confetti === "function") {
    confetti({
      particleCount: 120,
      spread: 70,
      origin: { y: 0.6 }
    });
    setTimeout(() => {
      confetti({
        particleCount: 80,
        angle: 60,
        spread: 55,
        origin: { x: 0 }
      });
      confetti({
        particleCount: 80,
        angle: 120,
        spread: 55,
        origin: { x: 1 }
      });
    }, 250);
  }
}

// Khởi chạy khi load xong DOM
document.addEventListener("DOMContentLoaded", () => {
  loadProvinces();
});