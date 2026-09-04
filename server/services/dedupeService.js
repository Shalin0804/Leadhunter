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

/** Lowercase, strip punctuation/unit-noise — a loose key for matching the same street address. */
function normalizeAddress(address) {
  if (!address) return null;
  return String(address)
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(near|opp\.?|opposite|floor|flr|shop\s*no\.?|unit)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/**
 * Find an existing company matching any known identity signal, checked in
 * priority order so the strongest evidence wins first:
 *   cin -> normalized domain -> normalized phone -> provider external_id
 *   -> normalized name + city -> normalized address -> normalized name alone (fuzzy fallback)
 *
 * This is what lets the same real-world business, discovered independently by
 * two different providers (e.g. OSM and Yelp both finding "Rajvadu
 * Restaurant"), collapse into one Company row with multiple `lead_sources`
 * entries instead of becoming two rows.
 */
async function findMatchingCompany({ cin, website, phone, companyName, address, city, externalId, provider, transaction } = {}) {
  const domain = normalizeDomain(website);
  const normPhone = normalizePhone(phone);
  const normName = normalizeName(companyName);
  const normAddress = normalizeAddress(address);

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
  if (externalId && provider) {
    // Cross-provider re-discovery: a *different* provider previously reporting this
    // exact external id for the same business (LeadSource records every provider hit).
    const { LeadSource } = require('../models');
    const bySource = await LeadSource.findOne({ where: { provider, external_id: String(externalId) }, transaction });
    if (bySource) {
      const company = await Company.findByPk(bySource.company_id, { transaction });
      if (company) return company;
    }
  }
  if (normName && city) {
    const { Op, fn, where: seqWhere, col } = require('sequelize');
    const byNameCity = await Company.findOne({
      where: { normalized_name: normName, [Op.and]: [seqWhere(fn('lower', col('city')), String(city).toLowerCase())] },
      transaction,
    });
    if (byNameCity) return byNameCity;
  }
  if (normAddress) {
    const byAddress = await Company.findOne({ where: { normalized_address: normAddress }, transaction });
    if (byAddress) return byAddress;
  }
  if (normName) {
    // Loosest fallback: same normalized name anywhere — the only tier that predates
    // this pass, kept as the last resort so pre-existing dedup behavior never regresses.
    const byName = await Company.findOne({ where: { normalized_name: normName }, transaction });
    if (byName) return byName;
  }
  return null;
}

/** Recompute + persist a company's dedup keys from its current fields (+ an optional phone). */
async function syncDedupKeys(company, { transaction, phone } = {}) {
  company.normalized_domain = normalizeDomain(company.website);
  company.normalized_name = normalizeName(company.company_name);
  company.normalized_address = normalizeAddress(company.registered_address);
  if (phone) company.normalized_phone = normalizePhone(phone);
  await company.save({ transaction });
  return company;
}

module.exports = { normalizeDomain, normalizePhone, normalizeName, normalizeAddress, findMatchingCompany, syncDedupKeys };
