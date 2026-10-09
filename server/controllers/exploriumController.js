const { Op } = require('sequelize');
const { Lead } = require('../models');
const { exploriumProvider } = require('../providers');
const { ExploriumError, COMPANY_SIZES } = require('../providers/ExploriumProvider');
const { importLeads, sanitizeItem, findExisting, IMPORT_HARD_CAP } = require('../services/exploriumImportService');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');

// Provider error code -> the connection status the UI shows. Only ever set from a
// real Explorium response (or the absence of a key) — never assumed.
const STATUS_BY_CODE = {
  NOT_CONFIGURED: 'not_configured',
  AUTH_FAILED: 'auth_failed',
  USAGE_LIMIT: 'usage_limit',
  RATE_LIMITED: 'usage_limit',
  SERVICE_UNAVAILABLE: 'unavailable',
};

/**
 * Explorium failure -> ApiError. Never forwarded as 401: the client treats a 401
 * as an expired LeadHunter session and logs the user out.
 */
function toApiError(err) {
  if (!(err instanceof ExploriumError)) return err;
  const status = err.code === 'RATE_LIMITED' ? 429 : ['BAD_REQUEST', 'NOT_CONFIGURED'].includes(err.code) ? 400 : 502;
  return new ApiError(status, err.message, { connection: STATUS_BY_CODE[err.code] || null, retryAfter: err.retryAfter || null });
}

exports.status = async (req, res) => {
  if (!exploriumProvider.isConfigured()) {
    return ok(res, { status: 'not_configured', message: 'EXPLORIUM_API_KEY is not set on the server.', importHardCap: IMPORT_HARD_CAP });
  }
  try {
    const credits = await exploriumProvider.getCredits();
    const exhausted = credits.remaining === 0;
    return ok(res, {
      status: exhausted ? 'usage_limit' : 'connected',
      message: exhausted ? 'Explorium reports 0 remaining credits.' : null,
      credits,
      importHardCap: IMPORT_HARD_CAP,
    });
  } catch (err) {
    if (!(err instanceof ExploriumError)) throw err;
    return ok(res, { status: STATUS_BY_CODE[err.code] || 'unavailable', message: err.message, importHardCap: IMPORT_HARD_CAP });
  }
};

exports.stats = async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [total, recent] = await Promise.all([
    Lead.count({ where: { source: 'explorium' } }),
    Lead.count({ where: { source: 'explorium', created_at: { [Op.gte]: weekAgo } } }),
  ]);
  return ok(res, { total, recent });
};

exports.search = async (req, res) => {
  const b = req.body;
  if (b.has_website && !['yes', 'no'].includes(b.has_website)) throw ApiError.badRequest('has_website must be "yes" or "no"');

  let result;
  try {
    result = await exploriumProvider.searchBusinesses(
      {
        name: b.company_name?.trim(),
        industry: b.industry?.trim(),
        city: b.city?.trim(),
        state: b.state?.trim(),
        country: b.country?.trim(),
        companySize: b.company_size,
        hasWebsite: b.has_website ? b.has_website === 'yes' : undefined,
      },
      { page: b.page, pageSize: b.limit }
    );
  } catch (err) {
    throw toApiError(err);
  }

  // ponytail: one dedupe lookup (a few indexed queries) per result row, max 50 rows/page —
  // batch by domain/name if this ever shows up as slow
  const items = [];
  for (const item of result.items) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await findExisting(sanitizeItem(item));
    items.push({ ...item, in_crm: !!existing, existing_company_id: existing?.id || null });
  }

  return ok(res, {
    items,
    pagination: { page: b.page, limit: b.limit, total: result.total, totalPages: result.totalPages },
    resolved: result.resolved,
    creditsUsed: result.creditsUsed,
  });
};

exports.import = async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items) || !items.length) throw ApiError.badRequest('No items to import');
  if (items.length > IMPORT_HARD_CAP) throw ApiError.badRequest(`Cannot import more than ${IMPORT_HARD_CAP} leads in one request`);

  return ok(res, await importLeads(items, { userId: req.user.id }), 201);
};

exports.searchSchema = {
  company_name: { type: 'string', maxLength: 120 },
  industry: { type: 'string', maxLength: 80 },
  city: { type: 'string', maxLength: 80 },
  state: { type: 'string', maxLength: 80 },
  country: { type: 'string', maxLength: 80 },
  company_size: { type: 'string', in: COMPANY_SIZES },
  has_website: { type: 'string', maxLength: 3 },
  page: { type: 'integer', min: 1, max: 600, default: 1 },
  limit: { type: 'integer', min: 1, max: IMPORT_HARD_CAP, default: 25 },
};
