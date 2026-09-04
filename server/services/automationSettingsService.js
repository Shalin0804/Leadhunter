const { Setting } = require('../models');
const config = require('../config/config');

const KEY = 'automation_config';

const DEFAULTS = {
  enabled: false,
  schedule: 'daily_9am', // daily_9am | every_6h | every_12h | weekly | custom
  customCron: null, // used when schedule === 'custom'
  dailyLeadLimit: 30,
  locations: [],
  industries: [],
  opportunities: [], // WEBSITE | CRM | BOOKING_SYSTEM | ...
  minLeadScore: 50,
  autoAnalyzeWebsites: true,
  autoEnrichContacts: true,
  autoDetectBuyingSignals: true,
  autoSaveQualifiedLeads: true,
  provider: 'osm', // osm | google_places — legacy single-provider field, kept for back-compat
  discoveryProviders: ['osm'], // osm | google_places | yelp — a target is run against every listed provider whose isConfigured() is true

  // Contact enrichment (Hunter) — gated by isEligibleForEnrichment(), not just a raw
  // score threshold (see enrichmentService). ENRICHMENT_MIN_SCORE/ENRICHMENT_REFRESH_DAYS
  // set the server-wide defaults; these can still be overridden per-install here.
  enrichmentThreshold: config.enrichment.minScore,
  enrichmentMinScore: config.enrichment.minScore, // alias of enrichmentThreshold, kept for clarity with the env var name
  enrichmentRefreshDays: config.enrichment.refreshDays,
  maxEnrichmentsPerRun: 20,
  enrichmentProvider: 'hunter',
};

// Accept the snake_case field names too (matches common external/API-consumer
// convention and the spec's own example payload) as aliases for the internal
// camelCase keys — without this, a caller sending e.g. `daily_limit` silently
// no-ops (the value is stored but never read by the pipeline) instead of
// actually configuring anything. Both spellings are supported permanently;
// neither is deprecated.
const ALIASES = {
  daily_limit: 'dailyLeadLimit',
  discovery_providers: 'discoveryProviders',
  enrichment_enabled: 'autoEnrichContacts',
  enrichment_min_score: 'enrichmentThreshold',
  enrichment_refresh_days: 'enrichmentRefreshDays',
  min_lead_score: 'minLeadScore',
};

function normalizePatch(patch) {
  const out = { ...patch };
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (alias in out) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }
  // Keep the two enrichment-threshold spellings in sync with each other,
  // whichever one the caller actually set.
  if ('enrichmentThreshold' in out) out.enrichmentMinScore = out.enrichmentThreshold;
  else if ('enrichmentMinScore' in out) out.enrichmentThreshold = out.enrichmentMinScore;
  return out;
}

async function getSettings() {
  const row = await Setting.findOne({ where: { key: KEY } });
  return { ...DEFAULTS, ...(row?.value || {}) };
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...normalizePatch(patch || {}) };
  await Setting.upsert({ key: KEY, value: next, description: 'Automatic lead-generation configuration' });
  return next;
}

module.exports = { getSettings, updateSettings, DEFAULTS, KEY };
