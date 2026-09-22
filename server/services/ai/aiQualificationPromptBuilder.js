/**
 * Builds the prompt sent to Nemotron for one lead's AI qualification. Every
 * fact handed to the model was already collected by the EXISTING pipeline
 * (website audit, opportunity/signal detection, deterministic scoring) — this
 * builder never fetches anything itself; it only interprets what's already on
 * the company/lead. Demands a single strict JSON object back (see
 * aiResponseParser for the shape this is parsed against).
 */

// The ONLY services Nemotron may recommend — copied verbatim from Codefloor IT
// Tech's actual service list (server/services/scoringConfig.js's targetIndustries
// / recommendedService.js drive the deterministic recommendation; this is a
// separate, deliberately narrower vocabulary for the AI's own pick).
const ALLOWED_SERVICES = [
  'Business Website Development',
  'Custom Web Application Development',
  'E-commerce',
  'Website Modernization',
  'Maintenance & Support',
];

const RESPONSE_SCHEMA_EXAMPLE = {
  business_summary: '',
  website_quality: { score: 0, issues: [] },
  technology_opportunities: [],
  likely_business_needs: [],
  buying_signals: [],
  relevant_service: 'one of the ALLOWED_SERVICES strings below, or null',
  qualification: {
    status: 'high_potential | medium_potential | low_potential | insufficient_data',
    reason: '',
    confidence: 0,
  },
  outreach: { angle: '', personalization_points: [] },
};

function buildQualificationPrompt({ company, lead, scoring, opportunities, websiteAudit, detectedSignals, activeSignals }) {
  const known = {
    company_name: company.company_name,
    industry: company.industry || null,
    city: company.city || null,
    state: company.state || null,
    website: company.website || null,
    employee_count: company.employee_count || null,
    founded_year: company.founded_year || null,
    linkedin_url: company.linkedin_url || null,
    has_email: !!company.has_email,
    has_phone: !!company.has_phone,
    contactability_score: company.contactability_score ?? null,
    discovery_source: lead?.source || null,
    times_discovered: company.times_discovered ?? null,
  };

  const website = websiteAudit
    ? {
        status: websiteAudit.status,
        health: websiteAudit.health,
        is_https: websiteAudit.isHttps,
        is_mobile_friendly: websiteAudit.isMobileFriendly,
        http_status: websiteAudit.httpStatus,
        response_time_ms: websiteAudit.responseTimeMs,
        page_title: websiteAudit.pageTitle,
        meta_description: websiteAudit.metaDescription,
        detected_technologies: websiteAudit.technologies || [],
        audit_signals: websiteAudit.signals || [],
        feature_flags: websiteAudit.featureFlags || null,
      }
    : { status: 'no_website' };

  const deterministicScoring = scoring
    ? {
        lead_score: scoring.score,
        temperature: scoring.temperature,
        opportunity_level: scoring.opportunityLevel,
        rule_based_recommended_service: scoring.recommendedService,
        breakdown: (scoring.breakdown || []).map((b) => ({ category: b.label, score: b.score, max: b.max, reasons: b.reasons })),
      }
    : null;

  const detectedOpportunities = (opportunities || []).map((o) => ({ type: o.type, label: o.label, reasons: o.reasons }));
  const websiteDetectedSignals = (detectedSignals || []).map((s) => ({
    type: s.signal_type,
    description: s.signal_description,
    strength: s.signal_strength,
  }));
  const explicitBuyingSignals = (activeSignals || []).map((s) => ({ service: s.service, headline: s.headline, detail: s.detail, source: s.source }));

  const system = `You are a B2B sales-intelligence analyst for Codefloor IT Tech, a web/software
development agency. Your job is to judge, from data ALREADY COLLECTED about one business,
whether it is a useful prospect for Codefloor's services — not to research it yourself.

STRICT RULES:
1. Use ONLY the information given to you in the BUSINESS DATA block below. Never invent facts:
   no employee counts, technologies, revenue, partnerships, customers, awards, or problems that
   were not given to you.
2. If a piece of information is missing from BUSINESS DATA, treat it as unknown. Do not guess.
3. "relevant_service" MUST be exactly one of these five strings, copied verbatim, or null if none
   clearly fits:
${ALLOWED_SERVICES.map((s) => `   - "${s}"`).join('\n')}
4. "buying_signals" may only restate signals that actually appear in BUSINESS DATA
   (detected_signals / explicit_buying_signals) — never fabricate a new one.
5. Never position Codefloor as cheap, budget, or the lowest price. Frame everything around the
   real business problem/opportunity and a practical improvement.
6. If BUSINESS DATA is too thin to say anything specific and evidenced, set
   qualification.status to "insufficient_data" and say so honestly in qualification.reason —
   do not pad the analysis to sound more confident than the data supports.
7. Respond with NOTHING but a single strict JSON object — no markdown fences, no commentary
   before or after — matching EXACTLY this shape (use null/[] for anything you have no evidence
   for; never fabricate a placeholder value):

${JSON.stringify(RESPONSE_SCHEMA_EXAMPLE, null, 2)}`;

  const user = `BUSINESS DATA (already collected by the CRM's own discovery/audit/scoring pipeline —
do not re-derive, re-crawl, or assume anything beyond this):

${JSON.stringify(
  {
    company: known,
    website,
    deterministic_scoring: deterministicScoring,
    detected_opportunities: detectedOpportunities,
    detected_signals: websiteDetectedSignals,
    explicit_buying_signals: explicitBuyingSignals,
  },
  null,
  2
)}

Analyze this business as a prospect for Codefloor IT Tech and return the JSON object described in
the system prompt.`;

  return { system, user };
}

module.exports = { buildQualificationPrompt, ALLOWED_SERVICES, RESPONSE_SCHEMA_EXAMPLE };
