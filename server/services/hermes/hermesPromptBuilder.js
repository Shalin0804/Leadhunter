/**
 * Builds the single research instruction sent to Hermes Agent for one
 * company. Demands a single strict JSON object back (see hermesResultParser
 * for the shape this is parsed against) and is explicit about the compliance
 * rules from the integration spec: public sources only, no bypassing
 * auth/CAPTCHA/paywalls, no private personal data.
 */

const SCHEMA_EXAMPLE = {
  company: {
    name: '',
    website: '',
    category: '',
    industry: '',
    description: '',
    address: '',
    city: '',
    state: '',
    country: '',
    // The primary source these company-level facts came from (usually the
    // official website or one directory listing), and your confidence in them.
    source_url: '',
    confidence: 0,
  },
  contacts: [{ name: '', role: '', email: '', phone: '', linkedin_url: '', source_url: '', confidence: 0 }],
  websites: [
    {
      url: '',
      title: '',
      meta_description: '',
      technologies: [],
      cms: '',
      ux_notes: [],
      source_url: '',
      confidence: 0,
    },
  ],
  signals: [
    {
      type: 'HIRING | EXPANSION | NEW_LOCATION | NEW_PRODUCT | RECENT_ACTIVITY | POOR_ONLINE_PRESENCE | INACTIVE_SOCIAL_PRESENCE',
      description: '',
      source_url: '',
      confidence: 0,
    },
  ],
  social_profiles: [{ platform: 'linkedin | facebook | instagram | twitter | youtube | other', url: '', active: null, source_url: '', confidence: 0 }],
  business_opportunities: [
    {
      service: '',
      reason: '',
      evidence: [{ source: '', finding: '' }],
      priority: 'HIGH | MEDIUM | LOW',
      outreach_angle: '',
    },
  ],
  research_summary: '',
  sources: [''],
  research_metadata: { agent: 'hermes', status: 'completed' },
};

const RESEARCH_DEPTH_NOTES = {
  quick: 'Quick pass: focus on official website + one or two directory/social sources for contacts and basic company info. Skip broad signal search.',
  standard: 'Standard pass: official website, public business directories, and social profiles for contacts, company info, and any observable business signals.',
  deep: 'Deep pass: also actively search for recent news/announcements, hiring activity, expansion, or new locations/products for this business, in addition to the standard checks.',
};

function buildResearchPrompt({ company, depth = 'standard' } = {}) {
  const known = {
    name: company.company_name,
    industry: company.industry || null,
    city: company.city || null,
    state: company.state || null,
    website: company.website || null,
  };

  return `You are researching ONE real business for a sales-intelligence CRM. Use only publicly
accessible web sources (the business's own website, public business directories, public social
media profiles, public news). Do NOT attempt to bypass a login wall, paywall, CAPTCHA, or any
other access control, and do NOT collect private/personal information that is not already
publicly and legitimately published by or about this business.

BUSINESS TO RESEARCH:
${JSON.stringify(known, null, 2)}

${RESEARCH_DEPTH_NOTES[depth] || RESEARCH_DEPTH_NOTES.standard}

For every fact you report, include the exact URL you found it on (source_url) and your own
confidence (0-100) that it is accurate and current. If you cannot find a real source for
something, do not include it — never invent a value.

Respond with NOTHING but a single JSON object (no markdown fences, no commentary before or
after) matching exactly this shape (omit array entries you found nothing for; use null for
unknown scalar fields — never fabricate a placeholder value):

${JSON.stringify(SCHEMA_EXAMPLE, null, 2)}`;
}

module.exports = { buildResearchPrompt, SCHEMA_EXAMPLE, RESEARCH_DEPTH_NOTES };
