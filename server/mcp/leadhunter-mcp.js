#!/usr/bin/env node
/**
 * LeadHunter MCP server — exposes selected LeadHunter CRM functionality to Claude Code.
 *
 * Claude Code launches this over stdio (see the project's .mcp.json), using your own
 * Claude Code login — no Anthropic API key is involved anywhere. This process only
 * talks to the LeadHunter REST API with an agent token; it has no database access,
 * and the API decides what the token may do (services/agentService.js AGENT_ROUTES).
 *
 * While it runs it sends a heartbeat every HEARTBEAT_MS, which is what the AI Agent
 * dashboard's "Connected" status is based on. When Claude Code closes, this process
 * exits, the heartbeat stops and the dashboard shows Disconnected.
 *
 * Config (env, or server/.env): LEADHUNTER_API_URL, LEADHUNTER_AGENT_TOKEN.
 * stdout is the MCP protocol channel — log to stderr only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const VERSION = '1.0.0';
const fileEnv = (() => {
  try {
    return dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  } catch {
    return {};
  }
})();
const API_URL = (process.env.LEADHUNTER_API_URL || fileEnv.LEADHUNTER_API_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const TOKEN = process.env.LEADHUNTER_AGENT_TOKEN || fileEnv.LEADHUNTER_AGENT_TOKEN || '';
const HEARTBEAT_MS = parseInt(process.env.LEADHUNTER_HEARTBEAT_MS || '60000', 10);
const MAX_OUTPUT = 60000; // characters per tool result
const SESSION_ID = crypto.randomUUID();
const log = (...a) => console.error('[leadhunter-mcp]', ...a);

let currentTaskId = null;
let lastApiError = null;

async function api(method, p, { query, body, tool } = {}) {
  if (!TOKEN) throw new Error('LEADHUNTER_AGENT_TOKEN is not set. Generate one in LeadHunter → AI Agent → Connection, then put it in server/.env.');
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]))}` : '';
  let res;
  try {
    res = await fetch(`${API_URL}${p}${qs === '?' ? '' : qs}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Agent-Session': SESSION_ID, 'X-Agent-Tool': tool || '' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90000), // Render's free tier can take ~1 min to wake
    });
  } catch (err) {
    lastApiError = `LeadHunter API unreachable at ${API_URL}: ${err.message}`;
    throw new Error(lastApiError);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`LeadHunter API ${res.status}: ${json?.message || res.statusText}`);
  lastApiError = null;
  return json.data;
}

async function heartbeat() {
  try {
    const d = await api('POST', '/agent/bridge/heartbeat', { body: { client: `leadhunter-mcp/${VERSION} (Claude Code)`, current_task_id: currentTaskId } });
    return d;
  } catch (err) {
    log('heartbeat failed:', err.message);
    return null;
  }
}

const text = (data) => {
  let s = JSON.stringify(data, null, 1);
  if (s.length > MAX_OUTPUT) s = `${s.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the query or use a smaller limit]`;
  return { content: [{ type: 'text', text: s }] };
};

const server = new McpServer({ name: 'leadhunter', version: VERSION });

/** Register a tool whose failures come back to Claude as tool errors, not protocol errors. */
function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return text(await handler(args, name));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  });
}

const id = z.number().int().positive();
const page = { page: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).optional() };

const slimLead = (l) => ({
  id: l.id,
  status: l.status,
  lead_status: l.lead_status,
  lead_score: l.lead_score,
  lead_temperature: l.lead_temperature,
  recommended_service: l.recommended_service,
  next_follow_up_at: l.next_follow_up_at,
  company: l.company && {
    id: l.company.id,
    company_name: l.company.company_name,
    website: l.company.website,
    industry: l.company.industry,
    city: l.company.city,
    state: l.company.state,
    is_demo: l.company.is_demo,
  },
});
const slimList = (d, fn) => ({ items: (d.items || []).map(fn), pagination: d.pagination });

/* ---------------- agent queue ---------------- */

tool('get_agent_status', 'LeadHunter agent state: whether an admin has started the agent, which modes are enabled, connection health and task counts.', {}, (a, t) => api('GET', '/agent/bridge/status', { tool: t }));

tool(
  'get_next_task',
  'Claim the next task from the LeadHunter agent queue (highest priority first). Returns {task:null, reason} when the agent is paused/stopped or the queue is empty. A claimed task must be finished with complete_task or fail_task before its lease expires (30 min by default).',
  {},
  async (a, t) => {
    const d = await api('POST', '/agent/bridge/tasks/claim', { tool: t });
    currentTaskId = d.task?.id || null;
    if (d.task) heartbeat();
    return d;
  }
);

tool(
  'complete_task',
  'Mark a claimed task completed and store its result. Only real findings — never invent data.',
  { task_id: id, result: z.record(z.any()).describe('Structured result of the work (JSON object)') },
  async ({ task_id: taskId, result }, t) => {
    const d = await api('POST', `/agent/bridge/tasks/${taskId}/complete`, { body: { result }, tool: t });
    if (currentTaskId === taskId) currentTaskId = null;
    return d;
  }
);

tool(
  'fail_task',
  'Report that a claimed task could not be done. retryable=true returns it to the queue with backoff until its attempts run out.',
  { task_id: id, error: z.string().min(1).max(1000), retryable: z.boolean().optional() },
  async ({ task_id: taskId, error, retryable }, t) => {
    const d = await api('POST', `/agent/bridge/tasks/${taskId}/fail`, { body: { error, retryable }, tool: t });
    if (currentTaskId === taskId) currentTaskId = null;
    return d;
  }
);

/* ---------------- read ---------------- */

const leadFilters = {
  status: z.string().max(40).optional().describe('Pipeline status, e.g. NEW, CONTACTED'),
  lead_temperature: z.enum(['HOT', 'WARM', 'MEDIUM', 'LOW']).optional(),
  min_score: z.number().int().min(0).max(100).optional(),
  max_score: z.number().int().min(0).max(100).optional(),
  industry: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  has_website: z.boolean().optional(),
  sort: z.enum(['lead_score', 'created_at', 'next_follow_up_at', 'status']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  ...page,
};

tool('get_leads', 'List CRM leads (companies being prospected) with filters. Contact values are masked for the agent.', leadFilters, async (a, t) => slimList(await api('GET', '/leads', { query: a, tool: t }), slimLead));

tool(
  'search_leads',
  'Search leads by company name, CIN or website.',
  { query: z.string().min(2).max(100), ...page },
  async ({ query, ...rest }, t) => slimList(await api('GET', '/leads', { query: { search: query, ...rest }, tool: t }), slimLead)
);

tool('get_lead_details', 'Full lead record: company, websites, detected signals, sources, status history, notes, recent scores and AI qualification.', { lead_id: id }, ({ lead_id: leadId }, t) => api('GET', `/leads/${leadId}`, { tool: t }));

tool('get_lead_scores', "A lead's current rule-based score, temperature, recommended service, AI qualification fields and recent score history (with breakdown).", { lead_id: id }, async ({ lead_id: leadId }, t) => {
  const d = await api('GET', `/leads/${leadId}`, { tool: t });
  const l = d.lead || d;
  const pick = Object.fromEntries(Object.entries(l).filter(([k]) => /^(id|lead_score|lead_temperature|recommended_service|ai_)/.test(k) && k !== 'ai_analysis'));
  return { ...pick, score_history: l.scoreHistory || [] };
});

tool(
  'get_companies',
  'List discovered companies (all companies, including those not yet converted to leads).',
  { search: z.string().max(100).optional(), industry: z.string().max(100).optional(), city: z.string().max(100).optional(), has_website: z.boolean().optional(), min_score: z.number().int().min(0).max(100).optional(), ...page },
  async (a, t) => {
    const d = await api('GET', '/companies', { query: a, tool: t });
    return slimList(d, (c) => ({ id: c.id, company_name: c.company_name, website: c.website, industry: c.industry, city: c.city, state: c.state, lead_score: c.lead_score, lead_temperature: c.lead_temperature, is_demo: c.is_demo }));
  }
);

tool('get_company_details', 'Full company record with websites, socials, contacts (masked), signals and score.', { company_id: id }, ({ company_id: companyId }, t) => api('GET', `/companies/${companyId}`, { tool: t }));

tool('get_company_contacts', "A company's stored business contacts. Values are masked for the agent; use them to know which channels exist, not to email anyone.", { company_id: id }, ({ company_id: companyId }, t) => api('GET', '/contacts', { query: { company_id: companyId, limit: 100 }, tool: t }));

tool('get_search_history', 'Past discovery / automation runs (what was searched, where, how many companies found).', { ...page }, (a, t) => api('GET', '/automation/runs', { query: a, tool: t }));

tool('get_discovery_statistics', 'Discovery and lead-generation statistics: companies discovered, sources, conversion to leads.', {}, async (a, t) => ({
  discovery: await api('GET', '/discovery/stats', { tool: t }),
  lead_generation: await api('GET', '/dashboard/lead-generation', { tool: t }),
}));

tool('get_automation_status', 'Status of LeadHunter automatic lead generation: schedule, last runs, health.', {}, (a, t) => api('GET', '/dashboard/automation-status', { tool: t }));

/* ---------------- write ---------------- */

tool(
  'add_lead_notes',
  'Add a note to a lead or company timeline (visible to the sales team, attributed to the admin who issued the agent token). Start it with "[Claude]" so the team knows it is AI-written.',
  { lead_id: id.optional(), company_id: id.optional(), note: z.string().min(1).max(5000) },
  ({ lead_id: leadId, company_id: companyId, note }, t) => {
    if (!leadId && !companyId) throw new Error('lead_id or company_id is required');
    return api('POST', '/notes', { body: { lead_id: leadId, company_id: companyId, body: note }, tool: t });
  }
);

tool(
  'create_followup_task',
  "Create a follow-up task on a lead for the sales team. It is only a reminder in the CRM — nothing is sent to the prospect.",
  { lead_id: id, title: z.string().min(2).max(200), description: z.string().max(5000).optional(), due_date: z.string().datetime({ offset: true }).optional().describe('ISO 8601'), priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional() },
  ({ lead_id: leadId, title, description, due_date: dueDate, priority }, t) =>
    api('POST', '/tasks', { body: { lead_id: leadId, title, description, due_date: dueDate, priority, is_follow_up: true }, tool: t })
);

/* ---------------- research (read-only CRM analysis; you do the public-web research) ---------------- */

const companyAnalysis = (companyId, live, t) => api('GET', `/agent/bridge/research/company/${companyId}`, { query: { live: live ? 'true' : undefined }, tool: t });
const leadAnalysis = (leadId, live, t) => api('GET', `/agent/bridge/research/lead/${leadId}`, { query: { live: live ? 'true' : undefined }, tool: t });

tool(
  'research_company',
  "Start company research: everything LeadHunter knows about the company (profile, stored website audit, rule-based score breakdown, opportunities, signals, previous agent reports). Then verify and extend it on the company's public website, and save the result with save_research_report (kind company_research) citing source URLs.",
  { company_id: id },
  ({ company_id: companyId }, t) => companyAnalysis(companyId, false, t)
);

tool(
  'analyse_company_website',
  "Fetch the company's homepage NOW (one page, the same audit discovery uses) and return status, HTTPS, mobile-friendliness, speed, title/meta, detected technologies and feature flags (booking, e-commerce, contact form…). Nothing is saved.",
  { company_id: id },
  async ({ company_id: companyId }, t) => {
    const a = await companyAnalysis(companyId, true, t);
    return { company: a.company, website_audit: a.website_audit };
  }
);

tool(
  'find_potential_website_improvements',
  'Live website audit plus the opportunities LeadHunter derives from it (missing booking, e-commerce, mobile issues, outdated site…). Use it to list concrete, verifiable improvements Codefloor IT could offer.',
  { company_id: id },
  async ({ company_id: companyId }, t) => {
    const a = await companyAnalysis(companyId, true, t);
    return { company: a.company, website_audit: a.website_audit, opportunities: a.opportunities, missing_assets: a.rule_based.missing_assets };
  }
);

tool(
  'detect_business_signals',
  'Business signals for a company: signals already stored, signals detected now from a live website check, and buying-intent signals captured from permitted channels.',
  { company_id: id },
  async ({ company_id: companyId }, t) => {
    const a = await companyAnalysis(companyId, true, t);
    return { company: a.company, signals: a.signals };
  }
);

tool(
  'identify_public_business_contacts',
  "Which contact channels the CRM already has (values masked), plus the company website and social profiles to start from. Find PUBLIC BUSINESS contacts only (company email/phone, named roles listed on the company's own site), never private personal data; record each with its source URL in your report.",
  { company_id: id },
  async ({ company_id: companyId }, t) => {
    const a = await companyAnalysis(companyId, false, t);
    return { company: a.company, contact_channels: a.contact_channels, socials: a.socials, rules: 'Public business contacts only, each with source_url. No scraping behind logins, no private profiles, respect robots.txt and site terms.' };
  }
);

tool(
  'qualify_lead',
  "A lead's CRM state plus LeadHunter's rule-based qualification and score breakdown, as the starting point for your own qualification. Save your verdict with update_lead_score (your AI score) or save_research_report (kind lead_qualification).",
  { lead_id: id },
  ({ lead_id: leadId }, t) => leadAnalysis(leadId, false, t)
);

tool(
  'analyse_business_opportunity',
  'Opportunity view for a lead or company: rule-based opportunities, score breakdown, missing digital assets and signals. Pass lead_id or company_id.',
  { lead_id: id.optional(), company_id: id.optional() },
  async ({ lead_id: leadId, company_id: companyId }, t) => {
    if (!leadId && !companyId) throw new Error('lead_id or company_id is required');
    const a = leadId ? await leadAnalysis(leadId, false, t) : await companyAnalysis(companyId, false, t);
    return { lead: a.lead, company: a.company, opportunities: a.opportunities, rule_based: a.rule_based, signals: a.signals, rule_based_qualification: a.rule_based_qualification };
  }
);

/* ---------------- write (reports, drafts and proposals — humans approve) ---------------- */

const reportShape = {
  kind: z.enum(['company_research', 'lead_qualification', 'strategy', 'competitor', 'daily', 'weekly', 'prospecting']),
  title: z.string().min(3).max(200),
  summary: z.string().max(10000).optional(),
  content: z
    .object({
      company_overview: z.string().optional(),
      business_category: z.string().optional(),
      potential_software_requirements: z.array(z.string()).optional(),
      website_observations: z.array(z.string()).optional(),
      public_business_contacts: z.array(z.object({ name: z.string().optional(), role: z.string().optional(), channel: z.string(), value: z.string(), source_url: z.string().url() })).optional(),
      business_opportunities: z.array(z.string()).optional(),
      lead_qualification: z.object({ verdict: z.string(), reasons: z.array(z.string()).optional() }).optional(),
      recommended_next_action: z.string().optional(),
    })
    .passthrough()
    .optional()
    .describe('Structured sections; add more keys for strategy/competitor/report content'),
  source_urls: z.array(z.string().url()).max(100).describe('Every web source you used'),
  confidence: z.number().int().min(0).max(100),
  lead_id: id.optional(),
  company_id: id.optional(),
  task_id: id.optional().describe('The task you are working on, if any'),
};

tool(
  'save_research_report',
  'Save a report to LeadHunter (visible to the Main Admin under AI Agent → Research Reports). Only real, sourced findings: say "unknown" rather than guess.',
  reportShape,
  (a, t) => api('POST', '/agent/bridge/reports', { body: a, tool: t })
);

tool(
  'update_lead_score',
  "Record YOUR 0-100 score for a lead with your reasons, as a lead_qualification report. LeadHunter's rule-based score is never overwritten; admins see both side by side.",
  { lead_id: id, ai_score: z.number().int().min(0).max(100), reasons: z.array(z.string().min(3)).min(1).max(20), confidence: z.number().int().min(0).max(100), source_urls: z.array(z.string().url()).max(100).optional(), task_id: id.optional() },
  ({ lead_id: leadId, ai_score: aiScore, reasons, confidence, source_urls: urls, task_id: taskId }, t) =>
    api('POST', '/agent/bridge/reports', {
      body: { kind: 'lead_qualification', lead_id: leadId, title: `AI score ${aiScore}/100 for LEAD-${leadId}`, summary: reasons.join('\n'), content: { lead_qualification: { verdict: `${aiScore}/100`, reasons } }, ai_score: aiScore, confidence, source_urls: urls || [], task_id: taskId },
      tool: t,
    })
);

tool(
  'update_lead_status',
  "PROPOSE a change to a lead's pipeline status (field=status) or qualification (field=lead_status). It is NOT applied until the Main Admin approves it under AI Agent → Approvals.",
  { lead_id: id, field: z.enum(['status', 'lead_status']), value: z.string().min(2).max(40), reason: z.string().min(10).max(2000), task_id: id.optional() },
  (a, t) => api('POST', '/agent/bridge/proposals', { body: a, tool: t })
);

tool(
  'create_outreach_draft',
  'Save a personalised outreach DRAFT (cold email, follow-up, LinkedIn message or business proposal) for admin review. Nothing is ever sent: the admin edits, approves or rejects it, and a person sends approved drafts themselves. Ground every claim in evidence.',
  {
    lead_id: id,
    channel: z.enum(['EMAIL', 'FOLLOW_UP', 'LINKEDIN', 'PROPOSAL']),
    subject: z.string().max(255).optional(),
    body: z.string().min(1).max(20000),
    evidence: z.array(z.string().max(500)).max(30).describe('The real facts the message relies on'),
    task_id: id.optional(),
  },
  (a, t) => api('POST', '/agent/bridge/outreach', { body: a, tool: t })
);

/* ---------------- reporting (data for you to write the report; save it with save_research_report) ---------------- */

tool('generate_daily_report', 'CRM and agent activity for the last 24 hours (new leads, status changes, discovery runs, agent tasks, drafts, top new leads). Write the report and save it with kind "daily".', {}, (a, t) => api('GET', '/agent/bridge/report-data', { query: { period: 'daily' }, tool: t }));
tool('generate_weekly_report', 'CRM and agent activity for the last 7 days. Write the report and save it with kind "weekly".', {}, (a, t) => api('GET', '/agent/bridge/report-data', { query: { period: 'weekly' }, tool: t }));
tool('generate_prospecting_report', 'Top uncontacted leads by score, the industries among them, and the admin\'s targeting settings. Write prospecting priorities and save with kind "prospecting".', {}, (a, t) => api('GET', '/agent/bridge/report-data', { query: { period: 'prospecting' }, tool: t }));
tool(
  'generate_competitor_report',
  "Previous competitor reports and the admin's targeting settings. Research the competitor's PUBLIC website and positioning yourself, then save with kind \"competitor\" and source URLs.",
  {},
  async (a, t) => ({ previous_reports: await api('GET', '/agent/bridge/reports', { query: { kind: 'competitor', limit: 10 }, tool: t }), settings: (await api('GET', '/agent/bridge/status', { tool: t })).settings })
);

/* ---------------- lifecycle ---------------- */

let closing = false;
async function shutdown(reason) {
  if (closing) return;
  closing = true;
  try {
    await Promise.race([api('POST', '/agent/bridge/disconnect', { body: { reason } }), new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    /* the stale-heartbeat window covers it */
  }
  process.exit(0);
}

async function main() {
  await server.connect(new StdioServerTransport());
  log(`session ${SESSION_ID} → ${API_URL}${TOKEN ? '' : ' (no LEADHUNTER_AGENT_TOKEN set)'}`);
  const hb = await heartbeat();
  if (hb) log(`connected; agent is ${hb.control.state}`);
  else if (lastApiError) log(lastApiError);
  setInterval(heartbeat, HEARTBEAT_MS).unref();
  process.stdin.on('end', () => shutdown('Claude Code session closed'));
  process.on('SIGINT', () => shutdown('Claude Code session closed'));
  process.on('SIGTERM', () => shutdown('Claude Code session closed'));
}

main().catch((err) => {
  log('fatal:', err.message);
  process.exit(1);
});
