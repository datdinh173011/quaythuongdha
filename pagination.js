const PAGE_SIZES = [10, 25, 50, 100];

function parsePagination(query) {
  const page = query.page === undefined ? 1 : parsePositiveInteger(query.page);
  const pageSize = query.pageSize === undefined ? 25 : parsePositiveInteger(query.pageSize);
  if (!page || !PAGE_SIZES.includes(pageSize)) {
    const error = new Error('Trang phải là số nguyên dương; số dòng mỗi trang phải là 10, 25, 50 hoặc 100.');
    error.status = 400;
    throw error;
  }
  return { page, pageSize };
}

function parsePositiveInteger(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function paginate(db, query, selectSql, params, orderBy) {
  const requested = parsePagination(query);
  return db.transaction(() => {
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM (${selectSql})`).get(...params);
    const totalPages = Math.ceil(total / requested.pageSize);
    const page = Math.min(requested.page, Math.max(1, totalPages));
    const rows = db.prepare(`${selectSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, requested.pageSize, (page - 1) * requested.pageSize);
    return { rows, pagination: { page, pageSize: requested.pageSize, total, totalPages } };
  })();
}

module.exports = { paginate, parsePagination };
