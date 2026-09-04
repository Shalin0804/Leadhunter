const { CompanyImport, CompanyImportError, User } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { analyze, runImport } = require('../services/importService');
const { listProviders } = require('../providers');
const { sendCsv } = require('../utils/csv');

exports.providers = async (req, res) => ok(res, { providers: listProviders() });

exports.preview = async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No CSV file uploaded (field name: file)');
  const result = await analyze({ providerKey: req.body.provider || 'csv', fileBuffer: req.file.buffer });
  if (!result.ok) throw ApiError.badRequest(result.message, result);
  return ok(res, result);
};

exports.create = async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No CSV file uploaded (field name: file)');
  const importRow = await runImport({
    providerKey: req.body.provider || 'csv',
    fileBuffer: req.file.buffer,
    originalFilename: req.file.originalname,
    userId: req.user.id,
    updateExisting: req.body.update_existing !== 'false',
  });
  return ok(res, { import: importRow }, 201);
};

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, count } = await CompanyImport.findAndCountAll({
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return ok(res, paginated(rows, count, page, limit));
};

exports.get = async (req, res) => {
  const row = await CompanyImport.findByPk(req.params.id, {
    include: [
      { model: User, as: 'user', attributes: ['id', 'name'] },
      { model: CompanyImportError, as: 'errors' },
    ],
  });
  if (!row) throw ApiError.notFound('Import not found');
  return ok(res, { import: row });
};

exports.errorsCsv = async (req, res) => {
  const row = await CompanyImport.findByPk(req.params.id, { include: [{ model: CompanyImportError, as: 'errors' }] });
  if (!row) throw ApiError.notFound('Import not found');
  const flat = (row.errors || []).map((e) => ({
    row_number: e.row_number ?? '',
    field: e.field ?? '',
    message: e.message,
    company_name: e.raw_row?.company_name ?? '',
    cin: e.raw_row?.cin ?? '',
  }));
  return sendCsv(res, `import-${row.id}-errors.csv`, flat, ['row_number', 'field', 'message', 'company_name', 'cin']);
};
