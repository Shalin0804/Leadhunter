const { Setting } = require('../models');

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
  provider: 'osm', // osm | google_places
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
