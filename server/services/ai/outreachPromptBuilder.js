/**
 * Builds the prompt sent to Nemotron for one AI-generated outreach draft.
 * Same non-negotiable rule as the rule-based outreachGeneratorService this
 * sits alongside: every claim in the message must trace back to real,
 * already-collected data — never invented.
 */

const CHANNEL_INSTRUCTIONS = {
  EMAIL: 'a cold outreach EMAIL. Include a short, specific subject line and a concise body (120-180 words). Sign off as "[Your name]" (a placeholder — never invent a real sender name).',
  WHATSAPP: 'a short WHATSAPP message (2-4 sentences, no subject line, conversational but professional).',
  LINKEDIN: 'a short LINKEDIN connection/outreach note (2-3 sentences, no subject line).',
  PHONE_TALKING_POINTS: 'a short SALES OPENER — 3-5 terse bullet-style talking points for a first phone call (no subject line; put the bullets in "body" separated by newlines).',
  FOLLOW_UP: 'a brief FOLLOW-UP message referencing that an earlier message was sent (no subject line unless channel is email-like; 2-4 sentences).',
};

const RESPONSE_SCHEMA_EXAMPLE = { subject: 'string or null (only for EMAIL)', body: '', personalization_points: [] };

function buildOutreachPrompt({ channel, company, analysis, aiQualification, contactName }) {
  const known = {
    company_name: company.company_name,
    industry: company.industry || null,
    city: company.city || null,
    state: company.state || null,
    contact_name: contactName || null,
    has_website: !!company.has_website,
    website: company.website || null,
    recommended_service_rule_based: analysis?.recommendedService || null,
    missing_assets: analysis?.missingAssets || [],
    detected_opportunities: (analysis?.opportunities || []).map((o) => ({ label: o.label, reasons: o.reasons })),
  };

  const ai = aiQualification
    ? {
        business_summary: aiQualification.business_summary || null,
        website_issues: aiQualification.website_quality?.issues || [],
        likely_business_needs: aiQualification.likely_business_needs || [],
        buying_signals: aiQualification.buying_signals || [],
        relevant_service: aiQualification.relevant_service || null,
        recommended_outreach_angle: aiQualification.outreach?.angle || null,
      }
    : null;

  const instruction = CHANNEL_INSTRUCTIONS[channel] || CHANNEL_INSTRUCTIONS.EMAIL;

  const system = `You write outreach messages for Codefloor IT Tech, a web/software development agency,
sounding like a professional technology partner reaching out with a genuine, specific observation —
never like a mass/spammy template.

STRICT RULES:
1. Use ONLY the facts given to you in LEAD DATA below. Never invent company facts, employee counts,
   technologies, partnerships, customers, revenue, awards, or problems that are not listed there.
2. If a website issue is listed, you may reference that exact issue. If none is listed, do not
   claim one exists.
3. Never position Codefloor as cheapest / lowest-price / budget. Focus on the business problem,
   opportunity, and a practical improvement.
4. Avoid generic filler ("we help businesses grow online") unless paired with something specific
   from LEAD DATA.
5. Write ${instruction}
6. Respond with NOTHING but a single strict JSON object — no markdown fences, no commentary —
   matching exactly this shape: ${JSON.stringify(RESPONSE_SCHEMA_EXAMPLE)}`;

  const user = `LEAD DATA:\n${JSON.stringify({ company: known, ai_qualification: ai }, null, 2)}\n\nWrite the ${channel} message now.`;

  return { system, user };
}

module.exports = { buildOutreachPrompt, CHANNEL_INSTRUCTIONS };
