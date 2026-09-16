const fs = require('node:fs');
const path = require('node:path');

function loadBanks() {
  const source = process.env.BANK_CATALOG_PATH || path.join(__dirname, 'config', 'banks.json');
  const banks = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (!Array.isArray(banks)) throw new Error('INVALID_BANK_CATALOG');
  const codes = new Set();
  const names = new Set();
  for (const bank of banks) {
    if (!bank || typeof bank.code !== 'string' || !/^[A-Z0-9_-]{1,32}$/.test(bank.code)
      || typeof bank.name !== 'string' || !bank.name.trim() || bank.name !== bank.name.trim()
      || bank.name.length > 200 || codes.has(bank.code) || names.has(bank.name)) {
      throw new Error('INVALID_BANK_CATALOG');
    }
    codes.add(bank.code);
    names.add(bank.name);
  }
  return banks.map(({ code, name }) => ({ code, name }));
}

module.exports = { loadBanks };
