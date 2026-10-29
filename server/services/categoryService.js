/**
 * Business categories (models/BusinessCategory.js). Seeded once on first use: from the
 * earlier Setting-based list if an admin had saved one, otherwise these defaults.
 * After that they are ordinary records the Main Admin edits in the UI.
 */
const { BusinessCategory, Setting } = require('../models');

// `keyword` is what providers search for (OSM maps it to tags); opportunity codes are
// those produced by services/opportunityDetectionService.js.
const DEFAULTS = [
  { key: 'hotels', name: 'Hotels & Resorts', keyword: 'hotels', opportunity_types: ['BOOKING_SYSTEM', 'WEBSITE'], priority: 5 },
  { key: 'restaurants', name: 'Restaurants & Cafes', keyword: 'restaurants', opportunity_types: ['BOOKING_SYSTEM', 'WEBSITE'], priority: 4 },
  { key: 'manufacturers', name: 'Manufacturing', keyword: 'manufacturers', opportunity_types: ['CUSTOM_SOFTWARE', 'ADMIN_DASHBOARD'], priority: 4 },
  { key: 'real_estate', name: 'Real Estate', keyword: 'real estate', opportunity_types: ['CRM', 'WEBSITE'], priority: 4 },
  { key: 'travel', name: 'Travel & Tourism', keyword: 'travel agencies', opportunity_types: ['BOOKING_SYSTEM', 'WEBSITE'], priority: 4 },
  { key: 'logistics', name: 'Logistics & Transportation', keyword: 'logistics', opportunity_types: ['CUSTOM_SOFTWARE', 'ADMIN_DASHBOARD'], priority: 3 },
  { key: 'clinics', name: 'Healthcare Businesses', keyword: 'clinics', opportunity_types: ['APPOINTMENT_SYSTEM', 'WEBSITE'], priority: 4 },
  { key: 'wholesale', name: 'Wholesalers & Distributors', keyword: 'wholesale', opportunity_types: ['ECOMMERCE', 'CUSTOM_SOFTWARE'], priority: 3 },
  { key: 'professional', name: 'Professional Services', keyword: 'consulting', opportunity_types: ['CRM', 'WEBSITE'], priority: 3 },
  { key: 'it', name: 'IT & Technology', keyword: 'it', opportunity_types: ['CUSTOM_SOFTWARE'], priority: 2 },
  { key: 'sme', name: 'Other SMEs', keyword: 'retail', opportunity_types: ['WEBSITE', 'ECOMMERCE'], priority: 2, is_enabled: false },
];

let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  if ((await BusinessCategory.count()) === 0) {
    const saved = await Setting.findOne({ where: { key: 'business_categories' } });
    const legacy = Array.isArray(saved?.value) ? saved.value : null;
    const rows = legacy
      ? legacy.map((c) => ({ key: c.key, name: c.label, keyword: c.keyword, is_enabled: c.enabled !== false, opportunity_types: DEFAULTS.find((d) => d.key === c.key)?.opportunity_types || null }))
      : DEFAULTS;
    await BusinessCategory.bulkCreate(rows, { ignoreDuplicates: true });
  }
  seeded = true;
}

module.exports = { DEFAULTS, ensureSeeded, _reset: () => (seeded = false) };
