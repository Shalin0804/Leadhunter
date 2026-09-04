/**
 * Detects business-opportunity signals from data this app has actually
 * collected — website audit results, registration/discovery recency, public
 * social links, industry. Every signal is directly observable; nothing here
 * infers hiring, expansion, new branches, or new products/services, because
 * this app has no data source for those (no job-postings API, no news feed).
 * If there's no real evidence for a signal, it is simply not created.
 */
const { DetectedSignal, Company, CompanySocial } = require('../models');

const RECENTLY_REGISTERED_DAYS = 180;
const RECENTLY_DISCOVERED_DAYS = 3;
const BOOKING_INDUSTRIES = ['hotel', 'restaurant', 'clinic', 'salon', 'spa', 'resort', 'cafe'];
const ECOMMERCE_INDUSTRIES = ['retail', 'shop', 'store', 'boutique'];
const ECOMMERCE_TECH = ['Shopify', 'Wix', 'Squarespace', 'Webflow'];

function daysAgo(date) {
  return (Date.now() - new Date(date).getTime()) / 86400000;
}

/**
 * @returns {Array<{type, description, strength, source, verified}>} — only the
 * signals actually found; an empty array means none were detected.
 */
function detectSignals({ company, websiteAudit }) {
  const found = [];

  if (websiteAudit?.status === 'no_website') {
    found.push({
      type: 'NO_WEBSITE',
      description: 'No website found for this business',
      strength: 'HIGH',
      source: 'website_audit',
      verified: true,
    });
  } else if (websiteAudit && ['poor', 'outdated'].includes(websiteAudit.health)) {
    found.push({
      type: 'OUTDATED_WEBSITE',
      description: `Website health audit rated "${websiteAudit.health}"${websiteAudit.signals?.[0] ? ` — ${websiteAudit.signals[0]}` : ''}`,
      strength: 'MEDIUM',
      source: 'website_audit',
      verified: true,
    });
  }

  if (company.date_of_incorporation && daysAgo(company.date_of_incorporation) <= RECENTLY_REGISTERED_DAYS && daysAgo(company.date_of_incorporation) >= 0) {
    found.push({
      type: 'NEWLY_REGISTERED',
      description: `Registered ${Math.round(daysAgo(company.date_of_incorporation))} days ago`,
      strength: 'MEDIUM',
      source: 'company_registration_data',
      verified: true,
    });
  } else if (company.first_discovered_at && daysAgo(company.first_discovered_at) <= RECENTLY_DISCOVERED_DAYS) {
    found.push({
      type: 'NEWLY_DISCOVERED',
      description: 'First appeared in discovery within the last few days',
      strength: 'LOW',
      source: 'discovery',
      verified: true,
    });
  }

  const industry = String(company.industry || '').toLowerCase();

  if (websiteAudit?.status === 'live' && BOOKING_INDUSTRIES.some((k) => industry.includes(k))) {
    const hasBookingTech = (websiteAudit.technologies || []).some((t) => /booking|reserv|calendly|sirvoy/i.test(t));
    if (!hasBookingTech) {
      found.push({
        type: 'ONLINE_BOOKING_GAP',
        description: 'Has a website but no online booking/reservation tooling detected',
        strength: 'MEDIUM',
        source: 'website_audit',
        verified: true,
      });
    }
  }

  if (ECOMMERCE_INDUSTRIES.some((k) => industry.includes(k))) {
    const hasEcommerceTech = (websiteAudit?.technologies || []).some((t) => ECOMMERCE_TECH.includes(t));
    if (!hasEcommerceTech) {
      found.push({
        type: 'ECOMMERCE_OPPORTUNITY',
        description: websiteAudit?.status === 'no_website' ? 'Retail business with no online store' : 'Retail business website has no e-commerce platform detected',
        strength: 'MEDIUM',
        source: websiteAudit ? 'website_audit' : 'industry_match',
        verified: true,
      });
    }
  }

  return found;
}

/** Detect + persist signals for a company. Returns the freshly-created rows. */
async function detectAndSaveSignals(companyId, { transaction } = {}) {
  const company = await Company.findByPk(companyId, { include: [{ model: CompanySocial, as: 'socials' }], transaction });
  if (!company) return [];

  // Website audit signals need the live CompanyWebsite row, not a re-fetch — read what's on file.
  const { CompanyWebsite } = require('../models');
  const websiteRow = await CompanyWebsite.findOne({
    where: { company_id: companyId },
    order: [['last_checked_at', 'DESC']],
    transaction,
  });
  const websiteAudit = websiteRow
    ? { status: websiteRow.status, health: websiteRow.health, technologies: websiteRow.detected_technologies, signals: websiteRow.audit_signals }
    : null;

  if (company.socials?.length > 0) {
    // handled separately below to avoid re-deriving inside detectSignals (needs no other data)
  }

  const detected = detectSignals({ company, websiteAudit });

  if (company.socials?.length > 0) {
    detected.push({
      type: 'ACTIVE_SOCIAL_PRESENCE',
      description: `Active on ${company.socials.map((s) => s.platform).join(', ')}`,
      strength: 'LOW',
      source: 'public_profile',
      verified: true,
    });
  }

  // Replace this company's detected signals with the fresh set (avoid unbounded duplicates on re-runs).
  await DetectedSignal.destroy({ where: { company_id: companyId }, transaction });
  if (!detected.length) return [];

  const rows = await DetectedSignal.bulkCreate(
    detected.map((d) => ({
      company_id: companyId,
      signal_type: d.type,
      signal_description: d.description,
      signal_strength: d.strength,
      signal_source: d.source,
      signal_date: new Date(),
      verified: d.verified,
    })),
    { transaction }
  );
  return rows;
}

module.exports = { detectSignals, detectAndSaveSignals };
