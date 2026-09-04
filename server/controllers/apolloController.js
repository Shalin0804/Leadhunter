const { getProvider, listProviders } = require('../providers');
const { search, importResults, enrichCompany } = require('../services/apolloService');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');

exports.status = async (req, res) => {
  const provider = getProvider('apollo');
  return ok(res, { configured: provider.isConfigured(), providers: listProviders() });
};

exports.search = async (req, res) => {
  const provider = getProvider('apollo');
  if (!provider.isConfigured()) throw ApiError.badRequest('Apollo is not configured. Set APOLLO_API_KEY on the server.');

  const b = req.body || {};
  const filters = {
    name: b.name,
    locations: b.locations,
    keywords: b.keywords,
    employeeRanges: b.employee_ranges,
    domains: b.domains,
    foundedYearMin: b.founded_year_min,
    foundedYearMax: b.founded_year_max,
  };
  const result = await search(filters, { page: b.page || 1, perPage: b.per_page || 25 });
  return ok(res, result);
};

exports.import = async (req, res) => {
  const provider = getProvider('apollo');
  if (!provider.isConfigured()) throw ApiError.badRequest('Apollo is not configured. Set APOLLO_API_KEY on the server.');

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw ApiError.badRequest('No items to import');

  const result = await importResults(items, { userId: req.user.id });
  return ok(res, result, 201);
};

exports.enrich = async (req, res) => {
  const provider = getProvider('apollo');
  if (!provider.isConfigured()) throw ApiError.badRequest('Apollo is not configured. Set APOLLO_API_KEY on the server.');

  const result = await enrichCompany(req.params.id, { userId: req.user.id });
  if (!result.ok) throw ApiError.badRequest(result.message);
  return ok(res, { company: result.company });
};
