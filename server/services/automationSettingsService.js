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

async function getSettings() {
  const row = await Setting.findOne({ where: { key: KEY } });
  return { ...DEFAULTS, ...(row?.value || {}) };
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await Setting.upsert({ key: KEY, value: next, description: 'Automatic lead-generation configuration' });
  return next;
}

module.exports = { getSettings, updateSettings, DEFAULTS, KEY };
