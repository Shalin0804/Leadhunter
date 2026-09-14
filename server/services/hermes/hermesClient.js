/**
 * Thin HTTP client for a Hermes Agent gateway (https://github.com/NousResearch/Hermes-Agent),
 * talking to its async task API: POST /v1/runs (submit, returns immediately),
 * GET /v1/runs/{id} (poll), POST /v1/runs/{id}/stop. Auth is a Bearer token
 * (the gateway's own `platforms.api_server.extra.key` / API_SERVER_KEY).
 *
 * Backend-only: HERMES_API_KEY never reaches the client, same pattern as
 * HunterProvider/ApolloCompanyProvider.
 *
 * HERMES_TEST_MODE short-circuits every method with a canned fixture — no
 * network call, no real agent run — so the pipeline can be developed/tested
 * without a configured gateway. See hermesTestFixture() below.
 */
const config = require('../../config/config');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class HermesClientError extends Error {
  constructor(message, { statusCode, transient = false } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.transient = transient; // network error / 5xx / timeout — safe to retry
  }
}

function isConfigured() {
  return config.hermes.testMode || !!config.hermes.baseUrl;
}

function fixtureResearchJson(companyName) {
  return JSON.stringify({
    company: { name: companyName || 'Test Company', category: null, description: null, address: null, country: null },
    contacts: [
      {
        name: 'Test Contact',
        role: 'Owner',
        email: 'contact@example.com',
        phone: null,
        linkedin_url: null,
        source_url: 'https://example.com/test-fixture/contact',
        confidence: 70,
      },
    ],
    websites: [],
    signals: [
      {
        type: 'RECENT_ACTIVITY',
        description: 'Test-mode fixture signal — not a real finding',
        source_url: 'https://example.com/test-fixture/signal',
        confidence: 60,
      },
    ],
    social_profiles: [],
    business_opportunities: [
      {
        service: 'Digital Presence Audit',
        reason: 'HERMES_TEST_MODE fixture — no real research performed',
        evidence: [{ source: 'https://example.com/test-fixture', finding: 'Fixture data for pipeline testing' }],
        priority: 'LOW',
        outreach_angle: 'N/A — test fixture',
      },
    ],
    research_summary: 'HERMES_TEST_MODE fixture result — no live Hermes Agent call was made.',
    sources: ['https://example.com/test-fixture'],
    research_metadata: { agent: 'hermes', status: 'completed' },
  });
}

async function request(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  if (!config.hermes.baseUrl) {
    throw new HermesClientError('Hermes is not configured (set HERMES_BASE_URL)');
  }
  const url = `${config.hermes.baseUrl.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.hermes.apiKey ? { Authorization: `Bearer ${config.hermes.apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || json?.error || `Hermes gateway error ${res.status}`;
      throw new HermesClientError(msg, { statusCode: res.status, transient: res.status >= 500 });
    }
    return json;
  } catch (err) {
    if (err instanceof HermesClientError) throw err;
    // AbortError (timeout) or a network-level failure (connection refused, DNS, ...) — both transient.
    throw new HermesClientError(err.message, { transient: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Submit a research task. Returns { runId }. */
async function submitRun(inputText, { idempotencyKey, companyName } = {}) {
  if (config.hermes.testMode) {
    return { runId: `test-fixture-${Date.now()}` };
  }
  const json = await request('/v1/runs', {
    method: 'POST',
    body: { input: inputText },
    timeoutMs: 15000,
  });
  const runId = json.run_id || json.id;
  if (!runId) throw new HermesClientError('Hermes did not return a run_id');
  return { runId, companyName };
}

/** One poll of a run's current status. */
async function getRun(runId, { companyName } = {}) {
  if (config.hermes.testMode) {
    return { status: 'completed', output: fixtureResearchJson(companyName), error: null };
  }
  const json = await request(`/v1/runs/${encodeURIComponent(runId)}`, { timeoutMs: 15000 });
  return { status: json.status, output: json.output || '', error: json.error || null, raw: json };
}

async function stopRun(runId) {
  if (config.hermes.testMode) return { status: 'stopping' };
  return request(`/v1/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST', timeoutMs: 10000 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a run to completion. Never throws for a normal failed/cancelled run —
 * only for a transport-level problem or exceeding `timeoutMs` (the caller
 * decides whether that's retryable).
 */
async function pollUntilDone(runId, { timeoutMs = config.hermes.timeoutMs, pollIntervalMs = 3000, companyName } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const run = await getRun(runId, { companyName });
    if (TERMINAL_STATUSES.has(run.status) || config.hermes.testMode) return run;
    if (Date.now() >= deadline) {
      throw new HermesClientError(`Hermes run ${runId} did not finish within ${timeoutMs}ms`, { transient: true });
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollIntervalMs);
  }
}

module.exports = { isConfigured, submitRun, getRun, stopRun, pollUntilDone, HermesClientError, TERMINAL_STATUSES };
