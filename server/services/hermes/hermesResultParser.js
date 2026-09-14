/**
 * Turns Hermes Agent's raw final-message text into (a) a validated, structured
 * result and (b) a flat evidence list — one entry per fact, classified
 * verified | likely | inferred | unavailable (see hermesSourceValidator).
 *
 * This is the enforcement point for "no unsupported AI-generated fact enters
 * the CRM as verified information": only verified/likely fields ever make it
 * into `parsed.applied.*` (what hermesResearchService is allowed to write to
 * Company/Contact/Website/Social); inferred/unavailable fields still get an
 * evidence row (for transparency) but are never applied as fact.
 */
const { isValidSourceUrl, normalizeSources } = require('./hermesSourceValidator');

const VERIFIED_MIN_CONFIDENCE = 70;

function extractJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : rawText).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall through to a best-effort brace-matched slice — the agent sometimes
    // wraps the object in a sentence despite the prompt asking it not to.
  }
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function classify(hasValue, sourceUrl, confidence) {
  if (!hasValue) return 'unavailable';
  if (!isValidSourceUrl(sourceUrl)) return 'inferred';
  const conf = Number.isFinite(confidence) ? confidence : 0;
  return conf >= VERIFIED_MIN_CONFIDENCE ? 'verified' : 'likely';
}

const isUsable = (status) => status === 'verified' || status === 'likely';
const nonEmpty = (v) => v !== null && v !== undefined && String(v).trim() !== '';

function pushEvidence(evidence, { fieldName, value, sourceUrl, sourceType, confidence, status }) {
  evidence.push({
    field_name: fieldName,
    value: value == null ? null : typeof value === 'string' ? value : JSON.stringify(value),
    source_url: isValidSourceUrl(sourceUrl) ? sourceUrl : null,
    source_type: sourceType || null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : null,
    status,
  });
}

/**
 * @param {string} rawOutput — Hermes run's final text output.
 * @returns {{ ok: boolean, error?: string, evidence: Array, applied?: object,
 *   researchSummary?: string, sources?: string[], leadQualityScore?: number|null,
 *   overallConfidence?: number|null }}
 */
function parseResearchOutput(rawOutput) {
  const json = extractJson(rawOutput);
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Could not extract a JSON object from the Hermes response', evidence: [] };
  }

  const evidence = [];
  const applied = { company: {}, contacts: [], websites: [], socialProfiles: [] };

  // --- company (one shared source_url/confidence for the whole block) ---
  const c = json.company && typeof json.company === 'object' ? json.company : {};
  const companyStatus = classify(true, c.source_url, c.confidence);
  const companyFields = ['name', 'website', 'category', 'industry', 'description', 'address', 'city', 'state', 'country'];
  for (const key of companyFields) {
    const value = c[key];
    const status = nonEmpty(value) ? companyStatus : 'unavailable';
    pushEvidence(evidence, { fieldName: `company.${key}`, value, sourceUrl: c.source_url, sourceType: 'company_profile', confidence: c.confidence, status });
    if (isUsable(status) && nonEmpty(value)) applied.company[key] = String(value).trim();
  }

  // --- contacts[] ---
  const contacts = Array.isArray(json.contacts) ? json.contacts : [];
  contacts.forEach((contact, i) => {
    if (!contact || typeof contact !== 'object') return; // eslint-disable-line no-continue
    const hasAnyValue = nonEmpty(contact.email) || nonEmpty(contact.phone) || nonEmpty(contact.name);
    const status = classify(hasAnyValue, contact.source_url, contact.confidence);
    pushEvidence(evidence, {
      fieldName: `contacts[${i}]`,
      value: contact,
      sourceUrl: contact.source_url,
      sourceType: 'contact',
      confidence: contact.confidence,
      status,
    });
    if (isUsable(status)) {
      applied.contacts.push({
        name: nonEmpty(contact.name) ? String(contact.name).trim() : null,
        role: nonEmpty(contact.role) ? String(contact.role).trim() : null,
        email: nonEmpty(contact.email) ? String(contact.email).trim().toLowerCase() : null,
        phone: nonEmpty(contact.phone) ? String(contact.phone).trim() : null,
        linkedin_url: isValidSourceUrl(contact.linkedin_url) ? contact.linkedin_url : null,
        source_url: contact.source_url,
        confidence: contact.confidence,
        status,
      });
    }
  });

  // --- websites[] (display/evidence only — see hermesResearchService for why
  //     the technical audit itself stays owned by websiteAuditService) ---
  const websites = Array.isArray(json.websites) ? json.websites : [];
  websites.forEach((site, i) => {
    if (!site || typeof site !== 'object') return; // eslint-disable-line no-continue
    const status = classify(nonEmpty(site.url), site.source_url || site.url, site.confidence);
    pushEvidence(evidence, {
      fieldName: `websites[${i}]`,
      value: site,
      sourceUrl: site.source_url || site.url,
      sourceType: 'website',
      confidence: site.confidence,
      status,
    });
    if (isUsable(status)) applied.websites.push({ ...site, status });
  });

  // --- signals[] ---
  const VALID_SIGNAL_TYPES = new Set([
    'HIRING',
    'EXPANSION',
    'NEW_LOCATION',
    'NEW_PRODUCT',
    'RECENT_ACTIVITY',
    'POOR_ONLINE_PRESENCE',
    'INACTIVE_SOCIAL_PRESENCE',
  ]);
  const signals = Array.isArray(json.signals) ? json.signals : [];
  const appliedSignals = [];
  signals.forEach((signal, i) => {
    if (!signal || typeof signal !== 'object') return; // eslint-disable-line no-continue
    const status = classify(nonEmpty(signal.description), signal.source_url, signal.confidence);
    pushEvidence(evidence, {
      fieldName: `signals[${i}]`,
      value: signal,
      sourceUrl: signal.source_url,
      sourceType: 'signal',
      confidence: signal.confidence,
      status,
    });
    // Only a directly-sourced ("verified") signal is worth surfacing as a real
    // DetectedSignal row — this app never records an unverified inferred signal
    // (matches the existing rule-based detector's own contract).
    if (status === 'verified' && VALID_SIGNAL_TYPES.has(String(signal.type || '').toUpperCase())) {
      appliedSignals.push({
        type: String(signal.type).toUpperCase(),
        description: String(signal.description).slice(0, 255),
        source_url: signal.source_url,
        confidence: signal.confidence,
      });
    }
  });
  applied.signals = appliedSignals;

  // --- social_profiles[] ---
  const VALID_PLATFORMS = new Set(['linkedin', 'facebook', 'instagram', 'twitter', 'youtube']);
  const socials = Array.isArray(json.social_profiles) ? json.social_profiles : [];
  socials.forEach((soc, i) => {
    if (!soc || typeof soc !== 'object') return; // eslint-disable-line no-continue
    const status = classify(nonEmpty(soc.url), soc.source_url || soc.url, soc.confidence);
    pushEvidence(evidence, {
      fieldName: `social_profiles[${i}]`,
      value: soc,
      sourceUrl: soc.source_url || soc.url,
      sourceType: 'social_profile',
      confidence: soc.confidence,
      status,
    });
    if (isUsable(status)) {
      const platform = String(soc.platform || '').toLowerCase();
      applied.socialProfiles.push({ platform: VALID_PLATFORMS.has(platform) ? platform : 'other', url: soc.url });
    }
  });

  // --- business_opportunities[] (display-only — never merged into
  //     opportunityDetectionService's deterministic list) ---
  const opportunities = Array.isArray(json.business_opportunities) ? json.business_opportunities : [];
  opportunities.forEach((opp, i) => {
    if (!opp || typeof opp !== 'object') return; // eslint-disable-line no-continue
    const hasSource = (opp.evidence || []).some((e) => isValidSourceUrl(e?.source));
    const status = nonEmpty(opp.service) ? (hasSource ? 'likely' : 'inferred') : 'unavailable';
    pushEvidence(evidence, {
      fieldName: `business_opportunities[${i}]`,
      value: opp,
      sourceUrl: (opp.evidence || []).find((e) => isValidSourceUrl(e?.source))?.source,
      sourceType: 'business_opportunity',
      confidence: null,
      status,
    });
  });

  const sources = normalizeSources(Array.isArray(json.sources) ? json.sources : []);
  const leadQuality = json.lead_quality && typeof json.lead_quality === 'object' ? json.lead_quality : null;

  return {
    ok: true,
    evidence,
    applied,
    businessOpportunities: opportunities,
    researchSummary: nonEmpty(json.research_summary) ? String(json.research_summary).slice(0, 5000) : null,
    sources,
    leadQualityScore: leadQuality && Number.isFinite(leadQuality.score) ? Math.round(leadQuality.score) : null,
    overallConfidence: Number.isFinite(c.confidence) ? Math.round(c.confidence) : null,
  };
}

module.exports = { parseResearchOutput, extractJson, classify, VERIFIED_MIN_CONFIDENCE };
