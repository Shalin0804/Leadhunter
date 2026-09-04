/**
 * Contact enrichment — finds a real, public, business/role email for a
 * qualified company via Hunter.io. Only called for companies that pass
 * `isEligibleForEnrichment()` (cost control — score-based, not "every lead"),
 * and skipped entirely for companies that already have a verified email or
 * were enriched within the configured refresh window.
 *
 * Never fabricates a contact: if Hunter is not configured, or finds nothing,
 * or the request fails, no CompanyContact row is created or invented.
 */
const { Company, CompanyContact, Activity } = require('../models');
const { getEnrichmentProvider } = require('../providers');
const { normalizeDomain } = require('./dedupeService');
const apiUsage = require('./apiUsageService');
const config = require('../config/config');

const HUNTER_NOT_CONFIGURED = 'HUNTER_NOT_CONFIGURED';

/**
 * Enrichment eligibility — deliberately broader than a single score cutoff so a
 * clearly strong prospect isn't skipped just because it lacks a discovered email
 * yet (that's exactly the gap enrichment exists to close). A company must have a
 * website on file either way: Hunter enriches a *domain*, so with no domain there
 * is nothing to search regardless of score.
 *
 *   eligible if website exists AND any of:
 *     - score >= minScore (default from ENRICHMENT_MIN_SCORE)
 *     - score >= minScore - 10 (a website already; close to the bar)
 *     - Codefloor Fit category scored >= 12/15 (strong target-industry+location fit)
 *     - Buying Signal category scored >= 15/20 (high-strength buying signal)
 */
function isEligibleForEnrichment({ scoring, company, minScore = config.enrichment.minScore } = {}) {
  if (!company?.website) {
    return { eligible: false, reason: 'No website/domain on file to search' };
  }
  if (!scoring) return { eligible: false, reason: 'No score computed yet' };

  const score = scoring.score ?? 0;
  const byKey = (key) => (scoring.breakdown || []).find((b) => b.key === key)?.score ?? 0;
  const strongCodefloorFit = byKey('codefloorFit') >= 12;
  const highBuyingSignal = byKey('buyingSignal') >= 15;

  if (score >= minScore) return { eligible: true, reason: `Score ${score} meets the enrichment threshold (${minScore})` };
  if (score >= minScore - 10) return { eligible: true, reason: `Score ${score} is near the threshold (${minScore}) and a website exists` };
  if (strongCodefloorFit) return { eligible: true, reason: 'Strong Codefloor industry/location fit + website exists' };
  if (highBuyingSignal) return { eligible: true, reason: 'High-strength buying signal + website exists' };

  return { eligible: false, reason: `Score ${score} below every enrichment eligibility rule (min ${minScore})` };
}

/** True if enrichment should be skipped (already good data, or too recent). */
async function shouldSkipEnrichment(company, { refreshDays = config.enrichment.refreshDays } = {}) {
  const contacts = await company.getContacts();
  const hasGoodEmail = contacts.some(
    (c) => c.type === 'email' && ['VERIFIED', 'VALID'].includes(c.verification_status)
  );
  if (hasGoodEmail) return { skip: true, reason: 'Already has a verified/valid email on file' };

  const cooldownMs = refreshDays * 86400000;
  if (company.enriched_at && Date.now() - new Date(company.enriched_at).getTime() < cooldownMs) {
    return { skip: true, reason: `Enriched within the last ${refreshDays} days` };
  }

  const domain = normalizeDomain(company.website);
  if (!domain) return { skip: true, reason: 'No website/domain to search' };

  return { skip: false, domain };
}

/** Pick the best candidate from Hunter's domain-search results. */
function pickBestEmail(emails) {
  if (!emails?.length) return null;
  // Prefer a named person over a role inbox, and higher confidence.
  const sorted = [...emails].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'personal' ? -1 : 1;
    return (b.confidence || 0) - (a.confidence || 0);
  });
  return sorted[0];
}

function mapVerifierResult(result) {
  if (result === 'deliverable') return 'VERIFIED';
  if (result === 'risky') return 'RISKY';
  if (result === 'undeliverable') return 'INVALID';
  return 'UNKNOWN';
}

function mapDomainSearchStatus(status) {
  if (status === 'valid') return 'VALID';
  if (status === 'invalid') return 'INVALID';
  if (status === 'accept_all' || status === 'webmail' || status === 'disposable') return 'RISKY';
  return 'UNKNOWN';
}

/**
 * @param {number} companyId
 * @param {{ providerKey?: string, verify?: boolean, refreshDays?: number }} opts
 * @returns {{ status: 'success'|'skipped'|'failed', reason?, contact? }} — `reason`
 *   is the literal string HUNTER_NOT_CONFIGURED when the provider has no API key set.
 */
async function enrichCompany(companyId, { providerKey = 'hunter', verify = true, refreshDays } = {}) {
  const company = await Company.findByPk(companyId);
  if (!company) return { status: 'failed', reason: 'Company not found' };

  const provider = getEnrichmentProvider(providerKey);
  if (!provider.isConfigured()) {
    company.enrichment_status = 'skipped';
    company.enrichment_error = `${HUNTER_NOT_CONFIGURED}: ${provider.label} API key is not set`;
    await company.save();
    return { status: 'skipped', reason: HUNTER_NOT_CONFIGURED };
  }

  const skipCheck = await shouldSkipEnrichment(company, refreshDays ? { refreshDays } : undefined);
  if (skipCheck.skip) {
    company.enrichment_status = 'skipped';
    company.enrichment_error = skipCheck.reason;
    await company.save();
    return { status: 'skipped', reason: skipCheck.reason };
  }

  try {
    const search = await provider.domainSearch(skipCheck.domain);
    await apiUsage.recordUsage(providerKey, { requests: 1, metadataDelta: { emails_found: search.emails.length } });

    const best = pickBestEmail(search.emails);
    if (!best) {
      company.enrichment_status = 'success'; // ran successfully, just found nothing — not a failure
      company.enrichment_error = null;
      company.enriched_at = new Date();
      await company.save();
      return { status: 'success', reason: 'No public email found for this domain' };
    }

    let verificationStatus = mapDomainSearchStatus(best.domainVerificationStatus);
    let confidence = best.confidence;

    if (verify) {
      try {
        const verified = await provider.verifyEmail(best.email);
        await apiUsage.recordUsage(providerKey, { requests: 1, metadataDelta: { emails_verified: 1 } });
        verificationStatus = mapVerifierResult(verified.result);
        if (verified.score != null) confidence = verified.score;
      } catch (verifyErr) {
        // Verification failing doesn't invalidate the discovery — keep the domain-search-level status.
        await apiUsage.recordUsage(providerKey, { requests: 0, metadataDelta: { failed_enrichments: 1 } });
        console.error('[enrichment] verify failed:', verifyErr.message);
      }
    }

    const [contact] = await CompanyContact.findOrCreate({
      where: { company_id: company.id, type: 'email', value: best.email },
      defaults: { is_primary: true, is_public_business: true },
    });
    Object.assign(contact, {
      is_role_based: best.type === 'generic',
      verification_status: verificationStatus,
      confidence,
      source: providerKey, // enrichment_provider
      contact_name: [best.firstName, best.lastName].filter(Boolean).join(' ') || null,
      job_title: best.position || null, // a.k.a. contact_role
      linkedin_url: best.linkedin || null,
      enriched_at: new Date(),
    });
    await contact.save();

    company.has_email = true;
    company.enrichment_status = 'success';
    company.enrichment_error = null;
    company.enriched_at = new Date(); // enrichment_timestamp
    company.enrichment_source = providerKey;
    if (!company.linkedin_url && best.linkedin) company.linkedin_url = best.linkedin;
    await company.save();

    await Activity.create({
      company_id: company.id,
      type: 'system',
      title: `Contact enriched via ${provider.label} (${verificationStatus})`,
      body: `${best.email}${best.position ? ` — ${best.position}` : ''}`,
    });

    return { status: 'success', contact };
  } catch (err) {
    await apiUsage.recordUsage(providerKey, { requests: 1, metadataDelta: { failed_enrichments: 1 } });
    company.enrichment_status = 'failed';
    company.enrichment_error = err.message.slice(0, 500);
    company.enriched_at = new Date();
    await company.save();
    return { status: 'failed', reason: err.message };
  }
}

module.exports = { enrichCompany, shouldSkipEnrichment, pickBestEmail, isEligibleForEnrichment, HUNTER_NOT_CONFIGURED };
