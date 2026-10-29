/**
 * Advanced Excel (.xlsx) lead export.
 *
 * One request shape drives both the preview count and the file, so the number the
 * user sees is computed from exactly the same WHERE clause as the rows exported.
 *
 * Duplicates: the main query only joins belongsTo relations (company, assigned
 * user), which can't multiply rows. One-to-many data (contacts, websites, signals,
 * notes, discovery sources) is loaded per batch with one IN-query each — no N+1,
 * no join fan-out. Batches are keyset-paginated on the primary key (id > lastId),
 * so every matching lead is read exactly once with no LIMIT truncating the export.
 */
const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const {
  sequelize,
  Lead,
  Company,
  User,
  CompanyContact,
  CompanyWebsite,
  DetectedSignal,
  LeadSource,
  Note,
} = require('../models');
const { likeOp } = require('../utils/dialect');
const ApiError = require('../utils/ApiError');

const BATCH_SIZE = 500;
const EXCEL_CELL_MAX = 32767;

const DATE_FIELDS = {
  created_at: 'Lead Created Date',
  updated_at: 'Last Updated Date',
  last_contacted_at: 'Last Contacted Date',
  next_follow_up_at: 'Follow-up Date',
};

const WEBSITE_STATUSES = CompanyWebsite.rawAttributes.status.values;
const PRIORITIES = Lead.rawAttributes.priority.values;

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

// Excel/Sheets formula injection: a cell starting with = + - @ (or tab/CR) can be
// evaluated once the sheet is re-saved as CSV or pasted. Prefix with ' so it stays
// text. Plain phone-like values ("+91 98765 43210", "-5") are left untouched.
function safeText(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v);
  if (s.length > EXCEL_CELL_MAX - 10) s = `${s.slice(0, EXCEL_CELL_MAX - 10)}…`;
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]*$/.test(s))) s = `'${s}`;
  return s;
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const toParts = (fmt, date) => Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));

// Offset (ms) of `timeZone` from UTC at the given instant.
function tzOffsetMs(fmt, utcMs) {
  const p = toParts(fmt, new Date(utcMs));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** UTC instant of 00:00:00 on calendar day `ymd` in `timeZone` (DST-aware). */
function zonedMidnightUtc(ymd, timeZone) {
  const fmt = partsFormatter(timeZone);
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(fmt, guess);
  return new Date(guess - tzOffsetMs(fmt, first));
}

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Date -> "YYYY-MM-DD HH:mm:ss" in the export's timezone. */
function makeDateFormatter(timeZone) {
  const fmt = partsFormatter(timeZone);
  return (v) => {
    if (!v) return null;
    const date = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(date.getTime())) return null;
    const p = toParts(fmt, date);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };
}

/* ------------------------------------------------------------------ */
/* Columns — every one maps to a real stored field                     */
/* ------------------------------------------------------------------ */

// ai_evidence is a JSON list of findings; some MySQL drivers hand it back as a string.
function evidenceText(v) {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return v; }
  }
  return Array.isArray(v) ? v.filter(Boolean).join('; ') : v;
}

// `needs` names the batch-loaded relation a column reads, so unselected relations are never queried.
const COLUMNS = [
  { key: 'lead_id', header: 'Lead ID', width: 9, type: 'number', get: (l) => l.id },
  { key: 'company_name', header: 'Company Name', width: 34, get: (l) => l.company?.company_name },
  { key: 'contact_name', header: 'Contact Person', width: 24, needs: 'contacts', get: (l, x) => x.contacts.find((c) => c.contact_name)?.contact_name },
  { key: 'contact_title', header: 'Contact Job Title', width: 22, needs: 'contacts', get: (l, x) => x.contacts.find((c) => c.contact_name)?.job_title },
  { key: 'website', header: 'Website', width: 32, needs: 'websites', get: (l, x) => l.company?.website || x.websites[0]?.url },
  { key: 'domain', header: 'Domain', width: 24, get: (l) => l.company?.normalized_domain },
  { key: 'email', header: 'Email', width: 30, needs: 'contacts', get: (l, x) => x.emails[0] },
  { key: 'other_emails', header: 'Other Emails', width: 30, needs: 'contacts', get: (l, x) => x.emails.slice(1).join('; ') },
  { key: 'phone', header: 'Phone Number', width: 18, needs: 'contacts', get: (l, x) => x.phones[0] },
  { key: 'alt_phone', header: 'Alternative Phone', width: 18, needs: 'contacts', get: (l, x) => x.phones.slice(1).join('; ') },
  { key: 'linkedin', header: 'Company LinkedIn', width: 30, get: (l) => l.company?.linkedin_url },
  { key: 'city', header: 'City', width: 16, get: (l) => l.company?.city },
  { key: 'state', header: 'State', width: 16, get: (l) => l.company?.state },
  { key: 'address', header: 'Registered Address', width: 36, get: (l) => l.company?.registered_address },
  { key: 'industry', header: 'Industry', width: 22, get: (l) => l.company?.industry },
  { key: 'category', header: 'Business Category', width: 20, get: (l) => l.company?.company_category },
  { key: 'company_type', header: 'Company Type', width: 18, get: (l) => l.company?.company_type },
  { key: 'employees', header: 'Company Size (Employees)', width: 14, type: 'number', get: (l) => l.company?.employee_count },
  { key: 'annual_revenue', header: 'Annual Revenue', width: 16, type: 'number', get: (l) => l.company?.annual_revenue },
  { key: 'founded_year', header: 'Founded Year', width: 12, type: 'number', get: (l) => l.company?.founded_year },
  { key: 'incorporated', header: 'Date of Incorporation', width: 14, get: (l) => l.company?.date_of_incorporation },
  { key: 'cin', header: 'CIN', width: 24, get: (l) => l.company?.cin },
  { key: 'lead_source', header: 'Lead Source', width: 14, get: (l) => l.source },
  { key: 'discovery_providers', header: 'Discovery Providers', width: 22, needs: 'sources', get: (l, x) => x.providers.join('; ') },
  { key: 'search_runs', header: 'Search Run IDs', width: 16, needs: 'sources', get: (l, x) => x.runs.join('; ') },
  { key: 'status', header: 'Pipeline Stage', width: 16, get: (l) => l.status },
  { key: 'contact_status', header: 'Contact Status', width: 16, get: (l) => l.contact_status },
  { key: 'contacted', header: 'Contacted', width: 11, get: (l) => (l.contact_status === 'NOT_CONTACTED' ? 'No' : 'Yes') },
  { key: 'contact_method', header: 'Contact Method', width: 14, get: (l) => l.contact_method },
  { key: 'lead_score', header: 'Lead Score', width: 11, type: 'number', get: (l) => l.lead_score },
  { key: 'lead_temperature', header: 'Lead Temperature', width: 14, get: (l) => l.lead_temperature },
  { key: 'priority', header: 'Lead Priority', width: 12, get: (l) => l.priority },
  { key: 'lead_status', header: 'Qualification Status', width: 16, get: (l) => l.lead_status },
  { key: 'recommended_service', header: 'Recommended Service', width: 26, get: (l) => l.recommended_service },
  { key: 'ai_qualification', header: 'AI Qualification', width: 18, get: (l) => l.ai_qualification_status },
  { key: 'ai_confidence', header: 'AI Confidence', width: 12, type: 'number', get: (l) => l.ai_confidence },
  { key: 'ai_summary', header: 'AI Business Summary', width: 40, get: (l) => l.ai_summary },
  { key: 'ai_problem', header: 'Problem', width: 40, get: (l) => l.ai_problem },
  { key: 'ai_evidence', header: 'Evidence', width: 50, get: (l) => evidenceText(l.ai_evidence) },
  { key: 'ai_sales_angle', header: 'Sales Angle', width: 40, get: (l) => l.ai_sales_angle },
  { key: 'ai_outreach_angle', header: 'AI Outreach Angle', width: 40, get: (l) => l.ai_outreach_angle },
  { key: 'ai_recommended_service', header: 'AI Recommended Service', width: 24, get: (l) => l.ai_recommended_service },
  { key: 'estimated_value', header: 'Estimated Value', width: 14, type: 'number', get: (l) => l.estimated_value },
  { key: 'lost_reason', header: 'Lost Reason', width: 22, get: (l) => l.lost_reason },
  { key: 'created_at', header: 'Created Date', width: 20, type: 'date', get: (l) => l.created_at },
  { key: 'updated_at', header: 'Last Updated Date', width: 20, type: 'date', get: (l) => l.updated_at },
  { key: 'last_contacted_at', header: 'Last Contacted Date', width: 20, type: 'date', get: (l) => l.last_contacted_at },
  { key: 'next_follow_up_at', header: 'Follow-up Date', width: 20, type: 'date', get: (l) => l.next_follow_up_at },
  { key: 'assigned_user', header: 'Assigned User', width: 20, get: (l) => l.assignedUser?.name },
  { key: 'company_description', header: 'Company Description (website)', width: 40, needs: 'websites', get: (l, x) => x.websites[0]?.meta_description },
  { key: 'website_status', header: 'Website Audit Status', width: 16, needs: 'websites', get: (l, x) => x.websites[0]?.status },
  { key: 'website_health', header: 'Website Health', width: 14, needs: 'websites', get: (l, x) => x.websites[0]?.health },
  { key: 'contactability', header: 'Contactability Score', width: 13, type: 'number', get: (l) => l.company?.contactability_score },
  { key: 'signals', header: 'Detected Signals', width: 40, needs: 'signals', get: (l, x) => x.signals.join('; ') },
  { key: 'notes', header: 'Notes', width: 50, needs: 'notes', get: (l, x) => x.notes.join('\n---\n') },
];
const COLUMN_KEYS = COLUMNS.map((c) => c.key);

/* ------------------------------------------------------------------ */
/* Request validation                                                  */
/* ------------------------------------------------------------------ */

const ENUMS = {
  status: Lead.STATUSES,
  contact_status: Lead.CONTACT_STATUSES,
  lead_status: Lead.LEAD_QUALIFICATION_STATUSES,
  lead_temperature: Lead.LEAD_TEMPERATURES,
  priority: PRIORITIES,
  ai_qualification_status: Lead.AI_QUALIFICATION_STATUSES,
  website_status: WEBSITE_STATUSES,
  signal_types: DetectedSignal.SIGNAL_TYPES,
};
const TEXT_FILTERS = ['company_name', 'website', 'email', 'phone', 'city', 'state', 'industry', 'category', 'provider'];
const LIST_FILTERS = ['source', ...Object.keys(ENUMS)];
const INT_FILTERS = { min_score: [0, 100], max_score: [0, 100], employees_min: [0, 1e9], employees_max: [0, 1e9], search_run_id: [1, 2 ** 31] };
const CHOICE_FILTERS = { contacted: ['yes', 'no'], has_website: ['yes', 'no'], follow_up: ['due', 'scheduled', 'none'] };

/**
 * Validates and normalizes the export request body. Throws ApiError(400) listing
 * every problem. Unknown filter keys are rejected rather than silently ignored.
 */
function parseExportRequest(body = {}) {
  const errors = [];
  const out = { filters: {} };

  // ---- dates ----
  const { date_from: from, date_to: to } = body;
  out.dateField = body.date_field || 'created_at';
  if (!DATE_FIELDS[out.dateField]) errors.push({ field: 'date_field', message: `must be one of ${Object.keys(DATE_FIELDS).join(', ')}` });
  out.timezone = body.timezone || 'UTC';
  if (!isValidTimeZone(out.timezone)) errors.push({ field: 'timezone', message: 'is not a valid IANA timezone' });
  if (from || to) {
    if (!from || !to) errors.push({ field: 'date_range', message: 'both start and end date are required (or neither, for all time)' });
    else if (!isValidYmd(from) || !isValidYmd(to)) errors.push({ field: 'date_range', message: 'dates must be valid YYYY-MM-DD' });
    else if (from > to) errors.push({ field: 'date_range', message: 'start date cannot be later than end date' });
    else {
      out.dateFrom = from;
      out.dateTo = to;
    }
  }

  // ---- filters ----
  const f = body.filters || {};
  if (typeof f !== 'object' || Array.isArray(f)) errors.push({ field: 'filters', message: 'must be an object' });
  const known = new Set([...TEXT_FILTERS, ...LIST_FILTERS, ...Object.keys(INT_FILTERS), ...Object.keys(CHOICE_FILTERS), 'assigned_user_id']);
  for (const [k, v] of Object.entries(f)) {
    if (!known.has(k)) {
      errors.push({ field: `filters.${k}`, message: 'unknown filter' });
      continue;
    }
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;

    if (TEXT_FILTERS.includes(k)) {
      if (typeof v !== 'string' || v.trim().length > 200) errors.push({ field: `filters.${k}`, message: 'must be text up to 200 characters' });
      else if (v.trim()) out.filters[k] = v.trim();
    } else if (LIST_FILTERS.includes(k)) {
      const arr = Array.isArray(v) ? v : [v];
      const allowed = ENUMS[k];
      const bad = arr.filter((x) => typeof x !== 'string' || x.length > 40 || (allowed && !allowed.includes(x)));
      if (bad.length) errors.push({ field: `filters.${k}`, message: `invalid value(s): ${bad.join(', ')}` });
      else out.filters[k] = [...new Set(arr)];
    } else if (INT_FILTERS[k]) {
      const n = Number(v);
      const [lo, hi] = INT_FILTERS[k];
      if (!Number.isInteger(n) || n < lo || n > hi) errors.push({ field: `filters.${k}`, message: `must be a whole number between ${lo} and ${hi}` });
      else out.filters[k] = n;
    } else if (CHOICE_FILTERS[k]) {
      if (!CHOICE_FILTERS[k].includes(v)) errors.push({ field: `filters.${k}`, message: `must be one of ${CHOICE_FILTERS[k].join(', ')}` });
      else out.filters[k] = v;
    } else if (k === 'assigned_user_id') {
      if (v === 'unassigned') out.filters[k] = v;
      else if (!Number.isInteger(Number(v)) || Number(v) < 1) errors.push({ field: 'filters.assigned_user_id', message: 'must be a user id or "unassigned"' });
      else out.filters[k] = Number(v);
    }
  }
  const { min_score: lo, max_score: hi, employees_min: emin, employees_max: emax } = out.filters;
  if (lo !== undefined && hi !== undefined && lo > hi) errors.push({ field: 'filters.min_score', message: 'minimum score cannot exceed maximum score' });
  if (emin !== undefined && emax !== undefined && emin > emax) errors.push({ field: 'filters.employees_min', message: 'minimum size cannot exceed maximum size' });

  // ---- columns ----
  if (body.columns === undefined) out.columns = COLUMN_KEYS;
  else if (!Array.isArray(body.columns) || !body.columns.length) errors.push({ field: 'columns', message: 'select at least one column' });
  else {
    const bad = body.columns.filter((c) => !COLUMN_KEYS.includes(c));
    if (bad.length) errors.push({ field: 'columns', message: `unknown column(s): ${bad.join(', ')}` });
    // Keep the canonical column order regardless of the order sent.
    out.columns = COLUMN_KEYS.filter((k) => body.columns.includes(k));
  }

  if (errors.length) throw ApiError.badRequest(errors.map((e) => `${e.field} ${e.message}`).join('; '), errors);
  return out;
}

/* ------------------------------------------------------------------ */
/* Query building — shared by count and export                         */
/* ------------------------------------------------------------------ */

// `company_id IN (subquery)` — every user value is escaped by the driver's own
// escaper; identifiers are fixed strings. Lower-case table/column names are valid
// unquoted in MySQL, Postgres and SQLite.
const inSub = (sql) => ({ company_id: { [Op.in]: sequelize.literal(`(${sql})`) } });
const esc = (v) => sequelize.escape(v);
const containsLower = (v) => esc(`%${String(v).toLowerCase()}%`);
const listSql = (arr) => arr.map(esc).join(', ');

function utcRange(req) {
  if (!req.dateFrom) return null;
  return { from: zonedMidnightUtc(req.dateFrom, req.timezone), toExclusive: zonedMidnightUtc(addDays(req.dateTo, 1), req.timezone) };
}

function buildQuery(req) {
  const f = req.filters;
  const and = [];
  const cw = {};
  const cand = [];
  const like = (v) => ({ [likeOp]: `%${v}%` });

  const range = utcRange(req);
  // Half-open [start-of-day, start-of-next-day) in the user's timezone — includes
  // every record on the end date whatever its time, and nothing from the day after.
  if (range) and.push({ [req.dateField]: { [Op.gte]: range.from, [Op.lt]: range.toExclusive } });

  if (f.status) and.push({ status: { [Op.in]: f.status } });
  if (f.contact_status) and.push({ contact_status: { [Op.in]: f.contact_status } });
  if (f.lead_status) and.push({ lead_status: { [Op.in]: f.lead_status } });
  if (f.lead_temperature) and.push({ lead_temperature: { [Op.in]: f.lead_temperature } });
  if (f.priority) and.push({ priority: { [Op.in]: f.priority } });
  if (f.ai_qualification_status) and.push({ ai_qualification_status: { [Op.in]: f.ai_qualification_status } });
  if (f.source) and.push({ source: { [Op.in]: f.source } });
  if (f.contacted === 'yes') and.push({ contact_status: { [Op.ne]: 'NOT_CONTACTED' } });
  if (f.contacted === 'no') and.push({ contact_status: 'NOT_CONTACTED' });
  if (f.assigned_user_id === 'unassigned') and.push({ assigned_user_id: null });
  else if (f.assigned_user_id) and.push({ assigned_user_id: f.assigned_user_id });
  if (f.min_score !== undefined) and.push({ lead_score: { [Op.gte]: f.min_score } });
  if (f.max_score !== undefined) and.push({ lead_score: { [Op.lte]: f.max_score } });

  const now = new Date();
  if (f.follow_up === 'due') and.push({ next_follow_up_at: { [Op.lte]: now } });
  if (f.follow_up === 'scheduled') and.push({ next_follow_up_at: { [Op.gt]: now } });
  if (f.follow_up === 'none') and.push({ next_follow_up_at: null });

  // Company-level fields (belongsTo — filtering here never duplicates rows).
  if (f.company_name) cand.push({ company_name: like(f.company_name) });
  if (f.city) cand.push({ city: like(f.city) });
  if (f.state) cand.push({ state: like(f.state) });
  if (f.industry) cand.push({ industry: like(f.industry) });
  if (f.category) cand.push({ company_category: like(f.category) });
  if (f.website) cand.push({ [Op.or]: [{ website: like(f.website) }, { normalized_domain: like(f.website.toLowerCase()) }] });
  if (f.has_website) cand.push({ has_website: f.has_website === 'yes' });
  if (f.employees_min !== undefined) cand.push({ employee_count: { [Op.gte]: f.employees_min } });
  if (f.employees_max !== undefined) cand.push({ employee_count: { [Op.lte]: f.employees_max } });
  if (cand.length) cw[Op.and] = cand;

  // One-to-many relations: semi-join subqueries, so a lead with 3 matching
  // contacts still appears once.
  if (f.email) and.push(inSub(`SELECT company_id FROM company_contacts WHERE type = 'email' AND LOWER(value) LIKE ${containsLower(f.email)}`));
  if (f.phone) and.push(inSub(`SELECT company_id FROM company_contacts WHERE type = 'phone' AND LOWER(value) LIKE ${containsLower(f.phone)}`));
  if (f.website_status) and.push(inSub(`SELECT company_id FROM company_websites WHERE status IN (${listSql(f.website_status)})`));
  if (f.signal_types) and.push(inSub(`SELECT company_id FROM detected_signals WHERE signal_type IN (${listSql(f.signal_types)})`));
  if (f.provider) and.push(inSub(`SELECT company_id FROM lead_sources WHERE LOWER(provider) LIKE ${containsLower(f.provider)}`));
  if (f.search_run_id) and.push(inSub(`SELECT company_id FROM lead_sources WHERE search_run_id = ${esc(f.search_run_id)}`));

  return { where: and.length ? { [Op.and]: and } : {}, companyWhere: cand.length ? cw : null };
}

const companyInclude = (companyWhere, attributes) => ({
  model: Company,
  as: 'company',
  required: true, // company_id is NOT NULL; inner join keeps count and export identical
  ...(attributes ? { attributes } : {}),
  ...(companyWhere ? { where: companyWhere } : {}),
});

async function countMatching(req) {
  const { where, companyWhere } = buildQuery(req);
  return Lead.count({ where, include: [companyInclude(companyWhere, [])], distinct: true, col: 'id' });
}

/* ------------------------------------------------------------------ */
/* Human-readable summary (UI preview + Export Info sheet)             */
/* ------------------------------------------------------------------ */

function describeRequest(req, users = {}) {
  const fmtDay = (ymd) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  const dateRange = req.dateFrom ? `${fmtDay(req.dateFrom)} – ${fmtDay(req.dateTo)}` : 'All time';
  const labels = {
    company_name: 'Company', website: 'Website', email: 'Email', phone: 'Phone', city: 'City', state: 'State',
    industry: 'Industry', category: 'Category', provider: 'Discovery provider', source: 'Lead source',
    status: 'Pipeline stage', contact_status: 'Contact status', lead_status: 'Qualification',
    lead_temperature: 'Temperature', priority: 'Priority', ai_qualification_status: 'AI qualification',
    website_status: 'Website status', signal_types: 'Signals', search_run_id: 'Search run',
    contacted: 'Contacted', has_website: 'Has website', follow_up: 'Follow-up',
  };
  const parts = [];
  for (const [k, v] of Object.entries(req.filters)) {
    if (k === 'min_score') parts.push(`Score >= ${v}`);
    else if (k === 'max_score') parts.push(`Score <= ${v}`);
    else if (k === 'employees_min') parts.push(`Employees >= ${v}`);
    else if (k === 'employees_max') parts.push(`Employees <= ${v}`);
    else if (k === 'assigned_user_id') parts.push(`Assigned: ${v === 'unassigned' ? 'Unassigned' : users[v] || `user #${v}`}`);
    else parts.push(`${labels[k]}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return { dateField: DATE_FIELDS[req.dateField], dateRange, filters: parts };
}

/* ------------------------------------------------------------------ */
/* Workbook streaming                                                  */
/* ------------------------------------------------------------------ */

async function loadRelations(leads, needs) {
  const leadIds = leads.map((l) => l.id);
  const companyIds = [...new Set(leads.map((l) => l.company_id))];
  const by = (rows, key = 'company_id') => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r[key])) m.set(r[key], []);
      m.get(r[key]).push(r);
    }
    return m;
  };

  const [contacts, websites, signals, sources, notes] = await Promise.all([
    needs.has('contacts')
      ? CompanyContact.findAll({ where: { company_id: companyIds }, attributes: ['company_id', 'type', 'value', 'contact_name', 'job_title', 'is_primary'], order: [['is_primary', 'DESC'], ['id', 'ASC']], raw: true })
      : [],
    needs.has('websites')
      ? CompanyWebsite.findAll({ where: { company_id: companyIds }, attributes: ['company_id', 'url', 'status', 'health', 'meta_description'], order: [['id', 'ASC']], raw: true })
      : [],
    needs.has('signals')
      ? DetectedSignal.findAll({ where: { company_id: companyIds }, attributes: ['company_id', 'signal_type', 'signal_strength'], order: [['id', 'ASC']], raw: true })
      : [],
    needs.has('sources')
      ? LeadSource.findAll({ where: { company_id: companyIds }, attributes: ['company_id', 'provider', 'search_run_id'], order: [['id', 'ASC']], raw: true })
      : [],
    needs.has('notes')
      ? Note.findAll({
          where: { [Op.or]: [{ lead_id: leadIds }, { lead_id: null, company_id: companyIds }] },
          attributes: ['lead_id', 'company_id', 'body', 'created_at'],
          order: [['created_at', 'ASC'], ['id', 'ASC']],
          raw: true,
        })
      : [],
  ]);

  const maps = { contacts: by(contacts), websites: by(websites), signals: by(signals), sources: by(sources), leadNotes: by(notes.filter((n) => n.lead_id), 'lead_id'), companyNotes: by(notes.filter((n) => !n.lead_id)) };
  return (lead) => {
    const cs = maps.contacts.get(lead.company_id) || [];
    const src = maps.sources.get(lead.company_id) || [];
    const uniq = (a) => [...new Set(a.filter((x) => x !== null && x !== undefined))];
    return {
      contacts: cs,
      emails: uniq(cs.filter((c) => c.type === 'email').map((c) => c.value)),
      phones: uniq(cs.filter((c) => c.type === 'phone').map((c) => c.value)),
      websites: maps.websites.get(lead.company_id) || [],
      signals: uniq((maps.signals.get(lead.company_id) || []).map((s) => `${s.signal_type} (${s.signal_strength})`)),
      providers: uniq(src.map((s) => s.provider)),
      runs: uniq(src.map((s) => s.search_run_id)),
      notes: [...(maps.leadNotes.get(lead.id) || []), ...(maps.companyNotes.get(lead.company_id) || [])].map((n) => n.body),
    };
  };
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };

/**
 * Streams the workbook to `stream`. Returns the number of lead rows written.
 * `users` maps user id -> name (only used for the Export Info summary).
 */
async function writeWorkbook(req, stream, { users = {}, exportedBy, now = new Date() } = {}) {
  const cols = COLUMNS.filter((c) => req.columns.includes(c.key));
  const needs = new Set(cols.map((c) => c.needs).filter(Boolean));
  const fmtDate = makeDateFormatter(req.timezone);
  const { where, companyWhere } = buildQuery(req);

  // Keyset pagination: stable, gap-free and duplicate-free even if leads are added mid-export.
  const fetchBatch = async (lastId) => {
    const leads = await Lead.findAll({
      where: { [Op.and]: [where, { id: { [Op.gt]: lastId } }] },
      include: [companyInclude(companyWhere), { model: User, as: 'assignedUser', attributes: ['id', 'name'] }],
      order: [['id', 'ASC']],
      limit: BATCH_SIZE,
    });
    const related = leads.length && needs.size ? await loadRelations(leads, needs) : () => ({});
    return { leads, related };
  };
  // Load the first batch before the writer emits any bytes, so a DB error here
  // still reaches the client as a JSON error instead of a truncated file.
  let batch = await fetchBatch(0);

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true, useSharedStrings: false });
  wb.creator = 'LeadHunter CRM';
  wb.created = now;

  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width,
    // '@' = Text format, so identifiers like phones/CINs keep leading zeros even if edited.
    style: c.type === 'number' ? {} : { numFmt: '@' },
  }));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  header.commit();

  let written = 0;
  for (;;) {
    const { leads, related } = batch;
    if (!leads.length) break;
    for (const lead of leads) {
      const x = related(lead);
      const values = {};
      for (const c of cols) {
        const raw = c.get(lead, x);
        values[c.key] = c.type === 'number' ? num(raw) : c.type === 'date' ? fmtDate(raw) : safeText(raw);
      }
      ws.addRow(values).commit();
      written += 1;
    }
    if (leads.length < BATCH_SIZE) break;
    batch = await fetchBatch(leads[leads.length - 1].id);
  }
  ws.commit();

  const summary = describeRequest(req, users);
  const range = utcRange(req);
  const info = wb.addWorksheet('Export Info');
  info.columns = [{ header: 'Field', key: 'k', width: 26 }, { header: 'Value', key: 'v', width: 70 }];
  const infoHeader = info.getRow(1);
  infoHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  infoHeader.fill = HEADER_FILL;
  infoHeader.commit();
  const infoRows = [
    ['Exported At', `${fmtDate(now)} (${req.timezone})`],
    ['Exported By', exportedBy || ''],
    ['Date Field', summary.dateField],
    ['Date Range', summary.dateRange],
    ['Date Range (UTC)', range ? `${range.from.toISOString()} to before ${range.toExclusive.toISOString()}` : 'No date restriction'],
    ['Timezone', req.timezone],
    ['Applied Filters', summary.filters.length ? summary.filters.join('; ') : 'None'],
    ['Total Leads Exported', written],
    ['Columns', cols.map((c) => c.header).join(', ')],
    ['Date Format', 'YYYY-MM-DD HH:mm:ss in the timezone above'],
  ];
  for (const [k, v] of infoRows) info.addRow({ k, v: typeof v === 'number' ? v : safeText(v) }).commit();
  info.commit();

  await wb.commit();
  return written;
}

module.exports = {
  DATE_FIELDS,
  COLUMNS,
  COLUMN_KEYS,
  ENUMS,
  BATCH_SIZE,
  parseExportRequest,
  buildQuery,
  countMatching,
  describeRequest,
  writeWorkbook,
  safeText,
  zonedMidnightUtc,
  utcRange,
};
