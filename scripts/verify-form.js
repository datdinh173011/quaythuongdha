const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dha-form-qa-'));
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ headless: true });
  let checks = 0;
  try {
    for (const [width, height] of [[375, 812], [768, 1024], [1440, 1000]]) {
      for (const base of ['', '/quaythuongdha']) {
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage();
        const errors = [];
        const submitted = [];
        let banksAvailable = false;
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== 'http://form.test') return route.fulfill({ status: 200, body: '', contentType: 'text/plain' });
          assert(url.pathname.startsWith(base + '/'));
          const resource = url.pathname.slice(base.length);
          const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
          if (resource === '/api/banks') {
            return route.fulfill({ status: banksAvailable ? 200 : 503, contentType: 'application/json',
              body: JSON.stringify(banksAvailable ? { success: true, banks: [{ code: 'TEST', name: 'Ngân hàng kiểm thử' }] } : { success: false }) });
          }
          if (resource === '/api/provinces') return json({ success: true, provinces: ['Hà Nội'] });
          if (resource === '/api/agencies') return json({ success: true, agencies: [{ id: 1, code: 'DL001', name: 'Đại lý kiểm thử', address: 'Địa chỉ kiểm thử' }] });
          if (resource === '/api/spin') {
            const input = request.postDataJSON();
            submitted.push(input);
            return json({ success: true, prize: { tier: 'GIẢI MAY MẮN 2', name: 'Quà kiểm thử', image_url: '/img/Artboard 23@2x.png' },
              agencyName: input.agencyName, entryCode: input.entryCode, spinNumber: 1, spinTime: '2026-09-15 09:00:00' });
          }
          if (resource === '/api/history') return json({ success: true, history: [{ agency_name: 'Đại lý kiểm thử', entry_code: 'TESTONLY',
            spin_number: 1, spin_time: '2026-09-15 09:00:00', prize_name: 'Quà kiểm thử',
            prize_image: '/img/Artboard 23@2x.png', bank_name: 'Ngân hàng kiểm thử', bank_account_number_masked: '••••6789' }] });
          const filename = resource === '/' ? 'index.html' : decodeURIComponent(resource.slice(1));
          if (!['index.html', 'main.js', 'style.css'].includes(filename) && !filename.startsWith('img/') && !filename.startsWith('uploads/')) {
            return route.fulfill({ status: 404, body: '' });
          }
          const filepath = path.resolve(root, filename);
          if (!filepath.startsWith(root + path.sep) || !fs.existsSync(filepath)) return route.fulfill({ status: 404, body: '' });
          const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(filepath)];
          return route.fulfill({ contentType, body: fs.readFileSync(filepath) });
        });
        await page.goto(`http://form.test${base}/`);
        await page.locator('#retry-banks').waitFor({ state: 'visible' });
        assert(await page.locator('#submit-form button[type="submit"]').isDisabled());
        assert.equal(await page.locator('#owner-name').count(), 0);
        assert.equal(await page.locator('#bank-account-number').getAttribute('type'), 'text');
        banksAvailable = true;
        await page.locator('#retry-banks').click();
        await page.waitForFunction(() => !document.getElementById('bank-name').disabled);
        await page.locator('#province-input').fill('Ha Noi');
        await page.locator('#province-dropdown .combobox-item').click();
        await page.locator('#agency-input').click();
        await page.locator('#agency-dropdown .combobox-item').click();
        await page.locator('#phone').fill('0900000001');
        await page.locator('#adress').fill('Địa chỉ kiểm thử');
        await page.locator('#entry-code').fill('TESTONLY');
        const submit = page.locator('#submit-form button[type="submit"]');
        await submit.click();
        assert.equal(submitted.length, 0);
        await page.locator('#bank-name').selectOption({ label: 'Ngân hàng kiểm thử' });
        await submit.click();
        assert.equal(submitted.length, 0);
        await page.locator('#bank-account-number').fill('00123456789');
        await submit.click();
        assert.equal(submitted.length, 0);
        await page.locator('#bank-account-holder-name').fill('Nguyễn Thị Ánh');
        const layout = await page.evaluate(() => {
          const form = document.querySelector('#submit-form').getBoundingClientRect();
          const search = document.querySelector('.search').getBoundingClientRect();
          const art = document.querySelector(window.innerWidth < 768 ? '.mobile-background' : '.pc-background').getBoundingClientRect();
          return { noOverlap: form.bottom <= search.top && search.bottom <= art.top,
            noOverflow: document.documentElement.scrollWidth <= window.innerWidth };
        });
        assert.equal(layout.noOverlap, true);
        assert.equal(layout.noOverflow, true);
        await page.screenshot({ path: path.join(directory, `form-${width}${base ? '-base' : ''}.png`), fullPage: true });
        await submit.click();
        await page.locator('#modal-reward.active').waitFor();
        assert.equal(submitted.length, 1);
        assert.equal(Object.hasOwn(submitted[0], 'ownerName'), false);
        assert.equal(submitted[0].bankName, 'Ngân hàng kiểm thử');
        assert.equal(submitted[0].bankAccountNumber, '00123456789');
        assert.equal(submitted[0].bankAccountHolderName, 'Nguyễn Thị Ánh');
        assert.equal(await page.locator('#modal-reward .logo').textContent(), 'QUAY SỐ TRÚNG THƯỞNG');
        await page.evaluate(() => closeRewardModal());
        await page.locator('#phone-search').fill('0900000001');
        await page.locator('#search-form button').click();
        await page.locator('#modal-history.active').waitFor();
        assert((await page.locator('.history-bank-info').textContent()).includes('••••6789'));
        assert.deepEqual(errors, []);
        checks++;
        console.log(`PASS form ${width}px ${base || '/'}: thiếu danh mục, tải lại, validation, payload, lịch sử và bố cục`);
        await context.close();
      }
    }
    console.log(`${checks} kịch bản Chromium đạt. Ảnh kiểm tra: ${directory}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
