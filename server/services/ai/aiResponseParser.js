/**
 * Validates + normalizes Nemotron's raw JSON output for both AI qualification
 * and AI outreach generation. Never trusts the model's shape: every field is
 * type-checked, length-capped, and defaulted — a malformed/partial response
 * still produces a safe, usable object rather than throwing, so one bad model
 * response can never break the lead-generation pipeline (only a response with
 * NO extractable JSON object at all is treated as a hard failure — the caller
 * decides whether to retry).
 */
const { extractJson } = require('./jsonExtract');

const QUALIFICATION_STATUSES = ['high_potential', 'medium_potential', 'low_potential', 'insufficient_data'];

const str = (v, max = 2000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const strArray = (v, max = 10, itemMax = 300) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, itemMax)).slice(0, max)
    : [];
const clamp = (v, lo, hi, fallback = null) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback);

/**
 * @param {string} rawContent — Nemotron's raw completion text.
 * @param {{ allowedServices: string[] }} opts
 * @returns {{ ok: boolean, error?: string, data?: object }}
 */
function parseQualificationOutput(rawContent, { allowedServices = [] } = {}) {
  const json = extractJson(rawContent);
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Could not extract a JSON object from the Nemotron response' };
  }

  const wq = json.website_quality && typeof json.website_quality === 'object' ? json.website_quality : {};
  const q = json.qualification && typeof json.qualification === 'object' ? json.qualification : {};
  const out = json.outreach && typeof json.outreach === 'object' ? json.outreach : {};

  const statusRaw = String(q.status || '').toLowerCase().trim();
  const status = QUALIFICATION_STATUSES.includes(statusRaw) ? statusRaw : 'insufficient_data';

  let relevantService = str(json.relevant_service, 60);
  if (relevantService) {
    const exact = allowedServices.find((s) => s === relevantService);
    const ci = exact || allowedServices.find((s) => s.toLowerCase() === relevantService.toLowerCase());
    relevantService = ci || null; // not one of Codefloor's 5 real services — drop rather than pass through an invented one
  }

  return {
    ok: true,
    data: {
      business_summary: str(json.business_summary, 2000) || '',
      website_quality: {
        score: clamp(wq.score, 0, 100, null),
        issues: strArray(wq.issues, 10, 200),
      },
      technology_opportunities: strArray(json.technology_opportunities, 10, 150),
      likely_business_needs: strArray(json.likely_business_needs, 10, 150),
      buying_signals: strArray(json.buying_signals, 10, 200),
      relevant_service: relevantService,
      qualification: {
        status,
        reason: str(q.reason, 1000) || '',
        confidence: clamp(q.confidence, 0, 100, 0),
      },
      outreach: {
        angle: str(out.angle, 500) || '',
        personalization_points: strArray(out.personalization_points, 8, 200),
      },
    },
  };
}

/**
 * @param {string} rawContent
 * @returns {{ ok: boolean, error?: string, data?: { subject: string|null, body: string, personalization_points: string[] } }}
 */
function parseOutreachOutput(rawContent) {
  const json = extractJson(rawContent);
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Could not extract a JSON object from the Nemotron response' };
  }
  const body = str(json.body, 3000);
  if (!body) return { ok: false, error: 'Nemotron response had no usable "body" text' };
  return {
    ok: true,
    data: {
      subject: str(json.subject, 200),
      body,
      personalization_points: strArray(json.personalization_points, 8, 200),
    },
  };
}

module.exports = { parseQualificationOutput, parseOutreachOutput, QUALIFICATION_STATUSES };
