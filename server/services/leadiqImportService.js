/**
 * Runs LeadIQ search results through the EXISTING LeadHunter pipeline —
 * upsertBasicCompany -> website audit -> signal detection -> deterministic
 * scoring -> rule-based qualification -> Nemotron AI qualification -> Lead.
 * Nothing here duplicates that pipeline; it only orchestrates the same
 * exported building blocks discoveryOrchestrator/companyService/
 * aiQualificationService already provide, the same way
 * hermesResearchService.rescoreAndQualify does for its own trigger context.
 *
 * Never invents data: every field written here comes straight from the raw
 * LeadIQ search/reveal result the caller passed in (already real, since
 * LeadIQProvider only returns actual API responses).
 */
const { Company, CompanyContact, Lead, LeadSource, Activity } = require('../models');
const { upsertBasicCompany, analyzeWebsite } = require('./discoveryOrchestrator');
const { detectAndSaveSignals } = require('./signalDetectionService');
const { detectOpportunities } = require('./opportunityDetectionService');
const { rescoreCompany } = require('./companyService');
const { qualify, qualifyWithNemotron } = require('./aiQualificationService');
const { enrichCompany, isEligibleForEnrichment } = require('./enrichmentService');
const { leadiqProvider } = require('../providers');
const config = require('../config/config');

const IMPORT_HARD_CAP = 200; // safety limit — never import an unbounded batch from one request

/**
 * Reveal real email/phone for a batch of selected LeadIQ search results (an
 * explicit, credit-costing action — see LeadIQProvider.revealContacts) and
 * merge the results back onto each item. Never called implicitly.
 */
async function revealSelected(items) {
  const revealed = await leadiqProvider.revealContacts(
    items.map((it) => ({
      external_id: it.external_id,
      first_name: it.first_name,
      last_name: it.last_name,
      company_name: it.company_name,
      company_domain: it.company_domain,
      job_title: it.job_title,
      linkedin_url: it.linkedin_url,
    }))
  );
  return items.map((it) => {
    const r = revealed.get(it.external_id);
    if (!r) return it;
    return {
      ...it,
      email: r.email || it.email,
      email_status: r.emailStatus || it.email_status,
      phone: r.phones?.[0] || it.phone,
    };
  });
}

/** One imported LeadIQ result -> Company + CompanyContact + Lead, through the full pipeline. */
async function importOne(item, { userId }) {
  const raw = {
    company_name: item.company_name,
    website: item.website,
    phone: item.phone || null,
    email: item.email || null,
    city: item.city || null,
    state: item.state || null,
    registered_address: null,
    external_id: item.external_id,
    source_url: item.linkedin_url,
    contact_name: item.contact_name,
    job_title: item.job_title,
    linkedin_url: item.linkedin_url,
  };
  if (!raw.company_name) return { status: 'failed', reason: 'Missing company_name', item };

  const { company, created } = await upsertBasicCompany(raw, {
    industry: item.industry || null,
    providerKey: 'leadiq',
    companySource: 'leadiq',
  });

  await LeadSource.create({
    company_id: company.id,
    provider: 'leadiq',
    external_id: item.external_id || null,
    source_url: item.linkedin_url || null,
    raw: { industry: item.industry, employee_count: item.employee_count, seniority: item.seniority, email_status: item.email_status },
  });

  // Existing contact was found first time round, but this LeadIQ hit may carry a
  // named contact the earlier row didn't have (e.g. re-discovered via a different
  // provider first) — backfill without clobbering anything already on file.
  if (!created && (item.email || item.phone) && item.contact_name) {
    if (item.email) {
      const [c] = await CompanyContact.findOrCreate({
        where: { company_id: company.id, type: 'email', value: item.email },
        defaults: { is_primary: false, is_public_business: false, source: 'leadiq', contact_name: item.contact_name, job_title: item.job_title, linkedin_url: item.linkedin_url },
      });
      if (!c.contact_name) {
        c.contact_name = item.contact_name;
        c.job_title = item.job_title || c.job_title;
        await c.save();
      }
    }
    if (item.phone) {
      await CompanyContact.findOrCreate({
        where: { company_id: company.id, type: 'phone', value: item.phone },
        defaults: { is_primary: false, source: 'leadiq', contact_name: item.contact_name, job_title: item.job_title },
      });
    }
  }

  let websiteAudit = null;
  if (company.website) websiteAudit = await analyzeWebsite(company);

  await detectAndSaveSignals(company.id);

  const opportunities = detectOpportunities({ industry: company.industry, websiteAudit });
  let scoreResult = await rescoreCompany(company.id);
  let scoring = scoreResult?.result;
  if (!scoring) return { status: 'failed', reason: 'Scoring failed (company not found after creation)', item };

  // LeadIQ found a real, named decision-maker's email — that's exactly the gap
  // Hunter enrichment exists to close, so only bother if LeadIQ didn't already.
  if (!item.email && company.website && isEligibleForEnrichment({ scoring, company, minScore: config.enrichment.minScore }).eligible) {
    await enrichCompany(company.id, {});
    scoreResult = await rescoreCompany(company.id);
    scoring = scoreResult?.result;
  }

  const freshCompany = await Company.findByPk(company.id);
  const qualification = qualify({ company: freshCompany, scoring, opportunities, websiteAudit });

  const [lead, leadCreated] = await Lead.findOrCreate({
    where: { company_id: company.id },
    defaults: {
      status: 'NEW',
      lead_status: 'QUALIFIED',
      contact_status: 'NOT_CONTACTED',
      lead_score: scoring.score,
      lead_temperature: scoring.temperature,
      recommended_service: scoring.recommendedService,
      ai_problem: qualification.problem,
      ai_evidence: qualification.evidence,
      ai_sales_angle: qualification.salesAngle,
      source: 'leadiq',
      created_by_user_id: userId || null,
    },
  });

  if (!leadCreated) {
    // Contact history must never be lost — only refresh scoring/AI fields.
    lead.lead_score = scoring.score;
    lead.lead_temperature = scoring.temperature;
    lead.recommended_service = scoring.recommendedService;
    lead.ai_problem = qualification.problem;
    lead.ai_evidence = qualification.evidence;
    lead.ai_sales_angle = qualification.salesAngle;
    await lead.save();
  }

  await Activity.create({
    company_id: company.id,
    lead_id: lead.id,
    user_id: userId || null,
    type: leadCreated ? 'discovered' : 'system',
    title: leadCreated ? 'Discovered via LeadIQ' : 'Re-imported from LeadIQ',
    body: item.contact_name ? `${item.contact_name}${item.job_title ? ` — ${item.job_title}` : ''}` : null,
    occurred_at: new Date(),
  });

  // Nemotron AI qualification — same optional, cost-controlled layer used by the
  // automation pipeline (no-ops cleanly if NVIDIA_API_KEY isn't configured).
  try {
    await qualifyWithNemotron(lead.id, { triggeredBy: 'manual', triggeredByUserId: userId });
  } catch (err) {
    // qualifyWithNemotron itself never throws for an ordinary AI failure — guard anyway.
    console.error(`[leadiq-import] AI qualification threw for lead ${lead.id}:`, err.message);
  }

  return { status: created || leadCreated ? 'imported' : 'already_existed', company: freshCompany, lead, created, leadCreated };
}

/**
 * @param {Array<object>} items — normalized LeadIQ search results (LeadIQProvider.normalizePerson shape)
 * @param {{ userId?: number, revealContacts?: boolean }} opts
 * @returns {{ imported: number, alreadyExisted: number, failed: number, results: Array }}
 */
async function importLeads(items, { userId, revealContacts = false } = {}) {
  let list = Array.isArray(items) ? items.slice(0, IMPORT_HARD_CAP) : [];
  if (!list.length) return { imported: 0, alreadyExisted: 0, failed: 0, results: [] };

  let revealError = null;
  if (revealContacts) {
    try {
      list = await revealSelected(list);
    } catch (err) {
      // A reveal failure (rejected batch, timeout, insufficient credits) must not lose
      // the import — fall back to importing whatever profile data was already found.
      revealError = err.message;
      console.error('[leadiq-import] reveal failed, importing profile-only:', err.message);
    }
  }

  const results = [];
  for (const item of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await importOne(item, { userId });
      results.push(r);
    } catch (err) {
      console.error('[leadiq-import] item failed:', item.company_name, err.message);
      results.push({ status: 'failed', reason: err.message, item });
    }
  }

  return {
    imported: results.filter((r) => r.status === 'imported').length,
    alreadyExisted: results.filter((r) => r.status === 'already_existed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    revealError,
    results,
  };
}

module.exports = { importLeads, importOne, revealSelected, IMPORT_HARD_CAP };
