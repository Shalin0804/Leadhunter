/**
 * "AI qualification" step of the discovery pipeline.
 *
 * This is a deterministic, rule-based summarizer — not a hosted LLM call — so
 * it costs nothing and never fabricates facts about a business. It reuses the
 * same scoring/opportunity signals already computed for the lead and turns
 * them into a short, specific, human-readable qualification write-up that
 * names the actual company, its industry, and the real evidence found (never
 * a generic template with no company reference).
 *
 * A real LLM can be dropped in later (e.g. behind ANTHROPIC_API_KEY) by
 * replacing `qualify()`'s body while keeping the same return shape — nothing
 * else in the pipeline needs to change.
 */

function industryNoun(industry) {
  const i = String(industry || '').toLowerCase();
  if (/hotel|resort|lodging/.test(i)) return 'hotel';
  if (/restaurant|cafe|food|catering/.test(i)) return 'restaurant';
  if (/clinic|hospital|medical|dental|health|diagnostic/.test(i)) return 'healthcare practice';
  if (/law|legal|advocate|attorney/.test(i)) return 'law firm';
  if (/school|college|education|academy|coaching|institute/.test(i)) return 'educational institute';
  if (/real estate|realty|property/.test(i)) return 'real estate business';
  if (/retail|shop|store|boutique/.test(i)) return 'retail business';
  if (/salon|spa/.test(i)) return 'salon';
  if (/it|software|startup/.test(i)) return 'IT business';
  return 'business';
}

const BOOKING_NOUN = { restaurant: 'reservations and customer enquiries', hotel: 'bookings and guest enquiries' };

// opportunityDetectionService records "Industry match: X" as an opportunity's
// reason whenever it was added purely from an industry rule (the overwhelming
// majority of cases) — that's meaningful internally, but reused verbatim as
// "the gap" in a sentence it reads as confusing non-sequitur ("...but industry
// match: Restaurants."). When the reason is that generic marker, describe the
// gap by the opportunity's own label instead; otherwise the reason is already
// specific (e.g. "Website is not mobile-responsive") and is used as-is.
const GENERIC_REASON_RE = /^Industry match:/i;
function describeGap(topOpportunity) {
  const reason = topOpportunity.reasons?.[0];
  if (reason && !GENERIC_REASON_RE.test(reason)) return reason.replace(/^./, (c) => c.toLowerCase());
  return `no ${topOpportunity.label.toLowerCase()} was detected on their site`;
}

function qualify({ company, scoring, opportunities, websiteAudit }) {
  const name = company.company_name || 'This business';
  const noun = industryNoun(company.industry);
  const location = [company.city, company.state].filter(Boolean).join(', ') || null;
  const topOpportunity = opportunities?.[0];

  const evidence = [];
  if (websiteAudit?.status === 'no_website') evidence.push(`No official website detected for ${name}`);
  else if (websiteAudit?.status === 'broken') evidence.push(`${name}'s website returns an error (HTTP ${websiteAudit.httpStatus ?? 'unknown'}) instead of a working page`);
  else if (websiteAudit?.status === 'inaccessible') evidence.push(`${name}'s website could not be reached (DNS/timeout failure)`);
  else if (websiteAudit && ['poor', 'outdated'].includes(websiteAudit.health)) {
    evidence.push(`${name}'s website health is rated "${websiteAudit.health}"${websiteAudit.signals?.length ? ` (${websiteAudit.signals[0]})` : ''}`);
  }
  if (scoring?.hasActiveSignal) evidence.push(`${name} has an active buying signal — they explicitly asked for this kind of work`);
  if (company.employee_count) evidence.push(`~${company.employee_count} employees on record`);
  if (scoring?.reasons?.length) evidence.push(...scoring.reasons.slice(0, 3));

  // e.g. "Restaurant Website / Booking System" — the industry noun + the real gap found.
  const recommendedService = topOpportunity
    ? `${noun.replace(/^./, (c) => c.toUpperCase())} ${topOpportunity.label}`
    : scoring?.recommendedService || 'Digital Presence Audit';

  let problem;
  if (websiteAudit?.status === 'no_website') {
    problem = `No official website detected for an established ${noun}${location ? ` in ${location}` : ''}.`;
  } else if (websiteAudit?.status === 'broken') {
    problem = `${name}'s website is broken — visitors currently hit an error instead of a working page.`;
  } else if (websiteAudit?.status === 'inaccessible') {
    problem = `${name}'s website could not be reached during our check (DNS lookup or connection timed out).`;
  } else if (websiteAudit && ['poor', 'outdated'].includes(websiteAudit.health)) {
    problem = `${name}'s current website is outdated/underperforming (health: "${websiteAudit.health}"), which likely hurts conversion and mobile visitors.`;
  } else if (topOpportunity) {
    problem = `${name} has a website, but ${describeGap(topOpportunity)}.`;
  } else {
    problem = `${noun.replace(/^./, (c) => c.toUpperCase())} businesses like ${name} typically have room to improve digital operations (booking, CRM, or automation).`;
  }

  const salesAngle = topOpportunity
    ? `Lead with ${topOpportunity.label} for ${name} — ${describeGap(topOpportunity)}.`
    : `Lead with a free digital-presence audit for ${name}.`;

  let suggestedOutreach;
  if (websiteAudit?.status === 'no_website') {
    const gapNoun = BOOKING_NOUN[noun] || 'enquiries and bookings';
    suggestedOutreach = `Your ${noun} has an established local presence, but an official website could make ${gapNoun} easier.`;
  } else if (websiteAudit?.status === 'broken' || websiteAudit?.status === 'inaccessible') {
    suggestedOutreach = `We noticed ${name}'s website isn't loading correctly for visitors right now — happy to take a quick look and quote a fix.`;
  } else if (websiteAudit && ['poor', 'outdated'].includes(websiteAudit.health)) {
    suggestedOutreach = `Reference that ${name}'s site could use a refresh (mobile-friendliness, speed, or design) and offer a free audit.`;
  } else {
    suggestedOutreach = `Reference something specific and true about ${name} (industry, location, or their current site) and offer a free audit.`;
  }

  return {
    problem,
    evidence,
    recommendedService,
    whyGoodProspect: evidence.join('; ') || 'Matches your configured target industry/location.',
    salesAngle,
    suggestedOutreach,
    modelVersion: 'rule-based-v1',
  };
}

module.exports = { qualify, industryNoun };
