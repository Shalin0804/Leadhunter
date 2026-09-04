const { Company } = require('../models');

/** Strip protocol/www/path/query, lowercase — a stable dedup key for a website. */
function normalizeDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Digits-only phone, keeping a leading + — good enough to match "the same number" across formats. */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, '');
  const stripped = digits.replace(/^\+?0*/, '');
  return stripped.length >= 7 ? stripped.slice(-12) : null; // last 10-12 digits, ignores country-code drift
}

/** Lowercase, strip common suffixes/punctuation — for fuzzy-ish name matching. */
function normalizeName(name) {
  if (!name) return null;
  return String(name)
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/\b(pvt\.?|private|ltd\.?|limited|llp|inc\.?|corp\.?|corporation|co\.?)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/**
 * Find an existing company matching any of {domain, phone, cin, normalized name}.
 * Priority: cin > domain > phone > exact normalized name.
 */
async function findMatchingCompany({ cin, website, phone, companyName, transaction } = {}) {
  const domain = normalizeDomain(website);
  const normPhone = normalizePhone(phone);
  const normName = normalizeName(companyName);

  if (cin) {
    const byCin = await Company.findOne({ where: { cin: String(cin).toUpperCase() }, transaction });
    if (byCin) return byCin;
  }
  if (domain) {
    const byDomain = await Company.findOne({ where: { normalized_domain: domain }, transaction });
    if (byDomain) return byDomain;
  }
  if (normPhone) {
    const byPhone = await Company.findOne({ where: { normalized_phone: normPhone }, transaction });
    if (byPhone) return byPhone;
  }
  if (normName) {
    const byName = await Company.findOne({ where: { normalized_name: normName }, transaction });
    if (byName) return byName;
  }
  return null;
}

/** Recompute + persist a company's dedup keys from its current fields (+ an optional phone). */
async function syncDedupKeys(company, { transaction, phone } = {}) {
  company.normalized_domain = normalizeDomain(company.website);
  company.normalized_name = normalizeName(company.company_name);
  if (phone) company.normalized_phone = normalizePhone(phone);
  await company.save({ transaction });
  return company;
}

module.exports = { normalizeDomain, normalizePhone, normalizeName, findMatchingCompany, syncDedupKeys };
