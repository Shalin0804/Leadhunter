/**
 * "AI qualification" step of the discovery pipeline.
 *
 * `qualify()` below is a deterministic, rule-based summarizer — not a hosted
 * LLM call — so it costs nothing and never fabricates facts about a business.
 * It reuses the same scoring/opportunity signals already computed for the
 * lead and turns them into a short, specific, human-readable qualification
 * write-up that names the actual company, its industry, and the real
 * evidence found (never a generic template with no company reference). It
 * keeps running unconditionally, for every lead, regardless of whether
 * Nemotron is configured.
 *
 * `qualifyWithNemotron()` (bottom of this file) is the real hosted-LLM
 * qualification, via NVIDIA NIM's Nemotron model — an additional, optional
 * intelligence layer on top of the above, not a replacement for it.
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

/**
 * ---------------------------------------------------------------------------
 * Nemotron (NVIDIA NIM) AI qualification — a second, LLM-backed intelligence
 * layer that sits ALONGSIDE `qualify()` above, not instead of it. `qualify()`
 * keeps running unconditionally (free, deterministic, never fails) and its
 * output keeps populating Lead.ai_problem/ai_evidence/ai_sales_angle exactly
 * as before; this section only adds the separate Lead.ai_* Nemotron fields
 * (ai_qualification_status, ai_confidence, ai_summary, ai_recommended_service,
 * ai_outreach_angle, ai_analysis, ai_processing_status, ...) and never touches
 * lead_score / lead_temperature / recommended_service (the deterministic
 * scoring engine in leadScoring.js remains the single source of truth there).
 * ---------------------------------------------------------------------------
 */
const { Lead, Company, CompanyContact, CompanyWebsite, CompanySocial, DetectedSignal, Signal, Activity } = require('../models');
const config = require('../config/config');
const nvidiaClient = require('./ai/nvidiaClient');
const { buildQualificationPrompt, ALLOWED_SERVICES } = require('./ai/aiQualificationPromptBuilder');
const { parseQualificationOutput } = require('./ai/aiResponseParser');
const { scoreCompany } = require('./leadScoring');
const { detectOpportunities } = require('./opportunityDetectionService');
const apiUsage = require('./apiUsageService');

const NVIDIA_NOT_CONFIGURED = 'NVIDIA_NOT_CONFIGURED';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// In-process guard only (single-server deployment, same as the rest of this app) —
// prevents a double-click / overlapping manual+automation call from spending two
// Nemotron calls on the same lead at once. Not a distributed lock.
const IN_FLIGHT = new Set();

async function loadLeadForAI(leadId) {
  return Lead.findByPk(leadId, {
    include: [
      {
        model: Company,
        as: 'company',
        include: [
          { model: CompanyContact, as: 'contacts' },
          { model: CompanyWebsite, as: 'websites' },
          { model: CompanySocial, as: 'socials' },
          { model: DetectedSignal, as: 'detectedSignals' },
          { model: Signal, as: 'signals' },
        ],
      },
    ],
  });
}

/** Same "pick the real website audit" logic as hermesResearchService.rescoreAndQualify. */
function websiteAuditFromCompany(company) {
  const websites = company.websites || [];
  const real = websites.find((w) => w.status !== 'no_website') || websites[0] || null;
  if (!real) return null;
  return {
    status: real.status,
    health: real.health,
    isHttps: real.is_https,
    isMobileFriendly: real.is_mobile_friendly,
    httpStatus: real.http_status,
    responseTimeMs: real.response_time_ms,
    pageTitle: real.page_title,
    metaDescription: real.meta_description,
    technologies: real.detected_technologies,
    signals: real.audit_signals,
    featureFlags: real.feature_flags,
  };
}

/**
 * Run one Nemotron AI-qualification attempt for a lead. Never throws for an
 * ordinary AI failure (missing key, timeout, rate limit, malformed output) —
 * the lead's ai_processing_status/ai_processing_error carry that; the lead
 * itself (and its deterministic score) is always preserved untouched.
 *
 * @param {number} leadId
 * @param {{ triggeredBy?: 'manual'|'automation', triggeredByUserId?: number|null, force?: boolean }} opts
 *   `force` re-runs even if this lead was already successfully AI-qualified —
 *   otherwise a COMPLETED lead is skipped (cost control, see Lead.ai_processed_at).
 */
async function qualifyWithNemotron(leadId, { triggeredBy = 'manual', triggeredByUserId = null, force = false } = {}) {
  const lead = await loadLeadForAI(leadId);
  if (!lead) return { status: 'failed', reason: 'Lead not found' };
  if (!lead.company) return { status: 'failed', reason: 'Lead has no associated company' };

  if (!force && lead.ai_processing_status === 'COMPLETED') {
    return { status: 'skipped', reason: 'Lead is already AI-qualified — pass force=true to re-analyze', lead };
  }
  if (IN_FLIGHT.has(leadId)) {
    return { status: 'skipped', reason: 'AI qualification is already in progress for this lead' };
  }

  IN_FLIGHT.add(leadId);
  try {
    if (!nvidiaClient.isConfigured()) {
      lead.ai_processing_status = 'SKIPPED';
      lead.ai_processing_error = `${NVIDIA_NOT_CONFIGURED}: set NVIDIA_API_KEY (see server/.env.example)`;
      lead.ai_processed_at = new Date();
      await lead.save();
      return { status: 'skipped', reason: NVIDIA_NOT_CONFIGURED, lead };
    }

    lead.ai_processing_status = 'RUNNING';
    await lead.save();
    console.log(`[ai] qualification started for lead ${leadId}`);

    const company = lead.company;
    const scoring = scoreCompany(company);
    const websiteAudit = websiteAuditFromCompany(company);
    const opportunities = detectOpportunities({ industry: company.industry, websiteAudit });
    const activeSignals = (company.signals || []).filter((s) => ['NEW', 'REVIEWED'].includes(s.status));

    const { system, user } = buildQualificationPrompt({
      company,
      lead,
      scoring,
      opportunities,
      websiteAudit,
      detectedSignals: company.detectedSignals,
      activeSignals,
    });

    const maxAttempts = Math.max(1, config.nvidia.maxRetries + 1);
    let lastError = null;
    let parsed = null;
    let attemptsUsed = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attemptsUsed = attempt;
      try {
        // eslint-disable-next-line no-await-in-loop
        const { content } = await nvidiaClient.completeJSON({ systemPrompt: system, userPrompt: user, kind: 'qualification' });
        // eslint-disable-next-line no-await-in-loop
        await apiUsage.recordUsage('nvidia', { requests: 1 });
        const result = parseQualificationOutput(content, { allowedServices: ALLOWED_SERVICES });
        if (result.ok) {
          parsed = result.data;
          lastError = null;
          break;
        }
        lastError = new Error(result.error || 'Malformed Nemotron response');
        if (attempt >= maxAttempts) break;
      } catch (err) {
        lastError = err;
        if (!err.transient || attempt >= maxAttempts) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(Math.min(10000, 2 ** attempt * 1000));
      }
    }

    if (!parsed) {
      lead.ai_processing_status = 'FAILED';
      lead.ai_processing_error = String(lastError?.message || 'Unknown AI qualification error').slice(0, 500);
      lead.ai_retry_count = (lead.ai_retry_count || 0) + attemptsUsed;
      lead.ai_processed_at = new Date();
      await lead.save();
      console.error(`[ai] qualification failed for lead ${leadId}: ${lead.ai_processing_error}`);
      return { status: 'failed', reason: lead.ai_processing_error, lead };
    }

    lead.ai_qualification_status = parsed.qualification.status;
    lead.ai_confidence = parsed.qualification.confidence;
    lead.ai_summary = parsed.business_summary;
    lead.ai_recommended_service = parsed.relevant_service;
    lead.ai_outreach_angle = parsed.outreach.angle;
    lead.ai_analysis = parsed;
    lead.ai_processing_status = 'COMPLETED';
    lead.ai_processing_error = null;
    lead.ai_processed_at = new Date();
    lead.ai_retry_count = (lead.ai_retry_count || 0) + (attemptsUsed - 1);
    lead.ai_model_version = config.nvidia.model;
    await lead.save();

    await Activity.create({
      company_id: lead.company_id,
      lead_id: lead.id,
      type: 'system',
      title: `AI qualification completed (${parsed.qualification.status.replace(/_/g, ' ')}, ${parsed.qualification.confidence}% confidence)`,
      body: parsed.business_summary || null,
    });

    console.log(`[ai] qualification completed for lead ${leadId} (triggered by ${triggeredBy}${triggeredByUserId ? ` #${triggeredByUserId}` : ''})`);
    return { status: 'completed', lead, analysis: parsed };
  } finally {
    IN_FLIGHT.delete(leadId);
  }
}

module.exports = { qualify, industryNoun, qualifyWithNemotron, NVIDIA_NOT_CONFIGURED };
