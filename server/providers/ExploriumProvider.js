/**
 * ExploriumProvider — B2B company discovery via Explorium AgentSource's official
 * REST API (https://developers.explorium.ai/, base https://api.explorium.ai/v1).
 *
 * Everything here is taken from the public docs, nothing is guessed:
 *   - Auth:          `api_key` request header (reference/setup/getting_your_api_key)
 *   - Search:        POST /businesses            (reference/businesses/fetch_businesses)
 *   - Autocomplete:  GET  /businesses/autocomplete — standardized filter values
 *   - Credits:       GET  /credits               (reference/credits/get_active_credits_summary)
 *   - Errors:        { details, correlation_id }; 401 auth, 403 permissions/credits,
 *                    422 validation, 429 rate limit (Retry-After), 5xx (reference/error-handling)
 *   - Rate limit:    200 queries/min per key      (reference/rate-limit)
 *
 * NOT verified against a live key (none was configured when this was written) —
 * only against a local stub that replays the documented shapes
 * (seed/explorium-check.js).
 *
 * Businesses carry no email/phone: Explorium only exposes contact details per
 * person (POST /prospects/contacts_information/enrich, 2-5 credits each). That
 * is deliberately not implemented — every normalized result has email/phone null.
 *
 * Deliberately NOT in the discovery registry: the Explorium module is separate
 * from Company Discovery / automation.
 */
const config = require('../config/config');

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'];
const MAX_PAGE_SIZE = 100; // docs: "up to 100 records per page"

class ExploriumError extends Error {
  constructor(message, { statusCode, code, retryAfter } = {}) {
    super(message);
    this.name = 'ExploriumError';
    this.statusCode = statusCode;
    this.code = code; // NOT_CONFIGURED | AUTH_FAILED | USAGE_LIMIT | RATE_LIMITED | SERVICE_UNAVAILABLE | BAD_REQUEST
    this.retryAfter = retryAfter;
  }
}

function classifyHttpError(status, json, headers) {
  // 422 bodies are FastAPI-style `{ detail: [...] }`; everything else is `{ details }`.
  const raw = json?.details ?? json?.detail ?? json?.message;
  const detail = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300) : null;
  if (status === 401) return new ExploriumError('Explorium rejected the API key', { statusCode: status, code: 'AUTH_FAILED' });
  if (status === 403) {
    return /credit/i.test(detail || '')
      ? new ExploriumError('Explorium credits are exhausted', { statusCode: status, code: 'USAGE_LIMIT' })
      : new ExploriumError(`Explorium denied access${detail ? `: ${detail}` : ''}`, { statusCode: status, code: 'AUTH_FAILED' });
  }
  if (status === 429) {
    const retryAfter = Number(headers.get('retry-after') ?? json?.retry_after) || null;
    return new ExploriumError(`Explorium rate limit exceeded${retryAfter ? ` — retry in ${retryAfter}s` : ''}`, { statusCode: status, code: 'RATE_LIMITED', retryAfter });
  }
  if (status >= 500) return new ExploriumError(`Explorium service unavailable (HTTP ${status})`, { statusCode: status, code: 'SERVICE_UNAVAILABLE' });
  return new ExploriumError(detail || `Explorium request failed (HTTP ${status})`, { statusCode: status, code: 'BAD_REQUEST' });
}

class ExploriumProvider {
  constructor() {
    // ponytail: unbounded-ish in-memory cache of autocomplete lookups, cleared at 500 entries; LRU if it ever matters
    this.autocompleteCache = new Map();
  }

  get key() {
    return 'explorium';
  }
  get label() {
    return 'Explorium';
  }

  isConfigured() {
    return !!config.explorium.apiKey;
  }

  /** Low-level request. No automatic retries — a 429 is surfaced, never worked around. */
  async request(method, path, { body, query, creditUsage = false } = {}) {
    if (!this.isConfigured()) throw new ExploriumError('Explorium is not configured (set EXPLORIUM_API_KEY)', { code: 'NOT_CONFIGURED' });

    const url = new URL(config.explorium.baseUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

    const headers = { accept: 'application/json', api_key: config.explorium.apiKey };
    if (body) headers['content-type'] = 'application/json';
    if (creditUsage) headers['credit-usage'] = 'true'; // docs: adds a credit_usage object to the response

    let res;
    let text;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(config.explorium.timeoutMs) });
      text = await res.text();
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new ExploriumError(timedOut ? 'Explorium request timed out' : 'Could not reach Explorium', { code: 'SERVICE_UNAVAILABLE' });
    }

    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (res.ok) throw new ExploriumError('Explorium returned an unreadable response', { statusCode: res.status, code: 'SERVICE_UNAVAILABLE' });
    }
    if (!res.ok) throw classifyHttpError(res.status, json, res.headers);
    return json;
  }

  /** Remaining credit balance — also the cheapest way to prove the key works. */
  async getCredits() {
    const json = await this.request('GET', '/credits');
    return {
      allocated: json.allocated_credits ?? null,
      remaining: json.remaining_credits ?? null,
      accountType: json.account_type ?? null,
    };
  }

  /** Standardized filter values for free text. Returns [{ label, value }]. */
  async autocomplete(field, query) {
    const cacheKey = `${field}:${String(query).toLowerCase()}`;
    if (this.autocompleteCache.has(cacheKey)) return this.autocompleteCache.get(cacheKey);
    const json = await this.request('GET', '/businesses/autocomplete', { query: { field, query } });
    const list = (Array.isArray(json) ? json : []).filter((r) => r?.value).map((r) => ({ label: r.label || r.value, value: r.value }));
    if (this.autocompleteCache.size > 500) this.autocompleteCache.clear();
    this.autocompleteCache.set(cacheKey, list);
    return list;
  }

  /**
   * Resolve free-text input to Explorium's own value(s). A term Explorium doesn't
   * recognize is an error, not a dropped filter — dropping it would silently run a
   * broader (credit-costing) search than the one the user asked for.
   */
  async resolve(field, text, what, take) {
    const matches = (await this.autocomplete(field, text)).slice(0, take);
    if (!matches.length) throw new ExploriumError(`Explorium has no ${what} matching "${text}"`, { code: 'BAD_REQUEST' });
    return matches;
  }

  /**
   * @param {{ name?, industry?, city?, state?, country?, companySize?, hasWebsite? }} f
   * @param {{ page?: number, pageSize?: number }} pagination
   */
  async searchBusinesses(f = {}, { page = 1, pageSize = 25 } = {}) {
    const filters = {};
    const resolved = {};

    if (f.name) filters.company_name = { values: [f.name] };
    if (f.industry) {
      const m = await this.resolve('linkedin_category', f.industry, 'industry', 5);
      filters.linkedin_category = { values: m.map((x) => x.value) };
      resolved.industry = m.map((x) => x.label);
    }
    // ponytail: only the most specific location is sent, using autocomplete's top hit —
    // add a pick-from-suggestions UI if the top hit proves wrong for ambiguous names
    if (f.city) {
      const [m] = await this.resolve('city_region_country', f.city, 'city', 1);
      filters.city_region_country = { values: [m.value] };
      resolved.location = m.label;
    } else if (f.state) {
      const [m] = await this.resolve('region_country_code', f.state, 'state/region', 1);
      filters.region_country_code = { values: [m.value] };
      resolved.location = m.label;
    } else if (f.country) {
      const [m] = await this.resolve('country_code', f.country, 'country', 1);
      filters.country_code = { values: [m.value] };
      resolved.location = m.label;
    }
    if (f.companySize) filters.company_size = { values: [f.companySize] };
    if (typeof f.hasWebsite === 'boolean') filters.has_website = { value: f.hasWebsite };

    if (!Object.keys(filters).length) throw new ExploriumError('Enter at least one search filter', { code: 'BAD_REQUEST' });

    const size = Math.max(1, Math.min(Number(pageSize) || 25, MAX_PAGE_SIZE));
    const json = await this.request('POST', '/businesses', {
      creditUsage: true,
      body: { mode: 'full', size: config.explorium.maxResults, page_size: size, page: Math.max(1, Number(page) || 1), filters },
    });

    const total = Number(json.total_results) || 0;
    return {
      items: (json.data || []).map((b) => this.normalizeBusiness(b)),
      total,
      totalPages: Number(json.total_pages) || Math.max(1, Math.ceil(total / size)),
      resolved,
      creditsUsed: json.credit_usage?.total_credits ?? null,
    };
  }

  /** Map one Explorium business onto LeadHunter's flat preview shape — documented response fields only. */
  normalizeBusiness(b = {}) {
    return {
      external_id: b.business_id || null,
      company_name: b.name || null,
      website: b.website || (b.domain ? `https://${b.domain}` : null),
      domain: b.domain || null,
      industry: b.naics_description || b.sic_code_description || null,
      description: b.business_description || null,
      city: b.city_name || null,
      state: b.region || null,
      country: b.country_name || null,
      company_size: b.number_of_employees_range || null,
      revenue_range: b.yearly_revenue_range || null,
      linkedin_url: b.linkedin_profile || null,
      // Never returned for businesses — see class doc.
      email: null,
      phone: null,
      source: 'explorium',
    };
  }
}

module.exports = ExploriumProvider;
module.exports.ExploriumError = ExploriumError;
module.exports.COMPANY_SIZES = COMPANY_SIZES;
module.exports.MAX_PAGE_SIZE = MAX_PAGE_SIZE;
