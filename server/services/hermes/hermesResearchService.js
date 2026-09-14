/**
 * Orchestrates one Hermes Agent research run for a company: build the prompt
 * -> submit/poll the gateway (hermesClient) -> parse+validate the result
 * (hermesResultParser) -> apply only verified/likely fields to
 * Company/CompanyContact/CompanySocial/DetectedSignal -> re-run the EXISTING
 * scoring + qualification pipeline (companyService.rescoreCompany,
 * aiQualificationService.qualify) so nothing about how a lead is scored or
 * written up is duplicated or replaced.
 *
 * Concurrency/queueing is NOT this file's job — see
 * server/jobs/hermesResearchWorker.js, which every caller (manual button,
 * future bulk/automation) goes through.
 */
const { Op } = require('sequelize');
const {
  Company,
  CompanyContact,
  CompanySocial,
  DetectedSignal,
  Lead,
  Activity,
  HermesResearchRun,
  HermesResearchEvidence,
} = require('../../models');
const config = require('../../config/config');
const hermesClient = require('./hermesClient');
const { buildResearchPrompt } = require('./hermesPromptBuilder');
const { parseResearchOutput } = require('./hermesResultParser');
const { syncDedupKeys } = require('../dedupeService');
const { syncPresenceFlags, rescoreCompany } = require('../companyService');
const { qualify } = require('../aiQualificationService');
const { detectOpportunities } = require('../opportunityDetectionService');
const { HERMES_SIGNAL_SOURCE } = require('../signalDetectionService');
const { analyzeWebsite } = require('../discoveryOrchestrator');

const HERMES_NOT_CONFIGURED = 'HERMES_NOT_CONFIGURED';
const ACTIVE_STATUSES = ['PENDING', 'RUNNING', 'RETRY'];
const SIGNAL_STRENGTH_BY_TYPE = {
  HIRING: 'MEDIUM',
  EXPANSION: 'MEDIUM',
  NEW_LOCATION: 'MEDIUM',
  NEW_PRODUCT: 'MEDIUM',
  RECENT_ACTIVITY: 'MEDIUM',
  POOR_ONLINE_PRESENCE: 'LOW',
  INACTIVE_SOCIAL_PRESENCE: 'LOW',
};
const SIGNAL_DESCRIPTIONS = {
  HIRING: (d) => d,
  EXPANSION: (d) => d,
  NEW_LOCATION: (d) => d,
  NEW_PRODUCT: (d) => d,
  RECENT_ACTIVITY: (d) => d,
  POOR_ONLINE_PRESENCE: (d) => d,
  INACTIVE_SOCIAL_PRESENCE: (d) => d,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Backfill-without-clobber: only ever fills a currently-empty field. */
function backfill(target, key, value) {
  if (!target[key] && value) target[key] = value;
}

async function applyContact(companyId, { email, phone, name, role, linkedin_url: linkedinUrl, confidence }) {
  if (email) {
    const [contact, created] = await CompanyContact.findOrCreate({
      where: { company_id: companyId, type: 'email', value: email },
      defaults: { is_primary: false, is_public_business: true, verification_status: 'UNKNOWN', source: 'hermes' },
    });
    if (created) {
      contact.contact_name = name || null;
      contact.job_title = role || null;
      contact.linkedin_url = linkedinUrl || null;
      contact.confidence = Number.isFinite(confidence) ? confidence : null;
    } else {
      backfill(contact, 'contact_name', name);
      backfill(contact, 'job_title', role);
      backfill(contact, 'linkedin_url', linkedinUrl);
    }
    await contact.save();
  }
  if (phone) {
    const [contact, created] = await CompanyContact.findOrCreate({
      where: { company_id: companyId, type: 'phone', value: phone },
      defaults: { is_primary: false, is_public_business: true, source: 'hermes' },
    });
    if (!created) backfill(contact, 'contact_name', name);
    await contact.save();
  }
}

async function applyResearchToCompany(company, parsed) {
  // --- company scalar fields (only ever backfilled, never overwritten) ---
  backfill(company, 'website', parsed.applied.company.website);
  backfill(company, 'industry', parsed.applied.company.industry);
  backfill(company, 'registered_address', parsed.applied.company.address);
  backfill(company, 'city', parsed.applied.company.city);
  backfill(company, 'state', parsed.applied.company.state);
  await syncDedupKeys(company);

  // A brand-new website discovery needs the same trusted, deterministic technical
  // audit every other website on this app gets — reusing discoveryOrchestrator's
  // own analyzeWebsite() rather than trusting Hermes's own claims about it.
  const hadNoWebsiteBefore = !company.website;
  if (parsed.applied.company.website && hadNoWebsiteBefore) {
    await analyzeWebsite(company);
  }

  // --- contacts ---
  for (const contact of parsed.applied.contacts) {
    // eslint-disable-next-line no-await-in-loop
    await applyContact(company.id, contact);
  }

  // --- social profiles ---
  for (const social of parsed.applied.socialProfiles) {
    if (!social.url) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    await CompanySocial.findOrCreate({ where: { company_id: company.id, platform: social.platform, url: social.url } });
  }

  // --- detected signals (Hermes owns rows tagged HERMES_SIGNAL_SOURCE; see the
  //     scoped destroy in signalDetectionService for why this coexists safely) ---
  await DetectedSignal.destroy({ where: { company_id: company.id, signal_source: HERMES_SIGNAL_SOURCE } });
  if (parsed.applied.signals.length) {
    await DetectedSignal.bulkCreate(
      parsed.applied.signals.map((s) => ({
        company_id: company.id,
        signal_type: s.type,
        signal_description: (SIGNAL_DESCRIPTIONS[s.type] || ((d) => d))(s.description).slice(0, 255),
        signal_strength: SIGNAL_STRENGTH_BY_TYPE[s.type] || 'LOW',
        signal_source: HERMES_SIGNAL_SOURCE,
        signal_date: new Date(),
        verified: true,
      }))
    );
  }

  await syncPresenceFlags(company);
}

/** Re-run the EXISTING scoring + qualification pipeline — never duplicated here. */
async function rescoreAndQualify(companyId) {
  const rescored = await rescoreCompany(companyId);
  if (!rescored) return null;
  const { company, result } = rescored;

  const websites = company.websites || [];
  const realWebsite = websites.find((w) => w.status !== 'no_website') || websites[0] || null;
  const websiteAudit = realWebsite
    ? {
        status: realWebsite.status,
        health: realWebsite.health,
        httpStatus: realWebsite.http_status,
        isMobileFriendly: realWebsite.is_mobile_friendly,
        signals: realWebsite.audit_signals,
        technologies: realWebsite.detected_technologies,
        featureFlags: realWebsite.feature_flags,
      }
    : null;
  const opportunities = detectOpportunities({ industry: company.industry, websiteAudit });
  const qualification = qualify({ company, scoring: result, opportunities, websiteAudit });

  const lead = await Lead.findOne({ where: { company_id: companyId } });
  if (lead) {
    lead.lead_score = result.score;
    lead.lead_temperature = result.temperature;
    lead.recommended_service = result.recommendedService;
    lead.ai_problem = qualification.problem;
    lead.ai_evidence = qualification.evidence;
    lead.ai_sales_angle = qualification.salesAngle;
    await lead.save();
  }

  return { company, result, qualification, lead };
}

/**
 * Run one Hermes research attempt end-to-end for a company. Never throws for
 * an ordinary research/parse failure — the run row's status/error field
 * carries that; only rejects on a programming error (missing company id etc.)
 * the caller should not have reached.
 */
async function researchCompany(companyId, { triggeredBy = 'manual', triggeredByUserId = null, depth = 'standard' } = {}) {
  const company = await Company.findByPk(companyId);
  if (!company) return { status: 'failed', reason: 'Company not found' };

  const existingActive = await HermesResearchRun.findOne({
    where: { company_id: companyId, status: { [Op.in]: ACTIVE_STATUSES } },
    order: [['created_at', 'DESC']],
  });
  if (existingActive) return { status: existingActive.status.toLowerCase(), run: existingActive, reason: 'A research run for this company is already in progress' };

  const run = await HermesResearchRun.create({ company_id: companyId, status: 'PENDING', triggered_by: triggeredBy, triggered_by_user_id: triggeredByUserId });

  if (!hermesClient.isConfigured()) {
    run.status = 'FAILED';
    run.error = `${HERMES_NOT_CONFIGURED}: set HERMES_BASE_URL (and HERMES_API_KEY) — see server/.env.example`;
    run.completed_at = new Date();
    await run.save();
    return { status: 'failed', run, reason: HERMES_NOT_CONFIGURED };
  }

  run.status = 'RUNNING';
  run.started_at = new Date();
  await run.save();

  const prompt = buildResearchPrompt({ company, depth });
  const maxAttempts = Math.max(1, config.hermes.maxRetries + 1);
  let lastError = null;
  let gatewayRun = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { runId } = await hermesClient.submitRun(prompt, { companyName: company.company_name });
      if (attempt === 1) {
        run.hermes_run_id = runId;
        // eslint-disable-next-line no-await-in-loop
        await run.save();
      }
      // eslint-disable-next-line no-await-in-loop
      gatewayRun = await hermesClient.pollUntilDone(runId, { companyName: company.company_name });
      if (gatewayRun.status === 'completed') {
        lastError = null;
        break;
      }
      // 'failed' / 'cancelled' from the gateway itself — not a transport error, don't retry blindly.
      lastError = new Error(gatewayRun.error || `Hermes run ended with status "${gatewayRun.status}"`);
      break;
    } catch (err) {
      lastError = err;
      if (!err.transient || attempt >= maxAttempts) break;
      run.retry_count += 1;
      run.status = 'RETRY';
      // eslint-disable-next-line no-await-in-loop
      await run.save();
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(30000, 2 ** attempt * 1000));
      run.status = 'RUNNING';
      // eslint-disable-next-line no-await-in-loop
      await run.save();
    }
  }

  if (lastError) {
    run.status = 'FAILED';
    run.error = String(lastError.message || lastError).slice(0, 1000);
    run.completed_at = new Date();
    run.duration_ms = run.started_at ? Date.now() - run.started_at.getTime() : null;
    await run.save();
    console.error(`[hermes] research failed for company ${companyId}:`, run.error);
    return { status: 'failed', run, reason: run.error };
  }

  const parsed = parseResearchOutput(gatewayRun.output);
  if (!parsed.ok) {
    run.status = 'FAILED';
    run.error = parsed.error;
    run.completed_at = new Date();
    run.duration_ms = run.started_at ? Date.now() - run.started_at.getTime() : null;
    await run.save();
    console.error(`[hermes] unparseable result for company ${companyId}: ${parsed.error}`);
    return { status: 'failed', run, reason: parsed.error };
  }

  await HermesResearchEvidence.bulkCreate(
    parsed.evidence.map((e) => ({ ...e, research_run_id: run.id, company_id: companyId }))
  );

  await applyResearchToCompany(company, parsed);
  const rescoreResult = await rescoreAndQualify(companyId);

  run.status = 'COMPLETED';
  run.completed_at = new Date();
  run.duration_ms = run.started_at ? run.completed_at.getTime() - run.started_at.getTime() : null;
  run.sources_checked = parsed.sources.length;
  run.fields_found = parsed.evidence.filter((e) => e.status === 'verified' || e.status === 'likely').length;
  run.confidence = parsed.overallConfidence;
  run.lead_quality_score = parsed.leadQualityScore;
  run.research_summary = parsed.researchSummary;
  await run.save();

  await Activity.create({
    company_id: companyId,
    lead_id: rescoreResult?.lead?.id || null,
    type: 'system',
    title: `Hermes research completed (${run.fields_found} field${run.fields_found === 1 ? '' : 's'} found, ${run.sources_checked} source${run.sources_checked === 1 ? '' : 's'})`,
    body: parsed.researchSummary || null,
  });

  console.log(`[hermes] research completed for company ${companyId} (run ${run.id}): ${run.fields_found} fields, ${run.sources_checked} sources`);

  return { status: 'completed', run, result: rescoreResult?.result || null };
}

module.exports = { researchCompany, HERMES_NOT_CONFIGURED };
