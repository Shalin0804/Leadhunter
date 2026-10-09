/**
 * Imports Explorium search results into the EXISTING LeadHunter tables through
 * the same building blocks every other source uses — dedupeService ->
 * upsertBasicCompany -> website audit -> signal detection -> deterministic
 * scoring -> rule-based qualification -> Lead.
 *
 * Unlike the LeadIQ/automation paths, a match with an existing company is
 * SKIPPED and reported, never merged: this module must not modify a record
 * that is already in the CRM.
 *
 * Not run here (both spend third-party quota per lead and stay explicit actions
 * on the lead/company page): Hunter contact enrichment, Nemotron AI analysis.
 */
const crypto = require('crypto');
const { Lead, LeadSource, Activity, Company } = require('../models');
const { upsertBasicCompany, analyzeWebsite } = require('./discoveryOrchestrator');
const { findMatchingCompany, normalizeDomain, normalizeName } = require('./dedupeService');
const { detectAndSaveSignals } = require('./signalDetectionService');
const { detectOpportunities } = require('./opportunityDetectionService');
const { rescoreCompany } = require('./companyService');
const { qualify } = require('./aiQualificationService');

const IMPORT_HARD_CAP = 50; // one results page — each import audits a website, so keep requests bounded

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Client-supplied result -> trusted shape. Unknown keys dropped, strings capped to column sizes. */
function sanitizeItem(item = {}) {
  let website = str(item.website, 255);
  try {
    if (website && !/^https?:$/.test(new URL(website).protocol)) website = null;
  } catch {
    website = null;
  }
  const externalId = str(item.external_id, 120);
  return {
    external_id: externalId && /^[a-f0-9]{32}$/i.test(externalId) ? externalId : null,
    company_name: str(item.company_name, 255),
    website,
    industry: str(item.industry, 120),
    description: str(item.description, 2000),
    city: str(item.city, 80),
    state: str(item.state, 80),
    country: str(item.country, 80),
    company_size: str(item.company_size, 20),
    revenue_range: str(item.revenue_range, 20),
    linkedin_url: str(item.linkedin_url, 255),
  };
}

/** The dedupeService lookup, with the identity signals Explorium actually provides (no phone/address). */
const findExisting = (item) =>
  findMatchingCompany({
    website: item.website,
    companyName: item.company_name,
    city: item.city,
    externalId: item.external_id,
    provider: 'explorium',
  });

function duplicateReason(existing, item) {
  const domain = normalizeDomain(item.website);
  if (domain && existing.normalized_domain === domain) return `Same website domain (${domain}) is already in LeadHunter`;
  if (existing.normalized_name === normalizeName(item.company_name)) {
    return existing.city && item.city && existing.city.toLowerCase() === item.city.toLowerCase()
      ? 'Same company name and city are already in LeadHunter'
      : 'A company with the same name is already in LeadHunter';
  }
  return 'Already imported from Explorium';
}

async function importOne(rawItem, { userId, batchId }) {
  const item = sanitizeItem(rawItem);
  const base = { external_id: item.external_id, company_name: item.company_name };
  if (!item.company_name) return { ...base, status: 'missing_required', reason: 'Company name is missing' };

  const existing = await findExisting(item);
  if (existing) return { ...base, status: 'duplicate', reason: duplicateReason(existing, item), company_id: existing.id };

  const { company } = await upsertBasicCompany(
    {
      company_name: item.company_name,
      website: item.website,
      city: item.city,
      state: item.state,
      external_id: item.external_id,
      linkedin_url: item.linkedin_url,
    },
    { industry: item.industry, providerKey: 'explorium', companySource: 'explorium' }
  );

  await LeadSource.create({
    company_id: company.id,
    provider: 'explorium',
    external_id: item.external_id,
    source_url: item.linkedin_url,
    raw: {
      import_batch_id: batchId,
      country: item.country,
      company_size: item.company_size,
      revenue_range: item.revenue_range,
      description: item.description,
    },
  });

  const websiteAudit = company.website ? await analyzeWebsite(company) : null;
  await detectAndSaveSignals(company.id);
  const opportunities = detectOpportunities({ industry: company.industry, websiteAudit });
  const scoring = (await rescoreCompany(company.id))?.result;
  if (!scoring) return { ...base, status: 'failed', reason: 'Scoring failed after the company was created', company_id: company.id };

  const freshCompany = await Company.findByPk(company.id);
  const qualification = qualify({ company: freshCompany, scoring, opportunities, websiteAudit });

  const lead = await Lead.create({
    company_id: company.id,
    lead_score: scoring.score,
    lead_temperature: scoring.temperature,
    recommended_service: scoring.recommendedService,
    ai_problem: qualification.problem,
    ai_evidence: qualification.evidence,
    ai_sales_angle: qualification.salesAngle,
    source: 'explorium',
    created_by_user_id: userId || null,
  });

  await Activity.create({
    company_id: company.id,
    lead_id: lead.id,
    user_id: userId || null,
    type: 'discovered',
    title: 'Imported from Explorium',
    body: `Import batch ${batchId}`,
    occurred_at: new Date(),
  });

  return { ...base, status: 'imported', company_id: company.id, lead_id: lead.id, lead_score: scoring.score };
}

/**
 * @param {Array<object>} items — ExploriumProvider.normalizeBusiness-shaped results
 * @returns {{ batchId, imported, duplicates, failed, missingRequired, results }}
 */
async function importLeads(items, { userId } = {}) {
  const batchId = crypto.randomUUID();
  const results = [];
  for (const item of (items || []).slice(0, IMPORT_HARD_CAP)) {
    try {
      // Sequential on purpose: two results for the same business must dedupe against each other.
      // eslint-disable-next-line no-await-in-loop
      results.push(await importOne(item, { userId, batchId }));
    } catch (err) {
      console.error('[explorium-import] item failed:', err.message);
      results.push({ external_id: item?.external_id || null, company_name: item?.company_name || null, status: 'failed', reason: err.message });
    }
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    batchId,
    imported: count('imported'),
    duplicates: count('duplicate'),
    failed: count('failed'),
    missingRequired: count('missing_required'),
    results,
  };
}

module.exports = { importLeads, importOne, sanitizeItem, findExisting, duplicateReason, IMPORT_HARD_CAP };
