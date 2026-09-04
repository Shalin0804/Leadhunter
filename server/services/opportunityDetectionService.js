/**
 * Detects which specific software/digital opportunities apply to a business,
 * beyond the single "recommended service" label. Rule-based on industry +
 * website audit signals — every opportunity carries a `reason` that names the
 * real evidence it came from (never fabricated).
 */

const INDUSTRY_OPPORTUNITIES = [
  { match: ['hotel', 'resort', 'lodging', 'travel', 'tour'], opportunities: ['BOOKING_SYSTEM', 'WEBSITE'] },
  { match: ['restaurant', 'cafe', 'food', 'catering'], opportunities: ['BOOKING_SYSTEM', 'WEBSITE'] },
  { match: ['clinic', 'hospital', 'medical', 'health', 'diagnostic', 'dental'], opportunities: ['APPOINTMENT_SYSTEM', 'WEBSITE'] },
  { match: ['law firm', 'legal', 'advocate', 'attorney'], opportunities: ['APPOINTMENT_SYSTEM', 'CRM', 'WEBSITE'] },
  { match: ['school', 'college', 'education', 'academy', 'coaching', 'institute'], opportunities: ['ADMIN_DASHBOARD', 'WEBSITE'] },
  { match: ['real estate', 'realty', 'property'], opportunities: ['CRM', 'WEBSITE'] },
  { match: ['retail', 'store', 'shop', 'boutique'], opportunities: ['ECOMMERCE', 'WEBSITE'] },
  { match: ['manufactur', 'factory', 'industrial'], opportunities: ['CUSTOM_SOFTWARE', 'ADMIN_DASHBOARD'] },
  { match: ['startup'], opportunities: ['CUSTOM_SOFTWARE', 'MOBILE_APP'] },
  { match: ['consult', 'agency', 'services'], opportunities: ['CRM', 'WEBSITE'] },
];

const LABELS = {
  WEBSITE: 'Website (new or redesign)',
  WEBSITE_REDESIGN: 'Website Redesign',
  CRM: 'CRM',
  BOOKING_SYSTEM: 'Booking System',
  APPOINTMENT_SYSTEM: 'Appointment System',
  ECOMMERCE: 'E-commerce',
  CUSTOM_SOFTWARE: 'Custom Software',
  MOBILE_APP: 'Mobile App',
  BUSINESS_AUTOMATION: 'Business Automation',
  ADMIN_DASHBOARD: 'Admin Dashboard',
};

// Opportunity types the website audit's feature flags can directly confirm
// are already present — when true, recommending them is a false "you need
// this" claim about a business that already has it, so they're skipped.
const FEATURE_FLAG_FOR_OPPORTUNITY = {
  BOOKING_SYSTEM: 'hasBookingFeature',
  APPOINTMENT_SYSTEM: 'hasAppointmentFeature',
  ECOMMERCE: 'hasEcommerce',
};

function detectOpportunities({ industry, websiteAudit }) {
  const found = new Map(); // type -> reasons[]
  const add = (type, reason) => {
    if (!found.has(type)) found.set(type, []);
    found.get(type).push(reason);
  };
  const flags = websiteAudit?.featureFlags || {};

  const industryLower = String(industry || '').toLowerCase();
  for (const rule of INDUSTRY_OPPORTUNITIES) {
    if (rule.match.some((m) => industryLower.includes(m))) {
      rule.opportunities.forEach((o) => {
        // INDUSTRY_OPPORTUNITIES lists WEBSITE unconditionally for several
        // industries ("a restaurant probably needs a website") — true in
        // general, but false for a specific business we've confirmed has a
        // live one. The explicit no_website/poor/outdated checks below own
        // the "you need a website" claim; don't let the blanket industry
        // rule repeat it for a site we've already seen working.
        if (o === 'WEBSITE' && websiteAudit?.status === 'live') return;
        const flagKey = FEATURE_FLAG_FOR_OPPORTUNITY[o];
        if (flagKey && flags[flagKey]) return; // already has it — not a real gap
        add(o, `Industry match: "${industry}"`);
      });
    }
  }

  if (websiteAudit) {
    if (websiteAudit.status === 'no_website') {
      add('WEBSITE', 'No website found');
    } else if (['poor', 'outdated'].includes(websiteAudit.health)) {
      add('WEBSITE_REDESIGN', `Website health rated "${websiteAudit.health}"`);
    }
    if (websiteAudit.isMobileFriendly === false) {
      add('WEBSITE_REDESIGN', 'Website is not mobile-responsive');
    }
  }

  return Array.from(found.entries()).map(([type, reasons]) => ({
    type,
    label: LABELS[type] || type,
    reasons,
  }));
}

module.exports = { detectOpportunities, LABELS, INDUSTRY_OPPORTUNITIES };
