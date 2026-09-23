const { leadiqProvider } = require('../providers');
const { importLeads, IMPORT_HARD_CAP } = require('../services/leadiqImportService');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');

exports.status = async (req, res) => {
  const configured = leadiqProvider.isConfigured();
  let usage = null;
  let usageError = null;
  if (configured) {
    try {
      usage = await leadiqProvider.getAccountUsage();
    } catch (err) {
      usageError = err.message;
    }
  }
  return ok(res, { configured, usage, usageError, importHardCap: IMPORT_HARD_CAP });
};

exports.search = async (req, res) => {
  if (!leadiqProvider.isConfigured()) throw ApiError.badRequest('LeadIQ is not configured. Set LEADIQ_API_KEY on the server.');

  const b = req.body || {};
  const filters = {
    locations: b.city || b.state || b.country ? [{ city: b.city, areaLevel1: b.state, country: b.country }] : undefined,
    industries: b.industries?.length ? b.industries : undefined,
    titles: b.titles?.length ? b.titles : undefined,
    seniorities: b.seniorities?.length ? b.seniorities : undefined,
    companySizeMin: b.company_size_min,
    companySizeMax: b.company_size_max,
    keywords: b.keywords?.length ? b.keywords : undefined,
  };
  const result = await leadiqProvider.searchPeople(filters, { limit: b.limit || 25, skip: b.skip || 0 });
  return ok(res, result);
};

exports.import = async (req, res) => {
  if (!leadiqProvider.isConfigured()) throw ApiError.badRequest('LeadIQ is not configured. Set LEADIQ_API_KEY on the server.');

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw ApiError.badRequest('No items to import');
  if (items.length > IMPORT_HARD_CAP) throw ApiError.badRequest(`Cannot import more than ${IMPORT_HARD_CAP} leads in one request`);

  const result = await importLeads(items, { userId: req.user.id, revealContacts: !!req.body.reveal_contacts });
  return ok(res, result, 201);
};
