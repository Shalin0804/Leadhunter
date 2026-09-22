/**
 * Thin, reusable client for NVIDIA NIM's OpenAI-compatible Chat Completions API
 * (https://integrate.api.nvidia.com/v1), used as LeadHunter's AI intelligence
 * layer (aiQualificationService, outreachGeneratorService). One client
 * instance is created lazily and reused — nothing else in the app should call
 * `new OpenAI(...)` directly.
 *
 * Backend-only: NVIDIA_API_KEY never reaches the client, never appears in a
 * log line or an API response — same pattern as HunterProvider/hermesClient.
 *
 * NVIDIA_TEST_MODE short-circuits every call with a canned fixture — no
 * network call, no real API spend — so the AI pipeline can be developed/tested
 * without a configured key. See fixtureContent() below.
 */
const OpenAI = require('openai');
const config = require('../../config/config');

class NvidiaClientError extends Error {
  constructor(message, { statusCode, transient = false, code } = {}) {
    super(message);
    this.name = 'NvidiaClientError';
    this.statusCode = statusCode;
    this.transient = transient; // network error / 5xx / timeout / rate-limit — safe to retry
    this.code = code;
  }
}

let client = null;
function getClient() {
  if (!config.nvidia.apiKey) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: config.nvidia.apiKey,
      baseURL: config.nvidia.baseUrl,
      timeout: config.nvidia.timeoutMs,
      maxRetries: 0, // retries are handled by the calling service (needs to know WHY a retry happened)
    });
  }
  return client;
}

function isConfigured() {
  return config.nvidia.testMode || !!config.nvidia.apiKey;
}

const QUALIFICATION_FIXTURE = {
  business_summary: 'NVIDIA_TEST_MODE fixture — no live Nemotron call was made.',
  website_quality: { score: 50, issues: ['NVIDIA_TEST_MODE fixture issue — not a real finding'] },
  technology_opportunities: ['Fixture opportunity'],
  likely_business_needs: ['Fixture business need'],
  buying_signals: [],
  relevant_service: 'Business Website Development',
  qualification: { status: 'medium_potential', reason: 'NVIDIA_TEST_MODE fixture result.', confidence: 50 },
  outreach: { angle: 'Fixture outreach angle — test mode only.', personalization_points: [] },
};

const OUTREACH_FIXTURE = {
  subject: 'NVIDIA_TEST_MODE fixture subject',
  body: 'NVIDIA_TEST_MODE fixture message — no live Nemotron call was made.',
  personalization_points: [],
};

function fixtureContent(kind) {
  return JSON.stringify(kind === 'outreach' ? OUTREACH_FIXTURE : QUALIFICATION_FIXTURE);
}

function classifyError(err) {
  if (err instanceof NvidiaClientError) return err;
  const status = err.status || err.response?.status;
  if (status === 401 || status === 403) {
    return new NvidiaClientError('NVIDIA API key is invalid or unauthorized', { statusCode: status, transient: false, code: 'INVALID_API_KEY' });
  }
  if (status === 429) {
    return new NvidiaClientError('NVIDIA API rate limit exceeded', { statusCode: status, transient: true, code: 'RATE_LIMITED' });
  }
  if (status >= 500) {
    return new NvidiaClientError(`NVIDIA service unavailable (HTTP ${status})`, { statusCode: status, transient: true, code: 'SERVICE_UNAVAILABLE' });
  }
  if (err.name === 'APIConnectionTimeoutError' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message || '')) {
    return new NvidiaClientError('NVIDIA request timed out', { transient: true, code: 'TIMEOUT' });
  }
  if (status >= 400) {
    return new NvidiaClientError(err.message || `NVIDIA request rejected (HTTP ${status})`, { statusCode: status, transient: false, code: 'BAD_REQUEST' });
  }
  // DNS failure, connection refused, or anything else unclassified — treat as transient/network.
  return new NvidiaClientError(err.message || 'NVIDIA request failed', { transient: true, code: 'NETWORK_ERROR' });
}

/**
 * One chat completion, asked to return strict JSON. Not every NIM-hosted model
 * supports `response_format: json_object` — if the API rejects that parameter,
 * transparently retries once without it (the prompt itself already demands
 * JSON-only output; the caller's parser handles either case).
 *
 * @returns {Promise<{ content: string, usage: object|null }>}
 */
async function completeJSON({ systemPrompt, userPrompt, maxTokens = 1200, temperature = 0.3, kind = 'qualification' } = {}) {
  if (config.nvidia.testMode) {
    return { content: fixtureContent(kind), usage: null };
  }

  const c = getClient();
  if (!c) throw new NvidiaClientError('NVIDIA is not configured (set NVIDIA_API_KEY)', { transient: false, code: 'NOT_CONFIGURED' });

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const basePayload = { model: config.nvidia.model, messages, temperature, max_tokens: maxTokens };

  const attempt = async (withJsonMode) => {
    const payload = withJsonMode ? { ...basePayload, response_format: { type: 'json_object' } } : basePayload;
    const completion = await c.chat.completions.create(payload);
    const content = completion.choices?.[0]?.message?.content;
    if (!content || !content.trim()) {
      throw new NvidiaClientError('NVIDIA returned an empty response', { transient: true, code: 'EMPTY_RESPONSE' });
    }
    return { content, usage: completion.usage || null };
  };

  try {
    return await attempt(true);
  } catch (err) {
    const classified = classifyError(err);
    // Some NIM models 400 on an unsupported response_format — fall back to a
    // plain completion (still JSON-only per the prompt) instead of failing outright.
    if (classified.code === 'BAD_REQUEST' && /response_format/i.test(err.message || '')) {
      try {
        return await attempt(false);
      } catch (err2) {
        throw classifyError(err2);
      }
    }
    throw classified;
  }
}

module.exports = { isConfigured, completeJSON, NvidiaClientError };
