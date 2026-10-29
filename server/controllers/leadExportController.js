const { Lead, LeadSource, SearchRun, User, LeadExport, sequelize } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const svc = require('../services/leadExportService');

// One export at a time per user — blocks duplicate requests from repeated clicks.
// ponytail: in-process Set; move to a DB/redis lock if the API ever runs on >1 instance.
const inFlight = new Set();

// DB failures surface as a generic 503 — never the driver's message (hosts, SQL).
async function countAndUsers(parsed) {
  try {
    return await Promise.all([svc.countMatching(parsed), userNames()]);
  } catch (err) {
    console.error('[export] count query failed:', err);
    throw new ApiError(503, 'The database is unavailable right now. Please try again shortly.');
  }
}

async function userNames() {
  const users = await User.findAll({ attributes: ['id', 'name'], raw: true });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

// History is best-effort: an export must never fail because its audit row couldn't be written
// (e.g. `npm run migrate` not yet run to create lead_exports).
async function recordExport(user, req, fields) {
  try {
    await LeadExport.create({
      user_id: user.id,
      date_field: req.dateField,
      date_from: req.dateFrom || null,
      date_to: req.dateTo || null,
      timezone: req.timezone,
      filters: req.filters,
      columns: req.columns,
      ...fields,
    });
  } catch (err) {
    console.warn('[export] could not record export history:', err.message);
  }
}

// GET /leads/export/meta — everything the modal needs to build its filters from real data.
exports.meta = async (req, res) => {
  const [sources, providers, runs] = await Promise.all([
    Lead.findAll({ attributes: [[sequelize.fn('DISTINCT', sequelize.col('source')), 'source']], raw: true }),
    LeadSource.findAll({ attributes: [[sequelize.fn('DISTINCT', sequelize.col('provider')), 'provider']], raw: true }),
    SearchRun.findAll({ attributes: ['id', 'started_at', 'status'], order: [['id', 'DESC']], limit: 100, raw: true }),
  ]);
  return ok(res, {
    columns: svc.COLUMNS.map(({ key, header }) => ({ key, header })),
    date_fields: Object.entries(svc.DATE_FIELDS).map(([value, label]) => ({ value, label })),
    enums: svc.ENUMS,
    sources: sources.map((s) => s.source).filter(Boolean).sort(),
    providers: providers.map((p) => p.provider).filter(Boolean).sort(),
    search_runs: runs,
  });
};

// POST /leads/export/preview — exact count the export would produce.
exports.preview = async (req, res) => {
  const parsed = svc.parseExportRequest(req.body);
  const [count, users] = await countAndUsers(parsed);
  return ok(res, { count, columns: parsed.columns.length, summary: svc.describeRequest(parsed, users) });
};

// POST /leads/export — streams the .xlsx. Validation, the empty check and the
// lock all happen before the first byte, so those errors still return JSON.
exports.exportXlsx = async (req, res) => {
  const parsed = svc.parseExportRequest(req.body);
  if (inFlight.has(req.user.id)) throw new ApiError(429, 'An export is already in progress. Please wait for it to finish.');
  inFlight.add(req.user.id);

  try {
    const [count, users] = await countAndUsers(parsed);
    if (count === 0) throw new ApiError(422, 'No leads match the selected filters.');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leads-export-${stamp}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');

    let rows;
    try {
      rows = await svc.writeWorkbook(parsed, res, { users, exportedBy: req.user.name });
    } catch (err) {
      console.error('[export] workbook generation failed:', err);
      await recordExport(req.user, parsed, { status: 'FAILED', row_count: 0, error_message: String(err.message).slice(0, 500) });
      // Once bytes are on the wire a JSON error is impossible — abort so the client sees a failed download.
      if (res.headersSent) return res.destroy(err);
      res.removeHeader('Content-Disposition');
      throw new ApiError(500, 'Could not generate the Excel file. Please try again.');
    }
    await recordExport(req.user, parsed, { status: 'SUCCESS', row_count: rows });
    return undefined;
  } finally {
    inFlight.delete(req.user.id);
  }
};

// GET /leads/export/history — this user's recent exports (metadata only).
exports.history = async (req, res) => {
  const items = await LeadExport.findAll({
    where: { user_id: req.user.id },
    attributes: ['id', 'created_at', 'date_field', 'date_from', 'date_to', 'filters', 'row_count', 'status'],
    order: [['id', 'DESC']],
    limit: 10,
  }).catch(() => []); // table missing before migrate — show no history rather than an error
  return ok(res, { items });
};

exports._inFlight = inFlight; // for tests
