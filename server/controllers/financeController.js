const { Client, ClientProject, ProjectPayment, ProjectInvoice, ClientDocument, sequelize } = require('../models');
const finance = require('../services/financeService');
const audit = require('../services/auditService');
const { ok } = require('../utils/http');
const { sendCsv } = require('../utils/csv');
const ApiError = require('../utils/ApiError');

// Everything here sits behind requirePermission('finance.manage') (Main Admin only; denied
// to the Claude Code agent token). Every change is written to the append-only audit_logs.

// Numbers compared by value: a DECIMAL may come back as 100000 or "100000.00" depending on the dialect.
const norm = (v) => (v === null || v === undefined ? '' : /^-?\d+(\.\d+)?$/.test(String(v)) ? String(Number(v)) : String(v));
const changed = (before, after, keys) => keys.filter((k) => norm(before[k]) !== norm(after[k]));
const log = (req, action, resourceType, resourceId, metadata) => audit.record(req, { action, resourceType, resourceId, metadata });

/* ---------------- dashboard + reports ---------------- */

exports.dashboard = async (req, res) => ok(res, await finance.dashboard(req.query));

exports.report = async (req, res) => {
  const r = await finance.report(req.params.type, req.query);
  const format = req.query.format;
  if (format !== 'csv' && format !== 'xlsx') return ok(res, r);
  await log(req, 'finance.report_exported', 'finance_report', req.params.type, { format, from: r.from, to: r.to, rows: r.rows.length });
  const name = `${req.params.type}-report-${r.from}-to-${r.to}`;
  if (format === 'csv') return sendCsv(res, `${name}.csv`, r.rows, r.columns.map((c) => ({ key: c.key, header: c.header })));
  const buf = await finance.reportXlsx(r);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  return res.send(Buffer.from(buf));
};

/* ---------------- clients ---------------- */

exports.listClients = async (req, res) => ok(res, { items: await finance.listClients(req.query) });
exports.getClient = async (req, res) => ok(res, await finance.clientProfile(req.params.id));

exports.createClient = async (req, res) => {
  const client = await Client.create({ ...finance.clientFields(req.body || {}, false), created_by_user_id: req.user.id });
  await log(req, 'finance.client_created', 'client', client.id);
  return ok(res, { client }, 201);
};

exports.updateClient = async (req, res) => {
  const client = await finance.loadClient(req.params.id);
  const before = client.get({ clone: true });
  const fields = finance.clientFields(req.body || {}, true);
  await client.update(fields);
  await log(req, 'finance.client_updated', 'client', client.id, { fields: changed(before, client.get({ plain: true }), Object.keys(fields)).join(',') });
  return ok(res, { client });
};

exports.archiveClient = async (req, res) => {
  const client = await finance.loadClient(req.params.id);
  const archive = req.params.action === 'archive';
  await client.update({ archived_at: archive ? new Date() : null });
  await log(req, archive ? 'finance.client_archived' : 'finance.client_restored', 'client', client.id);
  return ok(res, { client });
};

/* ---------------- projects ---------------- */

exports.listProjects = async (req, res) => ok(res, { items: await finance.listProjects(req.query) });
exports.getProject = async (req, res) => ok(res, { project: await finance.getProject(req.params.id) });

exports.createProject = async (req, res) => {
  const client = await finance.loadClient(req.body?.client_id);
  if (client.archived_at) throw ApiError.badRequest('Restore this client before adding projects');
  const project = await ClientProject.create({ ...finance.projectFields(req.body, false), client_id: client.id, created_by_user_id: req.user.id });
  await log(req, 'finance.project_created', 'client_project', project.id, { client_id: client.id, project_value: project.project_value, status: project.status });
  return ok(res, { project: await finance.getProject(project.id) }, 201);
};

exports.updateProject = async (req, res) => {
  const { project, before } = await finance.updateProject(req.params.id, req.body || {});
  const after = project.get({ plain: true });
  const fields = changed(before, after, ['name', 'description', 'start_date', 'expected_delivery_date', 'actual_completion_date', 'status', 'notes']);
  if (finance.paise(before.project_value) !== finance.paise(after.project_value)) {
    await log(req, 'finance.project_value_changed', 'client_project', project.id, { from: finance.rupees(finance.paise(before.project_value)), to: finance.rupees(finance.paise(after.project_value)) });
  }
  if (fields.length) await log(req, 'finance.project_updated', 'client_project', project.id, { fields: fields.join(','), ...(fields.includes('status') ? { status_from: before.status, status_to: after.status } : {}) });
  return ok(res, { project: await finance.getProject(project.id) });
};

exports.deleteProject = async (req, res) => {
  const project = await ClientProject.findByPk(req.params.id);
  if (!project) throw ApiError.notFound('Project not found');
  const [payments, invoices] = await Promise.all([ProjectPayment.count({ where: { project_id: project.id } }), ProjectInvoice.count({ where: { project_id: project.id } })]);
  if (payments || invoices) throw ApiError.conflict('This project has payments or invoices — set its status to Cancelled instead of deleting it');
  await sequelize.transaction(async (transaction) => {
    await ClientDocument.update({ project_id: null }, { where: { project_id: project.id }, transaction });
    await project.destroy({ transaction });
  });
  await log(req, 'finance.project_deleted', 'client_project', project.id, { name: project.name, client_id: project.client_id });
  return ok(res, { message: 'Project deleted' });
};

/* ---------------- payments ---------------- */

exports.listPayments = async (req, res) => ok(res, { items: await finance.listPayments(req.query) });

exports.createPayment = async (req, res) => {
  const { payment, receipt } = await finance.createPayment(req.body || {}, req.file, req.user);
  await log(req, 'finance.payment_created', 'project_payment', payment.id, { project_id: payment.project_id, client_id: payment.client_id, amount: payment.amount, type: payment.payment_type, method: payment.payment_method, receipt: !!receipt });
  return ok(res, { payment, receipt }, 201);
};

exports.updatePayment = async (req, res) => {
  const { payment, before, receipt } = await finance.updatePayment(req.params.id, req.body || {}, req.file, req.user);
  const after = payment.get({ plain: true });
  const fields = changed(before, after, ['payment_date', 'amount', 'payment_type', 'payment_method', 'transaction_reference', 'notes']);
  await log(req, 'finance.payment_updated', 'project_payment', payment.id, {
    project_id: payment.project_id, fields: fields.join(','), receipt_added: !!receipt,
    ...(fields.includes('amount') ? { amount_from: finance.rupees(finance.paise(before.amount)), amount_to: after.amount } : {}),
  });
  return ok(res, { payment, receipt });
};

exports.voidPayment = async (req, res) => {
  const payment = await finance.voidPayment(req.params.id, req.body?.reason);
  await log(req, 'finance.payment_voided', 'project_payment', payment.id, { project_id: payment.project_id, amount: payment.amount, reason: payment.void_reason });
  return ok(res, { payment });
};

/* ---------------- invoices ---------------- */

exports.listInvoices = async (req, res) => ok(res, { items: await finance.listInvoices(req.query) });

exports.createInvoice = async (req, res) => {
  const { invoice, pdf } = await finance.createInvoice(req.body || {}, req.file, req.user);
  await log(req, 'finance.invoice_created', 'project_invoice', invoice.id, { number: invoice.invoice_number, client_id: invoice.client_id, total: invoice.total_amount, status: invoice.status, pdf: !!pdf });
  return ok(res, { invoice: finance.invoiceJson(invoice), pdf }, 201);
};

exports.updateInvoice = async (req, res) => {
  const { invoice, before, pdf } = await finance.updateInvoice(req.params.id, req.body || {}, req.file, req.user);
  const after = invoice.get({ plain: true });
  const fields = changed(before, after, ['invoice_number', 'client_id', 'project_id', 'invoice_date', 'due_date', 'amount', 'tax_amount', 'status', 'notes']);
  await log(req, 'finance.invoice_updated', 'project_invoice', invoice.id, {
    number: invoice.invoice_number, fields: fields.join(','), pdf_added: !!pdf,
    ...(fields.includes('status') ? { status_from: before.status, status_to: after.status } : {}),
    ...(finance.paise(before.total_amount) !== finance.paise(after.total_amount) ? { total_from: finance.rupees(finance.paise(before.total_amount)), total_to: after.total_amount } : {}),
  });
  return ok(res, { invoice: finance.invoiceJson(invoice), pdf });
};

// Only drafts can be deleted; anything that was issued is kept and set to Cancelled instead.
exports.deleteInvoice = async (req, res) => {
  const invoice = await ProjectInvoice.findByPk(req.params.id);
  if (!invoice) throw ApiError.notFound('Invoice not found');
  if (invoice.status !== 'DRAFT') throw ApiError.conflict('Only draft invoices can be deleted — set an issued invoice to Cancelled');
  await sequelize.transaction(async (transaction) => {
    await ClientDocument.destroy({ where: { invoice_id: invoice.id }, transaction });
    await invoice.destroy({ transaction });
  });
  await log(req, 'finance.invoice_deleted', 'project_invoice', invoice.id, { number: invoice.invoice_number, total: invoice.total_amount });
  return ok(res, { message: 'Draft invoice deleted' });
};

/* ---------------- documents ---------------- */

exports.listDocuments = async (req, res) => {
  const where = {};
  if (req.query.client_id) where.client_id = Number(req.query.client_id);
  return ok(res, { items: await ClientDocument.findAll({ where, order: [['created_at', 'DESC']], limit: 500 }) });
};

exports.uploadDocument = async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Choose a file to upload');
  const client = await finance.loadClient(req.body?.client_id);
  let projectId = null;
  if (req.body.project_id) {
    const p = await ClientProject.findByPk(req.body.project_id);
    if (!p || p.client_id !== client.id) throw ApiError.badRequest('That project does not belong to this client');
    projectId = p.id;
  }
  const doc = await sequelize.transaction((transaction) =>
    finance.storeFile(req.file, { client_id: client.id, project_id: projectId, kind: 'DOCUMENT', notes: String(req.body.notes || '').slice(0, 300) || null }, req.user, transaction)
  );
  await log(req, 'finance.document_uploaded', 'client_document', doc.id, { client_id: client.id, file: doc.file_name, size: doc.size_bytes });
  return ok(res, { document: doc }, 201);
};

/** Streams a stored file to the admin. ?inline=1 previews PDFs/images in the browser. */
exports.downloadDocument = async (req, res) => {
  const doc = await ClientDocument.scope('withData').findByPk(req.params.id);
  if (!doc) throw ApiError.notFound('Document not found');
  await log(req, 'finance.document_downloaded', 'client_document', doc.id, { client_id: doc.client_id, kind: doc.kind });
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${doc.file_name.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  return res.send(Buffer.from(doc.data));
};

// Free-standing documents can be removed; receipts and invoice PDFs are financial records and stay.
exports.deleteDocument = async (req, res) => {
  const doc = await ClientDocument.findByPk(req.params.id);
  if (!doc) throw ApiError.notFound('Document not found');
  if (doc.kind !== 'DOCUMENT') throw ApiError.conflict('Receipts and invoice PDFs are kept with their payment or invoice');
  await doc.destroy();
  await log(req, 'finance.document_deleted', 'client_document', doc.id, { client_id: doc.client_id, file: doc.file_name });
  return ok(res, { message: 'Document deleted' });
};
