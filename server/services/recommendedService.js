/**
 * Recommends a service based on company characteristics.
 * Pure function — takes a normalized company-ish object, returns a string.
 */

const INDUSTRY_RULES = [
  { match: ['restaurant', 'cafe', 'food', 'beverage', 'catering'], service: 'Restaurant Website / Booking System' },
  { match: ['hotel', 'resort', 'hospitality', 'lodging'], service: 'Hotel Website / Booking Platform' },
  { match: ['health', 'clinic', 'hospital', 'pharma', 'medical', 'diagnostic'], service: 'Healthcare Website / Appointment System' },
  { match: ['education', 'school', 'college', 'academy', 'coaching', 'training', 'institute'], service: 'School / Education Website' },
  { match: ['real estate', 'realty', 'property', 'builder', 'construction'], service: 'Real Estate Website / CRM' },
  { match: ['it', 'software', 'technology', 'saas', 'digital', 'tech'], service: 'Corporate Website / Web Application' },
  { match: ['retail', 'store', 'shop', 'e-commerce', 'ecommerce', 'trading'], service: 'E-commerce Store Setup' },
  { match: ['manufactur', 'industr', 'factory', 'production'], service: 'Corporate Website / Product Catalog' },
  { match: ['consult', 'advisory', 'services'], service: 'Corporate Website / Lead Capture' },
];

function matchIndustry(industry) {
  if (!industry) return null;
  const s = String(industry).toLowerCase();
  for (const rule of INDUSTRY_RULES) {
    if (rule.match.some((m) => s.includes(m))) return rule.service;
  }
  return null;
}

/**
 * @param {object} c - { industry, hasWebsite, websiteHealth, hasEmail, hasPhone, hasSocial }
 * @returns {string}
 */
function recommendService(c = {}) {
  const hasWebsite = !!c.hasWebsite;
  const poorWebsite = hasWebsite && ['poor', 'outdated', 'fair'].includes(String(c.websiteHealth || '').toLowerCase());
  const noPresenceAtAll = !hasWebsite && !c.hasEmail && !c.hasSocial;

  const industryService = matchIndustry(c.industry);

  if (noPresenceAtAll) return industryService || 'Website + Digital Presence';
  if (!hasWebsite) return industryService || 'Website Development';
  if (poorWebsite) return industryService ? `Website Redesign (${industryService})` : 'Website Redesign';

  // Has a decent (good/excellent) website already — the industry labels above
  // ("Restaurant Website / Booking System", etc.) say "you need this built",
  // which would be false here. Recommend an honest upsell instead of reusing
  // the same "you don't have one" label for a business that already does.
  return 'Digital Growth / SEO & Marketing';
}

module.exports = { recommendService, matchIndustry };
