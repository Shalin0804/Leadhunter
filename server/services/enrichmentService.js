/**
 * Contact enrichment — finds a real, public, business/role email for a
 * qualified company via Hunter.io. Only called for companies whose lead
 * score already cleared the configured enrichment threshold (cost control),
 * and skipped entirely for companies that already have a verified email or
 * were enriched recently.
 */
const { Company, CompanyContact, CompanyWebsite, Activity } = require('../models');
const { getEnrichmentProvider } = require('../providers');
const { normalizeDomain } = require('./dedupeService');
const apiUsage = require('./apiUsageService');

const RE_ENRICH_COOLDOWN_MS = 30 * 86400000; // 30 days

/** True if enrichment should be skipped (already good data, or too recent). */
async function shouldSkipEnrichment(company) {
  const contacts = await company.getContacts();
  const hasGoodEmail = contacts.some(
    (c) => c.type === 'email' && ['VERIFIED', 'VALID'].includes(c.verification_status)
  );
  if (hasGoodEmail) return { skip: true, reason: 'Already has a verified/valid email on file' };

  if (company.enriched_at && Date.now() - new Date(company.enriched_at).getTime() < RE_ENRICH_COOLDOWN_MS) {
    return { skip: true, reason: 'Enriched within the last 30 days' };
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
 * @param {{ providerKey?: string, verify?: boolean }} opts
 * @returns {{ status: 'success'|'skipped'|'failed', reason?, contact? }}
 */
async function enrichCompany(companyId, { providerKey = 'hunter', verify = true } = {}) {
  const company = await Company.findByPk(companyId);
  if (!company) return { status: 'failed', reason: 'Company not found' };

  const provider = getEnrichmentProvider(providerKey);
  if (!provider.isConfigured()) {
    return { status: 'failed', reason: `${provider.label} is not configured (missing API key)` };
  }

  const skipCheck = await shouldSkipEnrichment(company);
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
      source: 'hunter',
      contact_name: [best.firstName, best.lastName].filter(Boolean).join(' ') || null,
      job_title: best.position || null,
    });
    await contact.save();

    company.has_email = true;
    company.enrichment_status = 'success';
    company.enrichment_error = null;
    company.enriched_at = new Date();
    if (!company.linkedin_url && best.linkedin) company.linkedin_url = best.linkedin;
    await company.save();

    await Activity.create({
      company_id: company.id,
      type: 'system',
      title: `Contact enriched via Hunter (${verificationStatus})`,
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

module.exports = { enrichCompany, shouldSkipEnrichment, pickBestEmail };
