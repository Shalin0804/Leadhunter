const config = require('./scoringConfig');
const { recommendService } = require('./recommendedService');
const { detectOpportunities } = require('./opportunityDetectionService');
const { computeContactability } = require('./contactabilityService');

const daysBetween = (a, b) => Math.floor((a.getTime() - b.getTime()) / 86400000);

const containsAny = (haystack, needles) => {
  if (!haystack) return false;
  const s = String(haystack).toLowerCase();
  return needles.some((n) => s.includes(String(n).toLowerCase()));
};

function temperatureForScore(score) {
  for (const band of config.temperatureBands) {
    if (score >= band.min) return band.temperature;
  }
  return 'LOW';
}

function opportunityLevelForScore(score) {
  for (const lvl of config.opportunityLevels) {
    if (score >= lvl.min) return lvl.level;
  }
  return 'Low';
}

/**
 * Build a normalized signal object from a Company instance (with contacts/websites/
 * socials/signals/detectedSignals eager-loaded when available).
 */
function extractSignals(company) {
  const plain = typeof company.get === 'function' ? company.get({ plain: true }) : company;

  const websites = plain.websites || [];
  const contacts = plain.contacts || [];
  const socials = plain.socials || [];
  const signals = plain.signals || [];
  const detectedSignals = plain.detectedSignals || [];

  const activeSignals = signals.filter((s) => config.activeSignalStatuses.includes(s.status));

  // A CompanyWebsite row can exist purely to carry an audit result for a business
  // that has NO website (status: 'no_website', url is a placeholder) — its mere
  // existence must not be read as "has a website".
  const realWebsites = websites.filter((w) => w.status !== 'no_website');
  const primaryWebsite = realWebsites[0];
  const noWebsiteConfirmed = websites.length > 0 && realWebsites.length === 0;
  const hasWebsite = !noWebsiteConfirmed && !!(primaryWebsite || plain.website || plain.has_website);
  const websiteStatus = primaryWebsite?.status || (hasWebsite ? 'unknown' : 'no_website');
  const websiteHealth = primaryWebsite?.health || 'unknown';
  const websiteFeatureFlags = primaryWebsite?.feature_flags || null;

  const emailContacts = contacts.filter((c) => c.type === 'email');
  const phoneContacts = contacts.filter((c) => c.type === 'phone');
  const hasEmail = emailContacts.length > 0 || !!plain.has_email;
  const hasPublicBusinessEmail = emailContacts.some((c) => c.is_public_business) || (!contacts.length && !!plain.has_email);
  const hasPhone = phoneContacts.length > 0 || !!plain.has_phone;
  const hasSocial = socials.length > 0;

  return {
    industry: plain.industry,
    state: plain.state,
    city: plain.city,
    dateOfIncorporation: plain.date_of_incorporation ? new Date(plain.date_of_incorporation) : null,
    firstDiscoveredAt: plain.first_discovered_at ? new Date(plain.first_discovered_at) : null,
    timesDiscovered: plain.times_discovered || 0,
    hasWebsite,
    websiteStatus,
    websiteHealth,
    websiteFeatureFlags,
    linkedinUrl: plain.linkedin_url || null,
    hasEmail,
    hasPublicBusinessEmail,
    hasPhone,
    hasSocial,
    contacts,
    activeSignals,
    hasActiveSignal: activeSignals.length > 0,
    requestedServices: [...new Set(activeSignals.map((x) => x.service).filter(Boolean))],
    detectedSignals,
  };
}

/** Website Opportunity: 0-20, from the live audit's status/health rating. */
function scoreWebsiteOpportunity(s) {
  const STATUS_LABELS = {
    no_website: 'No website found',
    broken: 'Website is broken (server returns an error)',
    inaccessible: 'Website is inaccessible (DNS/timeout failure)',
  };
  const key = STATUS_LABELS[s.websiteStatus] ? s.websiteStatus : s.websiteHealth;
  const label = STATUS_LABELS[s.websiteStatus] || `Website health: ${s.websiteHealth}`;
  const points = config.websiteOpportunityByHealth[key] ?? config.websiteOpportunityByHealth.unknown;
  return { score: points, max: config.categoryMax.websiteOpportunity, reasons: points > 0 ? [label] : [] };
}

/** Software Opportunity: 0-20, from opportunityDetectionService's non-website opportunities. */
function scoreSoftwareOpportunity(s, opportunities) {
  const nonWebsite = opportunities.filter((o) => !['WEBSITE', 'WEBSITE_REDESIGN'].includes(o.type));
  const tier = config.softwareOpportunityByCount.find((t) => nonWebsite.length >= t.min);
  const points = tier ? tier.points : 0;
  const reasons = nonWebsite.slice(0, 3).map((o) => `${o.label} opportunity`);
  return { score: points, max: config.categoryMax.softwareOpportunity, reasons };
}

/** Business Growth: 0-15, real registration/discovery recency only. */
function scoreBusinessGrowth(s) {
  const now = new Date();
  const isRecentlyRegistered =
    s.dateOfIncorporation && daysBetween(now, s.dateOfIncorporation) <= config.recentlyRegisteredDays && daysBetween(now, s.dateOfIncorporation) >= 0;
  if (isRecentlyRegistered) {
    return { score: config.businessGrowthPoints.recentlyRegistered, max: config.categoryMax.businessGrowth, reasons: ['Recently registered business'] };
  }
  if (s.timesDiscovered <= 1 && s.firstDiscoveredAt) {
    return { score: config.businessGrowthPoints.newlyDiscovered, max: config.categoryMax.businessGrowth, reasons: ['Newly discovered'] };
  }
  return { score: 0, max: config.categoryMax.businessGrowth, reasons: [] };
}

/** Buying Signal: 0-20. Explicit intent (someone asked) beats inferred signals. */
function scoreBuyingSignal(s) {
  if (s.hasActiveSignal) {
    const srcs = [...new Set(s.activeSignals.map((x) => x.source))].join(', ');
    return {
      score: config.buyingSignalPoints.activeIntentSignal,
      max: config.categoryMax.buyingSignal,
      reasons: [`Explicitly asked for a service via ${srcs}`],
    };
  }
  const detected = s.detectedSignals || [];
  if (!detected.length) return { score: 0, max: config.categoryMax.buyingSignal, reasons: [] };

  const strongest = detected.reduce((best, d) => {
    const points = config.buyingSignalPoints.detectedSignalStrength[d.signal_strength] || 0;
    const bestPoints = config.buyingSignalPoints.detectedSignalStrength[best?.signal_strength] || 0;
    return points > bestPoints ? d : best;
  }, detected[0]);
  const points = Math.min(config.categoryMax.buyingSignal, config.buyingSignalPoints.detectedSignalStrength[strongest.signal_strength] || 0);
  return { score: points, max: config.categoryMax.buyingSignal, reasons: detected.slice(0, 3).map((d) => d.signal_description) };
}

/** Contactability: 0-10, delegated to contactabilityService. */
function scoreContactability(s) {
  const result = computeContactability({
    contacts: s.contacts,
    hasWebsite: s.hasWebsite,
    hasSocial: s.hasSocial,
    linkedinUrl: s.linkedinUrl,
    hasContactPage: !!s.websiteFeatureFlags?.hasContactPage,
    hasContactForm: !!s.websiteFeatureFlags?.hasContactForm,
  });
  return { score: result.score, max: config.categoryMax.contactability, reasons: result.reasons, raw: result };
}

/** Codefloor Fit: 0-15, target industry + target location. */
function scoreCodefloorFit(s) {
  let score = 0;
  const reasons = [];
  if (containsAny(s.industry, config.targetIndustries)) {
    score += config.codefloorFitPoints.industry;
    reasons.push(`Target industry match: "${s.industry}"`);
  }
  if (containsAny(s.state, config.targetLocations) || containsAny(s.city, config.targetLocations)) {
    score += config.codefloorFitPoints.location;
    reasons.push(`Target location match: "${[s.city, s.state].filter(Boolean).join(', ')}"`);
  }
  return { score: Math.min(config.categoryMax.codefloorFit, score), max: config.categoryMax.codefloorFit, reasons };
}

/**
 * Core scoring routine — rule-based (not an LLM call). Every point is traceable
 * to a category in the returned `breakdown`.
 * @returns {{ score, temperature, opportunityLevel, recommendedService, breakdown, reasons, missingAssets, contactabilityScore, modelVersion }}
 */
function scoreCompany(company) {
  const s = extractSignals(company);
  const opportunities = detectOpportunities({
    industry: s.industry,
    websiteAudit: { status: s.websiteStatus, health: s.websiteHealth, isMobileFriendly: undefined, featureFlags: s.websiteFeatureFlags },
  });

  const categories = {
    websiteOpportunity: scoreWebsiteOpportunity(s),
    softwareOpportunity: scoreSoftwareOpportunity(s, opportunities),
    businessGrowth: scoreBusinessGrowth(s),
    buyingSignal: scoreBuyingSignal(s),
    contactability: scoreContactability(s),
    codefloorFit: scoreCodefloorFit(s),
  };

  const CATEGORY_LABELS = {
    websiteOpportunity: 'Website Opportunity',
    softwareOpportunity: 'Software Opportunity',
    businessGrowth: 'Business Growth',
    buyingSignal: 'Buying Signal',
    contactability: 'Contactability',
    codefloorFit: 'Codefloor Fit',
  };

  const breakdown = Object.entries(categories).map(([key, c]) => ({
    key,
    label: CATEGORY_LABELS[key],
    score: c.score,
    max: c.max,
    reasons: c.reasons,
  }));

  const rawTotal = breakdown.reduce((sum, c) => sum + c.score, 0);
  const score = Math.max(0, Math.min(config.maxScore, Math.round(rawTotal)));
  const temperature = temperatureForScore(score);
  const opportunityLevel = opportunityLevelForScore(score);

  const reasons = breakdown
    .filter((c) => c.score > 0)
    .map((c) => `${c.label}: ${c.score}/${c.max}${c.reasons[0] ? ` (${c.reasons[0]})` : ''}`);

  const missingAssets = [];
  if (!s.hasWebsite) missingAssets.push('Website');
  else if (['poor', 'outdated'].includes(s.websiteHealth)) missingAssets.push('Modern / healthy website');
  if (!s.hasEmail) missingAssets.push('Business email');
  if (!s.hasPhone) missingAssets.push('Business phone');
  if (!s.hasSocial) missingAssets.push('Social media presence');

  const requestedLabel = s.requestedServices.map((svc) => config.signalServiceLabels[svc]).find(Boolean);
  const topOpportunity = opportunities[0]?.label;
  const recommendedService =
    requestedLabel ||
    recommendService({
      industry: s.industry,
      hasWebsite: s.hasWebsite,
      websiteHealth: s.websiteHealth,
      hasEmail: s.hasEmail,
      hasPhone: s.hasPhone,
      hasSocial: s.hasSocial,
    }) ||
    topOpportunity ||
    null;

  return {
    score,
    temperature,
    opportunityLevel,
    recommendedService,
    requestedServices: s.requestedServices,
    hasActiveSignal: s.hasActiveSignal,
    contactabilityScore: categories.contactability.score,
    opportunities,
    breakdown,
    reasons,
    missingAssets,
    modelVersion: config.modelVersion, // 'rule-based-v2' — deterministic, not an LLM
  };
}

module.exports = { scoreCompany, temperatureForScore, opportunityLevelForScore, extractSignals, config };
