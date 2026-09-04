const { stringify } = require('csv-stringify/sync');

/** Build a CSV string from an array of objects and an ordered column list. */
function toCsv(rows, columns) {
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  return stringify(rows, {
    header: true,
    columns: cols.map((c) => (typeof c === 'string' ? { key: c, header: c } : c)),
    cast: {
      date: (d) => d.toISOString(),
      boolean: (b) => (b ? 'true' : 'false'),
    },
  });
}

function sendCsv(res, filename, rows, columns) {
  const body = toCsv(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

module.exports = { toCsv, sendCsv };
