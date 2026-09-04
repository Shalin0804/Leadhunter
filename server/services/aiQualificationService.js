/**
 * "AI qualification" step of the discovery pipeline.
 *
 * This is a deterministic, rule-based summarizer — not a hosted LLM call — so
 * it costs nothing and never fabricates facts about a business. It reuses the
 * same scoring/opportunity signals already computed for the lead and turns
 * them into a short, human-readable qualification write-up.
 *
 * A real LLM can be dropped in later (e.g. behind ANTHROPIC_API_KEY) by
 * replacing `qualify()`'s body while keeping the same return shape — nothing
 * else in the pipeline needs to change.
 */

function qualify({ company, scoring, opportunities, websiteAudit }) {
  const industry = company.industry || 'this business';
  const location = [company.city, company.state].filter(Boolean).join(', ') || 'an unlisted location';

  const evidence = [];
  if (websiteAudit?.status === 'no_website') evidence.push('No website found for this business');
  else if (websiteAudit && ['poor', 'outdated'].includes(websiteAudit.health)) {
    evidence.push(`Website health is "${websiteAudit.health}"${websiteAudit.signals?.length ? ` (${websiteAudit.signals[0]})` : ''}`);
  }
  if (scoring?.hasActiveSignal) evidence.push('Has an active buying signal — they asked for this kind of work');
  if (company.employee_count) evidence.push(`~${company.employee_count} employees on record`);
  if (scoring?.reasons?.length) evidence.push(...scoring.reasons.slice(0, 3));

  const problem = websiteAudit?.status === 'no_website'
    ? `${industry} businesses in ${location} without a web presence are losing discovery and credibility to competitors who have one.`
    : websiteAudit && ['poor', 'outdated'].includes(websiteAudit.health)
      ? `Their current website is outdated/underperforming, which likely hurts conversion and mobile visitors.`
      : `${industry} businesses like this typically have room to improve their digital operations (booking, CRM, or automation).`;

  const topOpportunity = opportunities?.[0];
  const salesAngle = topOpportunity
    ? `Lead with ${topOpportunity.label} — ${topOpportunity.reasons[0]}.`
    : 'Lead with a general digital-presence audit offer.';

  const suggestedOutreach = websiteAudit?.status === 'no_website'
    ? `Reference that ${company.company_name} doesn't currently have a website and offer a quick mockup/quote.`
    : `Reference something specific and true about ${company.company_name} (industry, location, or their current site) and offer a free audit.`;

  return {
    problem,
    evidence,
    recommendedService: scoring?.recommendedService || topOpportunity?.label || null,
    whyGoodProspect: evidence.join('; ') || 'Matches your configured target industry/location.',
    salesAngle,
    suggestedOutreach,
    modelVersion: 'rule-based-v1',
  };
}

module.exports = { qualify };
