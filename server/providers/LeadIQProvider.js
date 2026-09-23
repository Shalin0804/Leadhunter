/**
 * LeadIQProvider — real people/company prospecting via LeadIQ's official public
 * GraphQL API (https://developer.leadiq.com/, endpoint https://api.leadiq.com/graphql).
 *
 * Schema was NOT guessed: every query/mutation/type used here was confirmed via
 * live introspection against the account's own key before this file was written
 * (flatAdvancedSearch, trackContacts, trackedContacts, account — see PR notes).
 * Auth is HTTP Basic with the API key as the username and an empty password —
 * also confirmed live (undocumented publicly).
 *
 * Two-tier data model, respected here rather than worked around:
 *   1. Profile search (flatAdvancedSearch) — name/title/company/LinkedIn only,
 *      no email/phone. Cheap.
 *   2. Contact reveal (trackContacts, async job) — email/phone for specific
 *      people you already found via #1. Costs real LeadIQ credits per person
 *      (Universal Credits) — NEVER called silently; only when explicitly
 *      requested (see revealContacts()).
 *
 * Compliance: official documented API only, no scraping, no bypassing LeadIQ's
 * own credit/rate limits.
 */
const config = require('../config/config');

class LeadIQClientError extends Error {
  constructor(message, { statusCode, transient = false, code } = {}) {
    super(message);
    this.name = 'LeadIQClientError';
    this.statusCode = statusCode;
    this.transient = transient;
    this.code = code;
  }
}

// GraphQL string-literal escaping — LeadIQ's gateway rejects standard `variables`
// payloads (confirmed live: returns "missing value for non-null variable" even
// when the variable IS present), so every query here is built by safe inline
// interpolation instead. JSON's string-escaping rules are a strict subset of
// GraphQL's, so JSON.stringify is a correct + safe escaper for string literals.
const gqlStr = (v) => JSON.stringify(String(v));
const gqlStrList = (arr) => `[${(arr || []).filter(Boolean).map(gqlStr).join(', ')}]`;

/**
 * Best-effort split of a free-text "City, State, Country" location string into
 * LeadIQ's structured LocationFilterInput. LeadIQ has no free-text geocoding
 * endpoint (unlike OSM/Google Places), so this is a documented heuristic, not a
 * guess at the API: first segment -> city, last segment -> country, anything
 * between -> areaLevel1 (state/region). A single-segment location is treated as
 * a city.
 */
function parseLocation(location) {
  if (!location) return null;
  const parts = String(location).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { city: parts[0] };
  if (parts.length === 2) return { city: parts[0], country: parts[1] };
  return { city: parts[0], areaLevel1: parts[1], country: parts[parts.length - 1] };
}

function classifyHttpError(status, body) {
  if (status === 401 || status === 403) {
    return new LeadIQClientError('LeadIQ API key is invalid or unauthorized', { statusCode: status, transient: false, code: 'INVALID_API_KEY' });
  }
  if (status === 429) {
    return new LeadIQClientError('LeadIQ API rate limit exceeded', { statusCode: status, transient: true, code: 'RATE_LIMITED' });
  }
  if (status >= 500) {
    return new LeadIQClientError(`LeadIQ service unavailable (HTTP ${status})`, { statusCode: status, transient: true, code: 'SERVICE_UNAVAILABLE' });
  }
  return new LeadIQClientError(body || `LeadIQ request failed (HTTP ${status})`, { statusCode: status, transient: false, code: 'BAD_REQUEST' });
}

class LeadIQProvider {
  get key() {
    return 'leadiq';
  }
  get label() {
    return 'LeadIQ';
  }

  isConfigured() {
    return !!config.leadiq.apiKey;
  }

  authHeader() {
    return 'Basic ' + Buffer.from(`${config.leadiq.apiKey}:`).toString('base64');
  }

  /** Low-level GraphQL request. Never throws for a GraphQL-level (data) error — only for transport/auth failures. */
  async request(query) {
    if (!this.isConfigured()) throw new LeadIQClientError('LeadIQ is not configured (set LEADIQ_API_KEY)', { transient: false, code: 'NOT_CONFIGURED' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.leadiq.timeoutMs);
    let res;
    try {
      res = await fetch(config.leadiq.baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({ query }),
      });
    } catch (err) {
      throw new LeadIQClientError(err.name === 'AbortError' ? 'LeadIQ request timed out' : err.message, { transient: true, code: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw classifyHttpError(res.status, text.slice(0, 300));
    }
    if (!res.ok) throw classifyHttpError(res.status, json?.errors?.[0]?.message);

    // A downstream-service auth failure (e.g. dataiq) comes back as HTTP 200 with a
    // GraphQL errors array, not an HTTP error — surface it the same way.
    if (json.errors?.length) {
      const msg = json.errors.map((e) => e.message).join('; ');
      const authish = json.errors.some((e) => e.extensions?.status === 401 || /unauthenticated|unauthorized/i.test(e.message));
      throw new LeadIQClientError(msg, { transient: !authish, code: authish ? 'INVALID_API_KEY' : 'GRAPHQL_ERROR' });
    }
    return json.data;
  }

  /**
   * Real people/company search via flatAdvancedSearch — no email/phone (see class doc).
   * @param {{ locations?: {city,areaLevel1,country}[], industries?: string[], titles?: string[],
   *   seniorities?: string[], companySizeMin?: number, companySizeMax?: number, keywords?: string[] }} filters
   * @param {{ limit?: number, skip?: number }} pagination
   */
  async searchPeople(filters = {}, { limit = 25, skip = 0 } = {}) {
    const companyFilterParts = [];
    if (filters.locations?.length) {
      const locObjs = filters.locations
        .map((l) => {
          const f = [];
          if (l.city) f.push(`city: ${gqlStr(l.city)}`);
          if (l.areaLevel1) f.push(`areaLevel1: ${gqlStr(l.areaLevel1)}`);
          if (l.country) f.push(`country: ${gqlStr(l.country)}`);
          return f.length ? `{ ${f.join(', ')} }` : null;
        })
        .filter(Boolean);
      if (locObjs.length) companyFilterParts.push(`locations: [${locObjs.join(', ')}]`);
    }
    if (filters.industries?.length) companyFilterParts.push(`industries: ${gqlStrList(filters.industries)}`);
    if (filters.companySizeMin != null || filters.companySizeMax != null) {
      const s = [];
      if (filters.companySizeMin != null) s.push(`min: ${Number(filters.companySizeMin)}`);
      if (filters.companySizeMax != null) s.push(`max: ${Number(filters.companySizeMax)}`);
      companyFilterParts.push(`sizes: [{ ${s.join(', ')} }]`);
    }

    const contactFilterParts = [];
    if (filters.titles?.length) contactFilterParts.push(`titles: ${gqlStrList(filters.titles)}`);
    if (filters.seniorities?.length) contactFilterParts.push(`seniorities: ${gqlStrList(filters.seniorities)}`);
    if (filters.keywords?.length) contactFilterParts.push(`roles: ${gqlStrList(filters.keywords)}`);

    const inputParts = [];
    if (companyFilterParts.length) inputParts.push(`companyFilter: { ${companyFilterParts.join(', ')} }`);
    if (contactFilterParts.length) inputParts.push(`contactFilter: { ${contactFilterParts.join(', ')} }`);
    inputParts.push(`limit: ${Math.max(1, Math.min(Number(limit) || 25, 100))}`);
    if (skip) inputParts.push(`skip: ${Number(skip)}`);

    const query = `{
      flatAdvancedSearch(input: { ${inputParts.join(', ')} }) {
        totalPeople
        people {
          id name firstName lastName title role seniority linkedinUrl city state country
          company { id name domain industry employeeCount city state country }
        }
      }
    }`;

    const data = await this.request(query);
    const result = data.flatAdvancedSearch;
    return {
      totalPeople: result.totalPeople,
      people: (result.people || []).map((p) => this.normalizePerson(p)),
    };
  }

  /** Map one LeadIQ person+company onto a flat, display-ready shape for the search preview UI. */
  normalizePerson(p = {}) {
    const c = p.company || {};
    return {
      external_id: p.id,
      contact_name: p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || null,
      first_name: p.firstName || null,
      last_name: p.lastName || null,
      job_title: p.title || null,
      seniority: p.seniority || null,
      linkedin_url: p.linkedinUrl || null,
      city: p.city || c.city || null,
      state: p.state || c.state || null,
      country: p.country || c.country || null,
      company_name: c.name || null,
      company_domain: c.domain || null,
      website: c.domain ? `https://${c.domain}` : null,
      industry: c.industry || null,
      employee_count: c.employeeCount ?? null,
      // Profile search never returns these — always null until revealContacts() runs.
      email: null,
      phone: null,
      email_status: null,
      source: 'leadiq',
    };
  }

  /**
   * Discovery-provider adapter (searchBusinesses contract) so the SAME
   * discoveryOrchestrator/automation pipeline used for osm/google_places/yelp
   * can drive LeadIQ too — see providers/index.js discoveryRegistry.
   * Automation only ever uses the free/cheap profile search; it never calls
   * revealContacts() (that stays an explicit, credit-costing manual action —
   * see server/services/leadiqImportService.js).
   * @param {{ location: string, industry: string, limit?: number }} params
   */
  async searchBusinesses({ location, industry, limit = 25 } = {}) {
    const loc = parseLocation(location);
    const { people } = await this.searchPeople(
      { locations: loc ? [loc] : undefined, industries: industry ? [industry] : undefined },
      { limit }
    );
    const items = people
      .filter((p) => p.company_name)
      .map((p) => ({
        company_name: p.company_name,
        website: p.website,
        phone: null,
        email: null,
        city: p.city,
        state: p.state,
        registered_address: null,
        external_id: p.external_id,
        source_url: p.linkedin_url,
        contact_name: p.contact_name,
        job_title: p.job_title,
        linkedin_url: p.linkedin_url,
        raw_tags: { industry: p.industry, employee_count: p.employee_count, seniority: p.seniority },
      }));
    return { items, apiCallsUsed: 1 };
  }

  /**
   * Reveal real email/phone for a batch of already-found people (trackContacts,
   * an async job) — costs real LeadIQ Universal Credits per person. Never called
   * automatically; only from an explicit user action (search modal "Reveal" /
   * leadiqImportService with reveal=true).
   * @param {Array<{external_id, first_name, last_name, company_name, company_domain, job_title, linkedin_url}>} people
   * @returns {Map<string, {email, emailStatus, phones}>} keyed by external_id (referenceId)
   */
  async revealContacts(people) {
    const usable = (people || []).filter((p) => p.first_name && p.last_name && p.company_name);
    if (!usable.length) return new Map();

    const contactInputs = usable
      .map((p) => {
        const f = [
          `companyName: ${gqlStr(p.company_name)}`,
          `firstName: ${gqlStr(p.first_name)}`,
          `lastName: ${gqlStr(p.last_name)}`,
          `referenceId: ${gqlStr(p.external_id)}`,
        ];
        if (p.company_domain) f.push(`companyDomain: ${gqlStr(p.company_domain)}`);
        if (p.job_title) f.push(`title: ${gqlStr(p.job_title)}`);
        if (p.linkedin_url) f.push(`personalLinkedInUrl: ${gqlStr(p.linkedin_url)}`);
        return `{ ${f.join(', ')} }`;
      })
      .join(', ');

    const importId = `leadhunter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const trackMutation = `mutation {
      trackContacts(input: {
        importId: ${gqlStr(importId)}
        unlockRequests: [PersonEmail, PersonPhone]
        contacts: [${contactInputs}]
      }) { importId totalCount batchCount errors errorCode }
    }`;

    const trackResult = await this.request(trackMutation);
    const track = trackResult.trackContacts;
    if (track.errors?.length) {
      throw new LeadIQClientError(`LeadIQ contact reveal rejected: ${track.errors.join('; ')}`, { transient: false, code: track.errorCode || 'REVEAL_REJECTED' });
    }

    // Poll trackedContacts until the async reveal job finishes or we time out.
    const deadline = Date.now() + config.leadiq.revealTimeoutMs;
    const byRef = new Map();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const data = await this.request(
        `{ trackedContacts(importId: ${gqlStr(track.importId)}, limit: 100) {
          isProcessing
          edges { node { referenceId email emailStatus phones firstName lastName company companyDomain title linkedIn } }
        } }`
      );
      const conn = data.trackedContacts;
      for (const edge of conn.edges || []) {
        const n = edge.node;
        if (n.referenceId) byRef.set(n.referenceId, { email: n.email || null, emailStatus: n.emailStatus || null, phones: n.phones || [] });
      }
      if (!conn.isProcessing) break;
      if (Date.now() >= deadline) {
        throw new LeadIQClientError(`LeadIQ contact reveal did not finish within ${config.leadiq.revealTimeoutMs}ms`, { transient: true, code: 'REVEAL_TIMEOUT' });
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return byRef;
  }

  /** Credit balance — surfaced in the search modal before the user spends anything. */
  async getAccountUsage() {
    const data = await this.request('{ account { universalPlan { name status available used } dataHubPlan { name status available used } } }');
    return data.account;
  }
}

module.exports = LeadIQProvider;
module.exports.LeadIQClientError = LeadIQClientError;
module.exports.parseLocation = parseLocation;
