/**
 * Client & Project Finance. All money math is done in integer paise (DECIMAL(14,2) in the
 * DB, never floats in arithmetic), and every total is derived from project_payments rows
 * with voided_at IS NULL — nothing is cached, so a payment can never be counted twice and
 * an invoice status never counts as money received.
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const ExcelJS = require('exceljs');
const { sequelize, Client, ClientProject, ProjectPayment, ProjectInvoice, ClientDocument } = require('../models');
const ApiError = require('../utils/ApiError');
const { likeOp } = require('../utils/dialect');

/* ---------------- money + input helpers ---------------- */

const MAX_PAISE = 999999999999; // DECIMAL(14,2)

/** "12,500.50" | 12500.5 -> 1250050 paise. Rejects more than 2 decimals, negatives and junk. */
function toPaise(v, field, { allowZero = false } = {}) {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw ApiError.badRequest(`${field} must be a positive amount with at most 2 decimals`);
  const [whole, frac = ''] = s.split('.');
  const p = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(p) || p > MAX_PAISE) throw ApiError.badRequest(`${field} is too large`);
  if (!allowZero && p === 0) throw ApiError.badRequest(`${field} must be greater than zero`);
  return p;
}
const paise = (dbValue) => Math.round(Number(dbValue || 0) * 100); // DB DECIMAL (string or number) -> paise
const rupees = (p) => (p / 100).toFixed(2); // paise -> "1234.50" for DECIMAL columns + API
const num = (p) => p / 100; // paise -> number for charts

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateOnly(v, field, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw ApiError.badRequest(`${field} is required`);
    return null;
  }
  const s = String(v).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw ApiError.badRequest(`${field} must be a date (YYYY-MM-DD)`);
  return s;
}
function text(v, field, max, { required = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) {
    if (required) throw ApiError.badRequest(`${field} is required`);
    return null;
  }
  if (s.length > max) throw ApiError.badRequest(`${field} must be at most ${max} characters`);
  return s;
}
function oneOf(v, field, list, fallback) {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (!list.includes(v)) throw ApiError.badRequest(`${field} must be one of: ${list.join(', ')}`);
  return v;
}
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- validation per entity (partial = update) ---------------- */

function clientFields(b, partial) {
  const out = {};
  if (!partial || has(b, 'name')) out.name = text(b.name, 'Client name', 160, { required: true });
  if (has(b, 'company_name')) out.company_name = text(b.company_name, 'Company name', 200);
  if (has(b, 'contact_person')) out.contact_person = text(b.contact_person, 'Contact person', 160);
  if (has(b, 'email')) {
    out.email = text(b.email, 'Email', 190);
    if (out.email && !EMAIL_RE.test(out.email)) throw ApiError.badRequest('Email must be a valid email address');
  }
  if (has(b, 'phone')) out.phone = text(b.phone, 'Phone', 40);
  if (has(b, 'address')) out.address = text(b.address, 'Address', 2000);
  if (has(b, 'notes')) out.notes = text(b.notes, 'Notes', 5000);
  return out;
}

function projectFields(b, partial) {
  const out = {};
  if (!partial || has(b, 'name')) out.name = text(b.name, 'Project name', 200, { required: true });
  if (has(b, 'description')) out.description = text(b.description, 'Description', 5000);
  if (has(b, 'notes')) out.notes = text(b.notes, 'Notes', 5000);
  for (const k of ['start_date', 'expected_delivery_date', 'actual_completion_date']) if (has(b, k)) out[k] = dateOnly(b[k], k);
  if (!partial || has(b, 'project_value')) out.project_value = rupees(toPaise(b.project_value ?? 0, 'Project value', { allowZero: true }));
  if (!partial || has(b, 'status')) out.status = oneOf(b.status, 'Status', ClientProject.STATUSES, partial ? undefined : 'INQUIRY');
  return out;
}

function paymentFields(b, partial) {
  const out = {};
  if (!partial || has(b, 'payment_date')) out.payment_date = dateOnly(b.payment_date, 'Payment date', { required: true });
  if (out.payment_date && out.payment_date > today()) throw ApiError.badRequest('Payment date cannot be in the future');
  if (!partial || has(b, 'amount')) out.amount = rupees(toPaise(b.amount, 'Amount'));
  if (!partial || has(b, 'payment_type')) out.payment_type = oneOf(b.payment_type, 'Payment type', ProjectPayment.TYPES);
  if (!partial || has(b, 'payment_method')) out.payment_method = oneOf(b.payment_method, 'Payment method', ProjectPayment.METHODS);
  if (has(b, 'transaction_reference')) out.transaction_reference = text(b.transaction_reference, 'Transaction reference', 120);
  if (has(b, 'notes')) out.notes = text(b.notes, 'Notes', 5000);
  return out;
}

function invoiceFields(b, partial) {
  const out = {};
  if (!partial || has(b, 'invoice_number')) out.invoice_number = text(b.invoice_number, 'Invoice number', 60, { required: true });
  if (!partial || has(b, 'invoice_date')) out.invoice_date = dateOnly(b.invoice_date, 'Invoice date', { required: true });
  if (has(b, 'due_date')) out.due_date = dateOnly(b.due_date, 'Due date');
  if (!partial || has(b, 'amount')) out.amount = rupees(toPaise(b.amount, 'Invoice amount'));
  if (!partial || has(b, 'tax_amount')) out.tax_amount = rupees(toPaise(b.tax_amount || 0, 'GST / Tax', { allowZero: true }));
  if (!partial || has(b, 'status')) out.status = oneOf(b.status, 'Invoice status', ProjectInvoice.STATUSES, partial ? undefined : 'DRAFT');
  if (has(b, 'notes')) out.notes = text(b.notes, 'Notes', 5000);
  return out;
}

/* ---------------- files ---------------- */

const MAX_FILE_BYTES = 5 * 1024 * 1024; // stays under TiDB's 6 MB transaction entry limit
// Magic bytes, not the browser's claimed type: what we serve back is what we checked.
const SIGNATURES = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

function checkFile(file, { pdfOnly = false } = {}) {
  if (!file?.buffer?.length) throw ApiError.badRequest('The uploaded file is empty');
  if (file.buffer.length > MAX_FILE_BYTES) throw ApiError.badRequest('Files must be 5 MB or smaller');
  const sig = SIGNATURES.find((s) => s.test(file.buffer));
  if (!sig || (pdfOnly && sig.mime !== 'application/pdf')) throw ApiError.badRequest(pdfOnly ? 'Invoice attachments must be PDF files' : 'Only PDF, PNG, JPG or WEBP files are allowed');
  const base = String(file.originalname || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\.[^.]*$/, '').slice(0, 150) || 'file';
  return { mime_type: sig.mime, file_name: `${base}.${sig.ext}`, size_bytes: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), data: file.buffer };
}

async function storeFile(file, link, user, transaction, opts) {
  const f = checkFile(file, opts);
  const doc = await ClientDocument.create({ ...link, ...f, uploaded_by_user_id: user.id }, { transaction });
  delete doc.dataValues.data;
  return doc;
}

/* ---------------- totals ---------------- */

/** { [project_id]: { received, deposits, count } } in paise, valid payments only. */
async function paymentTotals(where = {}) {
  const rows = await ProjectPayment.findAll({ where: { ...where, voided_at: null }, attributes: ['project_id', 'amount', 'payment_type'], raw: true });
  const out = {};
  for (const r of rows) {
    const t = (out[r.project_id] ||= { received: 0, deposits: 0, count: 0 });
    t.received += paise(r.amount);
    if (r.payment_type === 'ADVANCE_DEPOSIT') t.deposits += paise(r.amount);
    t.count += 1;
  }
  return out;
}

/** Project as JSON + its derived money figures. */
function withTotals(project, totals) {
  const p = project.get ? project.get({ plain: true }) : project;
  const t = totals[p.id] || { received: 0, deposits: 0, count: 0 };
  const value = paise(p.project_value);
  return {
    ...p,
    total_received: rupees(t.received),
    total_deposits: rupees(t.deposits),
    remaining_balance: rupees(Math.max(0, value - t.received)),
    completion_percent: value ? Math.min(100, Math.round((t.received / value) * 1000) / 10) : t.received ? 100 : 0,
    payments_count: t.count,
  };
}

/** Sum of valid payments on a project, read inside `transaction` (with the project row locked). */
async function receivedOn(projectId, transaction, exceptPaymentId) {
  const rows = await ProjectPayment.findAll({
    where: { project_id: projectId, voided_at: null, ...(exceptPaymentId ? { id: { [Op.ne]: exceptPaymentId } } : {}) },
    attributes: ['amount'],
    raw: true,
    transaction,
  });
  return rows.reduce((s, r) => s + paise(r.amount), 0);
}

const lockProject = (id, transaction) =>
  ClientProject.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE }).then((p) => {
    if (!p) throw ApiError.notFound('Project not found');
    return p;
  });

/* ---------------- clients ---------------- */

async function loadClient(id) {
  const c = await Client.findByPk(id);
  if (!c) throw ApiError.notFound('Client not found');
  return c;
}

async function listClients({ search, archived } = {}) {
  const where = { archived_at: archived === 'true' ? { [Op.ne]: null } : archived === 'all' ? undefined : null };
  if (where.archived_at === undefined) delete where.archived_at;
  if (search) {
    const q = `%${String(search).trim()}%`;
    where[Op.or] = ['name', 'company_name', 'contact_person', 'email', 'phone'].map((f) => ({ [f]: { [likeOp]: q } }));
  }
  const clients = await Client.findAll({ where, order: [['created_at', 'DESC']], limit: 500 });
  const ids = clients.map((c) => c.id);
  const [projects, totals] = ids.length
    ? await Promise.all([ClientProject.findAll({ where: { client_id: { [Op.in]: ids } }, raw: true }), paymentTotals({ client_id: { [Op.in]: ids } })])
    : [[], {}];
  return clients.map((c) => {
    const mine = projects.filter((p) => p.client_id === c.id).map((p) => withTotals(p, totals));
    const live = mine.filter((p) => p.status !== 'CANCELLED');
    const sum = (k, list = mine) => rupees(list.reduce((s, p) => s + paise(p[k]), 0));
    return { ...c.get({ plain: true }), projects_count: mine.length, total_value: sum('project_value', live), total_received: sum('total_received'), remaining_balance: sum('remaining_balance', live) };
  });
}

/** Everything for the client profile: projects with totals, payments, invoices, documents, timeline. */
async function clientProfile(id) {
  const client = await loadClient(id);
  const [projects, payments, invoices, documents, totals] = await Promise.all([
    ClientProject.findAll({ where: { client_id: id }, order: [['created_at', 'DESC']] }),
    ProjectPayment.findAll({ where: { client_id: id }, include: [{ model: ClientProject, as: 'project', attributes: ['id', 'name'] }, { model: ClientDocument, as: 'documents' }], order: [['payment_date', 'DESC'], ['id', 'DESC']] }),
    ProjectInvoice.findAll({ where: { client_id: id }, include: [{ model: ClientProject, as: 'project', attributes: ['id', 'name'] }, { model: ClientDocument, as: 'documents' }], order: [['invoice_date', 'DESC'], ['id', 'DESC']] }),
    ClientDocument.findAll({ where: { client_id: id }, order: [['created_at', 'DESC']] }),
    paymentTotals({ client_id: id }),
  ]);
  const projectRows = projects.map((p) => withTotals(p, totals));
  const live = projectRows.filter((p) => p.status !== 'CANCELLED');
  const sum = (list, k) => rupees(list.reduce((s, p) => s + paise(p[k]), 0));
  const timeline = [
    { date: client.created_at, type: 'client', title: 'Client added' },
    ...projects.map((p) => ({ date: p.start_date || p.created_at, type: 'project', title: `Project: ${p.name}`, detail: p.status, amount: p.project_value })),
    ...payments.map((p) => ({ date: p.payment_date, type: p.voided_at ? 'payment_void' : 'payment', title: p.voided_at ? 'Payment voided' : 'Payment received', detail: `${p.payment_type} · ${p.payment_method} · ${p.project?.name || ''}`, amount: p.amount })),
    ...invoices.map((i) => ({ date: i.invoice_date, type: 'invoice', title: `Invoice ${i.invoice_number}`, detail: i.status, amount: i.total_amount })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)) || 0);
  return {
    client,
    summary: {
      projects: projectRows.length,
      total_value: sum(live, 'project_value'),
      total_received: sum(projectRows, 'total_received'),
      total_deposits: sum(projectRows, 'total_deposits'),
      remaining_balance: sum(live, 'remaining_balance'),
      invoiced: rupees(invoices.filter((i) => i.status !== 'CANCELLED').reduce((s, i) => s + paise(i.total_amount), 0)),
    },
    projects: projectRows,
    payments,
    invoices,
    documents,
    timeline: timeline.map((t) => ({ ...t, date: typeof t.date === 'string' ? t.date : new Date(t.date).toISOString() })),
  };
}

/* ---------------- projects ---------------- */

async function listProjects({ client_id, status, search } = {}) {
  const where = {};
  if (client_id) where.client_id = Number(client_id);
  if (status) where.status = status;
  if (search) where.name = { [likeOp]: `%${String(search).trim()}%` };
  const projects = await ClientProject.findAll({ where, include: [{ model: Client, as: 'client', attributes: ['id', 'name', 'company_name', 'archived_at'] }], order: [['created_at', 'DESC']], limit: 1000 });
  const totals = await paymentTotals(projects.length ? { project_id: { [Op.in]: projects.map((p) => p.id) } } : { id: -1 });
  return projects.map((p) => withTotals(p, totals));
}

async function getProject(id) {
  const p = await ClientProject.findByPk(id, { include: [{ model: Client, as: 'client', attributes: ['id', 'name', 'company_name'] }] });
  if (!p) throw ApiError.notFound('Project not found');
  return withTotals(p, await paymentTotals({ project_id: p.id }));
}

/** Update a project; its value may never drop below what has already been received. */
async function updateProject(id, body) {
  const fields = projectFields(body, true);
  return sequelize.transaction(async (transaction) => {
    const project = await lockProject(id, transaction);
    const before = project.get({ clone: true });
    if (fields.project_value !== undefined) {
      const received = await receivedOn(project.id, transaction);
      if (toPaise(fields.project_value, 'Project value', { allowZero: true }) < received) throw ApiError.badRequest(`Project value cannot be less than the ${rupees(received)} already received`);
    }
    await project.update(fields, { transaction });
    return { project, before };
  });
}

/* ---------------- payments ---------------- */

/**
 * Record a received payment. In one transaction with the project row locked:
 * the project must belong to the client, the payment may not push received past the
 * project value, and the same transaction reference (or the same project/date/amount)
 * can't be recorded twice unless the admin explicitly confirms a genuine repeat.
 */
async function createPayment(body, file, user) {
  const fields = paymentFields(body, false);
  return sequelize.transaction(async (transaction) => {
    const project = await lockProject(Number(body.project_id), transaction);
    if (body.client_id && Number(body.client_id) !== project.client_id) throw ApiError.badRequest('That project does not belong to the selected client');
    if (project.status === 'CANCELLED') throw ApiError.badRequest('Payments cannot be recorded on a cancelled project');
    await guardPayment(project, fields, transaction, null, body.confirm_duplicate === true || body.confirm_duplicate === 'true');
    const payment = await ProjectPayment.create({ ...fields, project_id: project.id, client_id: project.client_id, created_by_user_id: user.id }, { transaction });
    const receipt = file ? await storeFile(file, { client_id: project.client_id, project_id: project.id, payment_id: payment.id, kind: 'RECEIPT' }, user, transaction) : null;
    return { payment, receipt };
  });
}

async function guardPayment(project, fields, transaction, paymentId, confirmDuplicate) {
  const received = await receivedOn(project.id, transaction, paymentId);
  const value = paise(project.project_value);
  if (received + paise(fields.amount) > value) {
    throw ApiError.badRequest(`This payment exceeds the remaining balance (${rupees(Math.max(0, value - received))}). Increase the project value first if the scope grew.`);
  }
  const notMe = paymentId ? { id: { [Op.ne]: paymentId } } : {};
  if (fields.transaction_reference) {
    const dup = await ProjectPayment.findOne({ where: { transaction_reference: fields.transaction_reference, voided_at: null, ...notMe }, transaction });
    if (dup) throw ApiError.conflict(`Transaction reference ${fields.transaction_reference} is already recorded (payment #${dup.id})`);
  }
  if (!confirmDuplicate) {
    const same = await ProjectPayment.findOne({ where: { project_id: project.id, payment_date: fields.payment_date, amount: fields.amount, voided_at: null, ...notMe }, transaction });
    if (same) throw new ApiError(409, `A payment of ${fields.amount} on ${fields.payment_date} is already recorded for this project. Confirm if this is a separate payment.`, { duplicate_of: same.id, needs_confirmation: true });
  }
}

async function updatePayment(id, body, file, user) {
  const fields = paymentFields(body, true);
  return sequelize.transaction(async (transaction) => {
    const payment = await ProjectPayment.findByPk(id, { transaction });
    if (!payment) throw ApiError.notFound('Payment not found');
    if (payment.voided_at) throw ApiError.conflict('A voided payment cannot be edited');
    const project = await lockProject(payment.project_id, transaction);
    const before = payment.get({ clone: true });
    const next = { ...before, ...fields };
    await guardPayment(project, next, transaction, payment.id, true);
    await payment.update(fields, { transaction });
    const receipt = file ? await storeFile(file, { client_id: payment.client_id, project_id: payment.project_id, payment_id: payment.id, kind: 'RECEIPT' }, user, transaction) : null;
    return { payment, before, receipt };
  });
}

async function voidPayment(id, reason) {
  const why = text(reason, 'Reason', 300, { required: true });
  const payment = await ProjectPayment.findByPk(id);
  if (!payment) throw ApiError.notFound('Payment not found');
  if (payment.voided_at) throw ApiError.conflict('Payment is already voided');
  await payment.update({ voided_at: new Date(), void_reason: why });
  return payment;
}

async function listPayments({ client_id, project_id, from, to, type, method, include_void } = {}) {
  const where = {};
  if (client_id) where.client_id = Number(client_id);
  if (project_id) where.project_id = Number(project_id);
  if (type) where.payment_type = type;
  if (method) where.payment_method = method;
  if (include_void !== 'true') where.voided_at = null;
  const f = dateOnly(from, 'from');
  const t = dateOnly(to, 'to');
  if (f || t) where.payment_date = { ...(f ? { [Op.gte]: f } : {}), ...(t ? { [Op.lte]: t } : {}) };
  return ProjectPayment.findAll({
    where,
    include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }, { model: ClientProject, as: 'project', attributes: ['id', 'name'] }, { model: ClientDocument, as: 'documents' }],
    order: [['payment_date', 'DESC'], ['id', 'DESC']],
    limit: 2000,
  });
}

/* ---------------- invoices ---------------- */

async function invoiceLinks(body, current = {}) {
  const clientId = Number(body.client_id ?? current.client_id);
  const client = await Client.findByPk(clientId);
  if (!client) throw ApiError.badRequest('Select a valid client');
  const projectId = has(body, 'project_id') ? (body.project_id ? Number(body.project_id) : null) : current.project_id ?? null;
  if (projectId) {
    const p = await ClientProject.findByPk(projectId);
    if (!p || p.client_id !== clientId) throw ApiError.badRequest('That project does not belong to the selected client');
  }
  return { client_id: clientId, project_id: projectId };
}

const withTotal = (f, current = {}) => {
  const amount = f.amount ?? current.amount;
  const tax = f.tax_amount ?? current.tax_amount ?? 0;
  return { ...f, total_amount: rupees(paise(amount) + paise(tax)) };
};

async function createInvoice(body, file, user) {
  const fields = withTotal(invoiceFields(body, false));
  const links = await invoiceLinks(body);
  return sequelize.transaction(async (transaction) => {
    if (await ProjectInvoice.count({ where: { invoice_number: fields.invoice_number }, transaction })) throw ApiError.conflict(`Invoice number ${fields.invoice_number} already exists`);
    const invoice = await ProjectInvoice.create({ ...fields, ...links, created_by_user_id: user.id }, { transaction });
    const pdf = file ? await storeFile(file, { ...links, invoice_id: invoice.id, kind: 'INVOICE' }, user, transaction, { pdfOnly: true }) : null;
    return { invoice, pdf };
  });
}

async function updateInvoice(id, body, file, user) {
  const invoice = await ProjectInvoice.findByPk(id);
  if (!invoice) throw ApiError.notFound('Invoice not found');
  const before = invoice.get({ clone: true });
  const fields = withTotal(invoiceFields(body, true), before);
  const links = await invoiceLinks(body, before);
  if (fields.invoice_number && fields.invoice_number !== before.invoice_number && (await ProjectInvoice.count({ where: { invoice_number: fields.invoice_number } }))) {
    throw ApiError.conflict(`Invoice number ${fields.invoice_number} already exists`);
  }
  return sequelize.transaction(async (transaction) => {
    await invoice.update({ ...fields, ...links }, { transaction });
    const pdf = file ? await storeFile(file, { ...links, invoice_id: invoice.id, kind: 'INVOICE' }, user, transaction, { pdfOnly: true }) : null;
    return { invoice, before, pdf };
  });
}

/** Overdue is shown (not stored) for sent/partially-paid invoices past their due date. */
const invoiceJson = (i) => ({ ...i.get({ plain: true }), is_overdue: ['SENT', 'PARTIALLY_PAID'].includes(i.status) && !!i.due_date && i.due_date < today() });

async function listInvoices({ client_id, project_id, status, search, from, to } = {}) {
  const where = {};
  if (client_id) where.client_id = Number(client_id);
  if (project_id) where.project_id = Number(project_id);
  if (status) where.status = status;
  if (search) where.invoice_number = { [likeOp]: `%${String(search).trim()}%` };
  const f = dateOnly(from, 'from');
  const t = dateOnly(to, 'to');
  if (f || t) where.invoice_date = { ...(f ? { [Op.gte]: f } : {}), ...(t ? { [Op.lte]: t } : {}) };
  const rows = await ProjectInvoice.findAll({
    where,
    include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }, { model: ClientProject, as: 'project', attributes: ['id', 'name'] }, { model: ClientDocument, as: 'documents' }],
    order: [['invoice_date', 'DESC'], ['id', 'DESC']],
    limit: 2000,
  });
  return rows.map(invoiceJson);
}

/* ---------------- dashboard + reports ---------------- */

const monthKey = (d) => String(d).slice(0, 7);
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

function range(q) {
  const to = dateOnly(q.to, 'to') || today();
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 11, 1);
  const from = dateOnly(q.from, 'from') || d.toISOString().slice(0, 10);
  if (from > to) throw ApiError.badRequest('from must be on or before to');
  return { from, to };
}

// ponytail: aggregates in JS over the loaded rows (fine for an agency's thousands of payments); move to SQL GROUP BY if it reaches 100k+.
async function dashboard(q = {}) {
  const { from, to } = range(q);
  const [clients, projects, payments, invoices] = await Promise.all([
    Client.count({ where: { archived_at: null } }),
    ClientProject.findAll({ include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }] }),
    ProjectPayment.findAll({ where: { voided_at: null }, attributes: ['project_id', 'amount', 'payment_type', 'payment_date', 'payment_method'], raw: true }),
    ProjectInvoice.findAll({ where: { invoice_date: { [Op.between]: [from, to] } }, attributes: ['status', 'total_amount'], raw: true }),
  ]);
  const totals = {};
  for (const p of payments) {
    const t = (totals[p.project_id] ||= { received: 0, deposits: 0, count: 0 });
    t.received += paise(p.amount);
    if (p.payment_type === 'ADVANCE_DEPOSIT') t.deposits += paise(p.amount);
    t.count += 1;
  }
  const rows = projects.map((p) => withTotals(p, totals));
  const live = rows.filter((p) => p.status !== 'CANCELLED');
  const inRange = payments.filter((p) => p.payment_date >= from && p.payment_date <= to);
  const sumP = (list, k) => list.reduce((s, x) => s + paise(x[k]), 0);

  const months = monthsBetween(from, to).map((m) => ({ month: m, received: 0, deposits: 0, count: 0 }));
  const byMonth = Object.fromEntries(months.map((m) => [m.month, m]));
  for (const p of inRange) {
    const m = byMonth[monthKey(p.payment_date)];
    if (!m) continue;
    m.received += paise(p.amount);
    if (p.payment_type === 'ADVANCE_DEPOSIT') m.deposits += paise(p.amount);
    m.count += 1;
  }
  let running = 0;
  const monthly = months.map((m) => {
    running += m.received;
    return { month: m.month, received: num(m.received), deposits: num(m.deposits), payments: m.count, cumulative: num(running) };
  });
  const received = sumP(rows, 'total_received'); // money already in hand counts even on a later-cancelled project
  const pending = sumP(live, 'remaining_balance');
  const byMethod = {};
  for (const p of inRange) byMethod[p.payment_method] = (byMethod[p.payment_method] || 0) + paise(p.amount);
  const invoiceStatus = {};
  for (const i of invoices) {
    const s = (invoiceStatus[i.status] ||= { status: i.status, count: 0, amount: 0 });
    s.count += 1;
    s.amount += paise(i.total_amount);
  }

  return {
    range: { from, to },
    cards: {
      total_clients: clients,
      total_projects: rows.length,
      total_project_value: rupees(sumP(live, 'project_value')),
      total_received: rupees(received),
      total_deposits: rupees(sumP(rows, 'total_deposits')),
      pending_payments: rupees(pending),
      active_projects: rows.filter((p) => ['CONFIRMED', 'IN_PROGRESS'].includes(p.status)).length,
      completed_projects: rows.filter((p) => p.status === 'COMPLETED').length,
      received_in_range: rupees(sumP(inRange, 'amount')),
      deposits_in_range: rupees(inRange.filter((p) => p.payment_type === 'ADVANCE_DEPOSIT').reduce((s, p) => s + paise(p.amount), 0)),
      payments_in_range: inRange.length,
    },
    monthly,
    received_vs_pending: [{ name: 'Received', value: num(received) }, { name: 'Pending', value: num(pending) }],
    project_revenue: live
      .filter((p) => paise(p.total_received) > 0 || paise(p.project_value) > 0)
      .sort((a, b) => paise(b.total_received) - paise(a.total_received))
      .slice(0, 10)
      .map((p) => ({ project: p.name, client: p.client?.name, received: num(paise(p.total_received)), pending: num(paise(p.remaining_balance)) })),
    by_method: Object.entries(byMethod).map(([method, p]) => ({ method, amount: num(p) })),
    invoice_status: Object.values(invoiceStatus).map((s) => ({ ...s, amount: num(s.amount) })),
  };
}

const REPORTS = {
  monthly: 'Monthly Revenue',
  yearly: 'Yearly Revenue',
  clients: 'Client-wise Payments',
  projects: 'Project-wise Revenue',
  pending: 'Pending Payments',
  deposits: 'Deposit Collection',
  invoices: 'Invoice Status',
};

/** { title, columns: [{ key, header, money? }], rows } for one report over [from, to]. */
async function report(type, q = {}) {
  if (!REPORTS[type]) throw ApiError.notFound('Unknown report');
  const { from, to } = range(q);
  const period = { payment_date: { [Op.between]: [from, to] }, voided_at: null };
  const title = REPORTS[type];
  const money = (key, header) => ({ key, header, money: true });

  if (type === 'monthly' || type === 'yearly') {
    const pays = await ProjectPayment.findAll({ where: period, attributes: ['amount', 'payment_type', 'payment_date'], raw: true });
    const keyOf = (d) => (type === 'monthly' ? monthKey(d) : String(d).slice(0, 4));
    const keys = type === 'monthly' ? monthsBetween(from, to) : [...new Set(monthsBetween(from, to).map((m) => m.slice(0, 4)))];
    const acc = Object.fromEntries(keys.map((k) => [k, { period: k, payments: 0, received: 0, deposits: 0 }]));
    for (const p of pays) {
      const a = acc[keyOf(p.payment_date)];
      if (!a) continue;
      a.payments += 1;
      a.received += paise(p.amount);
      if (p.payment_type === 'ADVANCE_DEPOSIT') a.deposits += paise(p.amount);
    }
    return { title, from, to, columns: [{ key: 'period', header: type === 'monthly' ? 'Month' : 'Year' }, { key: 'payments', header: 'Payments' }, money('received', 'Received'), money('deposits', 'Deposits')], rows: Object.values(acc).map((a) => ({ ...a, received: rupees(a.received), deposits: rupees(a.deposits) })) };
  }

  if (type === 'clients') {
    const pays = await ProjectPayment.findAll({ where: period, include: [{ model: Client, as: 'client', attributes: ['id', 'name', 'company_name'] }] });
    const acc = {};
    for (const p of pays) {
      const a = (acc[p.client_id] ||= { client: p.client?.name, company: p.client?.company_name || '', payments: 0, received: 0, deposits: 0, last_payment: '' });
      a.payments += 1;
      a.received += paise(p.amount);
      if (p.payment_type === 'ADVANCE_DEPOSIT') a.deposits += paise(p.amount);
      if (p.payment_date > a.last_payment) a.last_payment = p.payment_date;
    }
    const rows = Object.values(acc).sort((a, b) => b.received - a.received).map((a) => ({ ...a, received: rupees(a.received), deposits: rupees(a.deposits) }));
    return { title, from, to, columns: [{ key: 'client', header: 'Client' }, { key: 'company', header: 'Company' }, { key: 'payments', header: 'Payments' }, money('received', 'Received'), money('deposits', 'Deposits'), { key: 'last_payment', header: 'Last payment' }], rows };
  }

  if (type === 'deposits') {
    const pays = await ProjectPayment.findAll({ where: { ...period, payment_type: 'ADVANCE_DEPOSIT' }, include: [{ model: Client, as: 'client', attributes: ['name'] }, { model: ClientProject, as: 'project', attributes: ['name'] }], order: [['payment_date', 'ASC']] });
    return {
      title, from, to,
      columns: [{ key: 'date', header: 'Date' }, { key: 'client', header: 'Client' }, { key: 'project', header: 'Project' }, { key: 'method', header: 'Method' }, { key: 'reference', header: 'Reference' }, money('amount', 'Amount')],
      rows: pays.map((p) => ({ date: p.payment_date, client: p.client?.name, project: p.project?.name, method: p.payment_method, reference: p.transaction_reference || '', amount: p.amount })),
    };
  }

  if (type === 'projects' || type === 'pending') {
    const projects = await listProjects();
    const inPeriod = await paymentTotals({ payment_date: { [Op.between]: [from, to] } });
    let rows = projects.map((p) => ({
      project: p.name, client: p.client?.name, status: p.status, value: p.project_value,
      received_in_period: rupees(inPeriod[p.id]?.received || 0), total_received: p.total_received, deposits: p.total_deposits,
      remaining: p.remaining_balance, completion: `${p.completion_percent}%`, expected_delivery: p.expected_delivery_date || '',
    }));
    if (type === 'pending') rows = rows.filter((r) => r.status !== 'CANCELLED' && paise(r.remaining) > 0).sort((a, b) => paise(b.remaining) - paise(a.remaining));
    const columns = [{ key: 'project', header: 'Project' }, { key: 'client', header: 'Client' }, { key: 'status', header: 'Status' }, money('value', 'Project value')];
    if (type === 'projects') columns.push(money('received_in_period', 'Received in period'));
    columns.push(money('total_received', 'Total received'), money('deposits', 'Deposits'), money('remaining', 'Remaining'), { key: 'completion', header: 'Paid %' });
    if (type === 'pending') columns.push({ key: 'expected_delivery', header: 'Expected delivery' });
    return { title, from, to, columns, rows };
  }

  // invoices
  const invoices = await listInvoices({ from, to });
  return {
    title, from, to,
    columns: [{ key: 'number', header: 'Invoice #' }, { key: 'date', header: 'Date' }, { key: 'due', header: 'Due' }, { key: 'client', header: 'Client' }, { key: 'project', header: 'Project' }, { key: 'status', header: 'Status' }, money('amount', 'Amount'), money('tax', 'GST / Tax'), money('total', 'Total')],
    rows: invoices.map((i) => ({ number: i.invoice_number, date: i.invoice_date, due: i.due_date || '', client: i.client?.name, project: i.project?.name || '', status: i.is_overdue ? `${i.status} (overdue)` : i.status, amount: i.amount, tax: i.tax_amount, total: i.total_amount })),
  };
}

async function reportXlsx(r) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.columns = r.columns.map((c) => ({ header: c.header, key: c.key, width: Math.max(12, c.header.length + 4), style: c.money ? { numFmt: '#,##0.00' } : {} }));
  ws.getRow(1).font = { bold: true };
  r.rows.forEach((row) => ws.addRow(Object.fromEntries(r.columns.map((c) => [c.key, c.money ? Number(row[c.key]) : row[c.key]]))));
  return wb.xlsx.writeBuffer();
}

module.exports = {
  toPaise, rupees, paise, checkFile, storeFile, MAX_FILE_BYTES,
  clientFields, projectFields, loadClient, listClients, clientProfile,
  listProjects, getProject, updateProject,
  createPayment, updatePayment, voidPayment, listPayments,
  createInvoice, updateInvoice, listInvoices, invoiceJson,
  dashboard, report, reportXlsx, REPORTS,
};
