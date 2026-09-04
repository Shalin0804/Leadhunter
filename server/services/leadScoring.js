const config = require('./scoringConfig');
const { recommendService } = require('./recommendedService');

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
  return 'NOT_QUALIFIED';
}

function opportunityLevelForScore(score) {
  for (const lvl of config.opportunityLevels) {
    if (score >= lvl.min) return lvl.level;
  }
  return 'Low';
}

/**
 * Build a normalized signal object from a Company instance (with contacts/websites/socials
 * eager-loaded when available). Also works off denormalized company flags.
 */
function extractSignals(company) {
  const plain = typeof company.get === 'function' ? company.get({ plain: true }) : company;

  const websites = plain.websites || [];
  const contacts = plain.contacts || [];
  const socials = plain.socials || [];
  const signals = plain.signals || [];

  const activeSignals = signals.filter((s) => config.activeSignalStatuses.includes(s.status));

  const primaryWebsite = websites[0];
  const hasWebsite = !!(primaryWebsite || plain.website || plain.has_website);
  const websiteStatus = primaryWebsite?.status || (hasWebsite ? 'unknown' : 'no_website');
  const websiteHealth = primaryWebsite?.health || 'unknown';

  const emailContacts = contacts.filter((c) => c.type === 'email');
  const phoneContacts = contacts.filter((c) => c.type === 'phone');
  const hasEmail = emailContacts.length > 0 || !!plain.has_email;
  const hasPublicBusinessEmail = emailContacts.some((c) => c.is_public_business) || (!contacts.length && !!plain.has_email);
  const hasPhone = phoneContacts.length > 0 || !!plain.has_phone;
  const hasSocial = socials.length > 0;

  return {
    industry: plain.industry,
    state: plain.state,
    dateOfIncorporation: plain.date_of_incorporation ? new Date(plain.date_of_incorporation) : null,
    hasWebsite,
    websiteStatus,
    websiteHealth,
    hasEmail,
    hasPublicBusinessEmail,
    hasPhone,
    hasSocial,
    activeSignals,
    hasActiveSignal: activeSignals.length > 0,
    requestedServices: [...new Set(activeSignals.map((x) => x.service).filter(Boolean))],
  };
}

/**
 * Core scoring routine.
 * @returns {{ score, temperature, opportunityLevel, recommendedService, breakdown, reasons, missingAssets, modelVersion }}
 */
function scoreCompany(company) {
  const s = extractSignals(company);
  const R = config.rules;
  const breakdown = [];
  let raw = 0;

  const add = (key, active) => {
    const rule = R[key];
    if (!rule) return;
    breakdown.push({ key, label: rule.label, points: active ? rule.points : 0, applied: !!active });
    if (active) raw += rule.points;
  };

  const now = new Date();
  const isRecent =
    s.dateOfIncorporation && daysBetween(now, s.dateOfIncorporation) <= config.recentlyRegisteredDays && daysBetween(now, s.dateOfIncorporation) >= 0;

  const poorWebsite =
    s.hasWebsite && ['poor', 'outdated', 'fair'].includes(String(s.websiteHealth).toLowerCase());

  add('activeBuyingSignal', s.hasActiveSignal);
  add('recentlyRegistered', isRecent);
  add('targetIndustry', containsAny(s.industry, config.targetIndustries));
  add('targetLocation', containsAny(s.state, config.targetLocations));
  add('noWebsite', !s.hasWebsite);
  add('poorWebsite', poorWebsite);
  add('publicBusinessEmail', s.hasPublicBusinessEmail);
  add('businessPhone', s.hasPhone);
  add('socialPresence', s.hasSocial);

  const score = Math.max(0, Math.min(config.maxScore, Math.round(raw)));
  const temperature = temperatureForScore(score);
  const opportunityLevel = opportunityLevelForScore(score);

  const reasons = breakdown.filter((b) => b.applied).map((b) => `${b.label} (+${b.points})`);

  const missingAssets = [];
  if (!s.hasWebsite) missingAssets.push('Website');
  else if (poorWebsite) missingAssets.push('Modern / healthy website');
  if (!s.hasEmail) missingAssets.push('Business email');
  if (!s.hasPhone) missingAssets.push('Business phone');
  if (!s.hasSocial) missingAssets.push('Social media presence');

  // A prospect who explicitly asked for a service wins over the inferred one.
  const requestedLabel = s.requestedServices
    .map((svc) => config.signalServiceLabels[svc])
    .find(Boolean);

  const recommendedService =
    requestedLabel ||
    recommendService({
      industry: s.industry,
      hasWebsite: s.hasWebsite,
      websiteHealth: s.websiteHealth,
      hasEmail: s.hasEmail,
      hasPhone: s.hasPhone,
      hasSocial: s.hasSocial,
    });

  if (s.hasActiveSignal) {
    const srcs = [...new Set(s.activeSignals.map((x) => x.source))].join(', ');
    reasons.unshift(`Asked for ${requestedLabel || 'a service'} via ${srcs}`);
  }

  return {
    score,
    temperature,
    opportunityLevel,
    recommendedService,
    requestedServices: s.requestedServices,
    hasActiveSignal: s.hasActiveSignal,
    breakdown,
    reasons,
    missingAssets,
    modelVersion: config.modelVersion,
  };
}

module.exports = { scoreCompany, temperatureForScore, opportunityLevelForScore, extractSignals, config };
