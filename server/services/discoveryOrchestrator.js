/**
 * The automatic lead-generation pipeline:
 *
 *   TARGET -> MULTI-SOURCE DISCOVERY -> DEDUPLICATION -> WEBSITE CHECK/ANALYSIS
 *   -> BUYING SIGNAL DETECTION -> OPPORTUNITY DETECTION -> AI QUALIFICATION
 *   -> SCORE -> ENRICHMENT ELIGIBILITY -> CONTACT HISTORY CHECK -> SAVE
 *
 * Multi-source: every provider listed in settings.discoveryProviders runs for
 * the same target; one provider failing (misconfigured, rate-limited, down)
 * never stops another — see the per-provider try/catch below. Results from
 * every provider funnel through the same dedup/scoring/save pipeline, so the
 * same real business found by two providers becomes one Company row with
 * multiple `lead_sources` entries (see dedupeService.findMatchingCompany).
 *
 * Cost control: cheap steps (dedupe, basic save) always run; the website
 * fetch only runs for genuinely new-or-unaudited companies; a company whose
 * lead is already past NOT_CONTACTED is skipped entirely once matched (no
 * re-enrichment spend on someone you've already engaged); enrichment only
 * runs for companies that pass isEligibleForEnrichment(), capped per run.
 */

const { Company, CompanyContact, CompanyWebsite, Lead, LeadSource, SearchRun, Activity } = require('../models');
const { getDiscoveryProvider } = require('../providers');
const { findMatchingCompany, normalizeDomain, normalizePhone, normalizeName, normalizeAddress } = require('./dedupeService');
const { auditWebsite } = require('./websiteAuditService');
const { detectOpportunities } = require('./opportunityDetectionService');
const { detectAndSaveSignals } = require('./signalDetectionService');
const { enrichCompany, isEligibleForEnrichment, HUNTER_NOT_CONFIGURED } = require('./enrichmentService');
const { qualify } = require('./aiQualificationService');
const { rescoreCompany } = require('./companyService');
const apiUsage = require('./apiUsageService');
const { getSettings } = require('./automationSettingsService');

const LEADGEN_PROVIDER_KEY = 'leadgen'; // daily-lead-limit counter key (independent of the data-source provider)
const MAX_LOGGED_ERRORS = 50;

async function upsertBasicCompany(raw, { industry, providerKey }) {
  const existing = await findMatchingCompany({
    website: raw.website,
    phone: raw.phone,
    companyName: raw.company_name,
    address: raw.registered_address,
    city: raw.city,
    externalId: raw.external_id,
    provider: providerKey,
  });

  if (existing) {
    existing.times_discovered += 1;
    existing.last_discovered_at = new Date();
    // Backfill anything we didn't have before, without clobbering existing data.
    if (!existing.website && raw.website) existing.website = raw.website;
    if (!existing.city && raw.city) existing.city = raw.city;
    if (!existing.state && raw.state) existing.state = raw.state;
    if (!existing.registered_address && raw.registered_address) existing.registered_address = raw.registered_address;
    existing.normalized_domain = normalizeDomain(existing.website);
    existing.normalized_name = normalizeName(existing.company_name);
    existing.normalized_address = normalizeAddress(existing.registered_address);
    if (raw.phone) existing.normalized_phone = normalizePhone(raw.phone);
    await existing.save();
    return { company: existing, created: false };
  }

  const company = await Company.create({
    company_name: raw.company_name,
    industry,
    city: raw.city || null,
    state: raw.state || null,
    registered_address: raw.registered_address || null,
    website: raw.website || null,
    company_status: 'Active',
    source: 'automation',
    normalized_domain: normalizeDomain(raw.website),
    normalized_phone: normalizePhone(raw.phone),
    normalized_name: normalizeName(raw.company_name),
    normalized_address: normalizeAddress(raw.registered_address),
    times_discovered: 1,
    first_discovered_at: new Date(),
    last_discovered_at: new Date(),
  });

  if (raw.phone) await CompanyContact.create({ company_id: company.id, type: 'phone', value: raw.phone, is_primary: true });
  if (raw.email) await CompanyContact.create({ company_id: company.id, type: 'email', value: raw.email, is_primary: true, is_public_business: true });
  if (raw.website) await CompanyWebsite.create({ company_id: company.id, url: raw.website, is_https: /^https:/i.test(raw.website) });

  company.has_email = !!raw.email;
  company.has_phone = !!raw.phone;
  company.has_website = !!raw.website;
  await company.save();

  return { company, created: true };
}

async function analyzeWebsite(company) {
  const audit = await auditWebsite(company.website);

  const [record] = await CompanyWebsite.findOrCreate({
    where: { company_id: company.id, url: company.website || `no-website-${company.id}` },
    defaults: { status: audit.status },
  });
  Object.assign(record, {
    status: audit.status,
    is_https: audit.isHttps,
    health: audit.health,
    opportunity_score: audit.opportunityScore,
    response_time_ms: audit.responseTimeMs,
    http_status: audit.httpStatus,
    is_mobile_friendly: audit.isMobileFriendly,
    page_title: audit.pageTitle,
    meta_description: audit.metaDescription,
    detected_technologies: audit.technologies,
    audit_signals: audit.signals,
    feature_flags: audit.featureFlags || null,
    last_checked_at: new Date(),
  });
  await record.save();

  company.has_website = audit.status !== 'no_website';
  await company.save();

  return audit;
}

/**
 * Run every configured discovery provider for one target, tagging each
 * result with the provider that found it. A provider that is unconfigured or
 * throws is recorded in `errors` and skipped — it never aborts the others.
 */
async function discoverFromAllProviders({ location, industry, providers, limit, counters, errors, providersUsed }) {
  const allItems = [];
  for (const key of providers) {
    try {
      const provider = getDiscoveryProvider(key);
      if (!provider.isConfigured()) {
        errors.push({ step: `discovery:${key}`, message: `${provider.label} is not configured — skipped, other providers continue` });
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const { items, apiCallsUsed } = await provider.searchBusinesses({ location, industry, limit });
      counters.api_calls_used += apiCallsUsed;
      // eslint-disable-next-line no-await-in-loop
      await apiUsage.recordUsage(key, { requests: apiCallsUsed });
      providersUsed.push(key);
      items.forEach((item) => allItems.push({ ...item, _providerKey: key }));
    } catch (providerErr) {
      counters.failed_requests += 1;
      errors.push({ step: `discovery:${key}`, message: providerErr.message });
      // eslint-disable-next-line no-console
      console.error(`[discovery] provider "${key}" failed:`, providerErr.message);
    }
  }
  return allItems;
}

/**
 * Run discovery for a single (location, industry) target across every
 * configured discovery provider. Creates its own SearchRun row. Never
 * throws — failures are recorded on the run itself.
 */
async function runForTarget({ location, industry, providerKey, discoveryProviders, minLeadScore, dailyLimit, triggeredBy, triggeredByUserId, settings }) {
  const providers = discoveryProviders?.length ? discoveryProviders : [providerKey || settings?.provider || 'osm'];

  const run = await SearchRun.create({
    triggered_by: triggeredBy,
    triggered_by_user_id: triggeredByUserId || null,
    locations: [location],
    industries: [industry],
    provider: providers.join('+'),
    status: 'running',
  });

  const counters = {
    businesses_discovered: 0,
    duplicates_skipped: 0,
    already_contacted_skipped: 0,
    qualified_leads: 0,
    hot_leads: 0,
    warm_leads: 0,
    medium_leads: 0,
    failed_requests: 0,
    api_calls_used: 0,
    enrichments_attempted: 0,
    enrichments_succeeded: 0,
    enrichment_failures: 0,
    emails_found: 0,
    verified_emails: 0,
    new_companies: 0,
    websites_analyzed: 0,
  };
  const errors = [];
  const providersUsed = [];

  try {
    const remaining = await apiUsage.remainingToday(LEADGEN_PROVIDER_KEY, dailyLimit);
    if (remaining <= 0) {
      await run.update({
        status: 'completed',
        finished_at: new Date(),
        summary: { message: 'Daily lead limit already reached — skipped.' },
        providers_used: providersUsed,
        errors,
        ...counters,
      });
      return run;
    }

    const items = await discoverFromAllProviders({
      location,
      industry,
      providers,
      limit: Math.min(remaining * 2, 50),
      counters,
      errors,
      providersUsed,
    });

    for (const raw of items) {
      if (!raw.company_name) continue; // eslint-disable-line no-continue
      counters.businesses_discovered += 1;
      const itemProviderKey = raw._providerKey;

      try {
        const { company, created } = await upsertBasicCompany(raw, { industry, providerKey: itemProviderKey });
        if (created) counters.new_companies += 1;

        await LeadSource.create({
          company_id: company.id,
          search_run_id: run.id,
          provider: itemProviderKey,
          external_id: raw.external_id || null,
          source_url: raw.source_url || null,
          raw: raw.raw_tags || null,
        });

        if (!created) {
          counters.duplicates_skipped += 1;
          const existingLead = await Lead.findOne({ where: { company_id: company.id } });
          if (existingLead && Lead.ALREADY_ENGAGED_CONTACT_STATUSES.includes(existingLead.contact_status)) {
            counters.already_contacted_skipped += 1;
            continue; // never re-spend enrichment/scoring on someone already engaged
          }
          if (existingLead) continue; // already has a lead — score/AI stay as last computed

          // Rediscovered, no lead yet (it scored below the bar last time). Cost control:
          // don't re-fetch its website / re-score on every run — only once the audit goes stale.
          const recentAudit = await CompanyWebsite.findOne({
            where: { company_id: company.id },
            order: [['last_checked_at', 'DESC']],
          });
          const AUDIT_FRESH_MS = 3 * 86400000; // 3 days
          if (recentAudit?.last_checked_at && Date.now() - new Date(recentAudit.last_checked_at).getTime() < AUDIT_FRESH_MS) {
            continue;
          }
        }

        if (await apiUsage.hasReachedDailyLimit(LEADGEN_PROVIDER_KEY, dailyLimit)) break;

        let websiteAudit = null;
        if (settings.autoAnalyzeWebsites) {
          websiteAudit = await analyzeWebsite(company);
          counters.websites_analyzed += 1;
        }

        // Real, observable-only signals (no website, broken site, outdated site,
        // recently registered, ...). Distinct from the `signals` table, which
        // records a prospect explicitly asking for work.
        if (settings.autoDetectBuyingSignals) {
          await detectAndSaveSignals(company.id);
        }

        let opportunities = detectOpportunities({ industry: company.industry, websiteAudit });
        let scoring = (await rescoreCompany(company.id))?.result;
        if (!scoring) continue;

        if (scoring.score < minLeadScore) {
          continue; // company saved for reference, but not promoted to a lead
        }

        // Contact enrichment — gated by isEligibleForEnrichment() (score threshold OR
        // near-threshold-with-website OR strong fit OR high buying signal), capped per
        // run. Failure here never fails the run: enrichCompany() catches its own errors.
        if (settings.autoEnrichContacts && counters.enrichments_attempted < settings.maxEnrichmentsPerRun) {
          const freshForEligibility = await Company.findByPk(company.id);
          const eligibility = isEligibleForEnrichment({
            scoring,
            company: freshForEligibility,
            minScore: settings.enrichmentThreshold,
          });
          if (eligibility.eligible) {
            // eslint-disable-next-line no-await-in-loop
            const enrichResult = await enrichCompany(company.id, {
              providerKey: settings.enrichmentProvider,
              refreshDays: settings.enrichmentRefreshDays,
            });
            // Only count it as a real "attempt" if we actually reached the provider —
            // a provider that isn't configured never made an HTTP call at all.
            if (!(enrichResult.status === 'skipped' && enrichResult.reason === HUNTER_NOT_CONFIGURED)) {
              counters.enrichments_attempted += 1;
            }
            if (enrichResult.status === 'success' && enrichResult.contact) {
              counters.enrichments_succeeded += 1;
              counters.emails_found += 1;
              if (['VERIFIED', 'VALID'].includes(enrichResult.contact.verification_status)) counters.verified_emails += 1;
              // Contact info may have improved contactability — rescore for the final, saved value.
              opportunities = detectOpportunities({ industry: company.industry, websiteAudit });
              scoring = (await rescoreCompany(company.id))?.result || scoring;
            } else if (enrichResult.status === 'failed') {
              counters.enrichment_failures += 1;
              errors.push({ step: `enrichment:company_${company.id}`, message: enrichResult.reason });
              // eslint-disable-next-line no-console
              console.error(`[enrichment] company ${company.id} failed: ${enrichResult.reason}`);
            }
          }
        }

        counters.qualified_leads += 1;
        if (scoring.temperature === 'HOT') counters.hot_leads += 1;
        else if (scoring.temperature === 'WARM') counters.warm_leads += 1;
        else if (scoring.temperature === 'MEDIUM') counters.medium_leads += 1;

        const freshCompany = await Company.findByPk(company.id);
        const qualification = settings.autoSaveQualifiedLeads
          ? qualify({ company: freshCompany, scoring, opportunities, websiteAudit })
          : null;

        if (!settings.autoSaveQualifiedLeads) continue;

        const [lead, leadCreated] = await Lead.findOrCreate({
          where: { company_id: company.id },
          defaults: {
            status: 'NEW',
            lead_status: 'QUALIFIED',
            contact_status: 'NOT_CONTACTED',
            lead_score: scoring.score,
            lead_temperature: scoring.temperature,
            recommended_service: scoring.recommendedService,
            ai_problem: qualification?.problem,
            ai_evidence: qualification?.evidence,
            ai_sales_angle: qualification?.salesAngle,
            source: 'automation',
          },
        });

        if (leadCreated) {
          await apiUsage.recordUsage(LEADGEN_PROVIDER_KEY, { requests: 0, leadsCreated: 1 });
          await Activity.create({
            company_id: company.id,
            lead_id: lead.id,
            type: 'discovered',
            title: `Discovered via automation (${itemProviderKey})`,
            body: `${location} · ${industry}`,
            occurred_at: new Date(),
          });
          if (websiteAudit) {
            await Activity.create({
              company_id: company.id,
              lead_id: lead.id,
              type: 'website_analyzed',
              title: `Website analyzed: ${websiteAudit.status === 'live' ? websiteAudit.health : websiteAudit.status}`,
              body: websiteAudit.signals?.join('; ') || null,
              occurred_at: new Date(),
            });
          }
        } else {
          // Contact history must never be lost — only refresh scoring/AI fields, never contact_status.
          lead.lead_score = scoring.score;
          lead.lead_temperature = scoring.temperature;
          lead.recommended_service = scoring.recommendedService;
          if (qualification) {
            lead.ai_problem = qualification.problem;
            lead.ai_evidence = qualification.evidence;
            lead.ai_sales_angle = qualification.salesAngle;
          }
          await lead.save();
        }
      } catch (itemErr) {
        counters.failed_requests += 1;
        errors.push({ step: `item:${raw.company_name || 'unknown'}`, message: itemErr.message });
        // eslint-disable-next-line no-console
        console.error('[discovery] item failed:', itemErr.message);
      }
    }

    await run.update({
      status: 'completed',
      finished_at: new Date(),
      providers_used: providersUsed,
      errors: errors.slice(0, MAX_LOGGED_ERRORS),
      ...counters,
    });
    return run;
  } catch (err) {
    await run.update({
      status: 'failed',
      finished_at: new Date(),
      error_message: err.message,
      providers_used: providersUsed,
      errors: errors.slice(0, MAX_LOGGED_ERRORS),
      ...counters,
    });
    return run;
  }
}

/** Run discovery across every configured (location x industry) pair. */
async function runFullDiscovery({ triggeredBy = 'manual', triggeredByUserId = null, overrideSettings } = {}) {
  const settings = { ...(await getSettings()), ...(overrideSettings || {}) };
  const runs = [];

  if (!settings.locations.length || !settings.industries.length) {
    return { runs, message: 'No locations/industries configured.' };
  }

  const discoveryProviders = settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider];

  for (const location of settings.locations) {
    for (const industry of settings.industries) {
      // eslint-disable-next-line no-await-in-loop
      const run = await runForTarget({
        location,
        industry,
        providerKey: settings.provider,
        discoveryProviders,
        minLeadScore: settings.minLeadScore,
        dailyLimit: settings.dailyLeadLimit,
        triggeredBy,
        triggeredByUserId,
        settings,
      });
      runs.push(run);
    }
  }

  return { runs };
}

module.exports = { runFullDiscovery, runForTarget, upsertBasicCompany, analyzeWebsite, LEADGEN_PROVIDER_KEY };
