const config = require('../config/config');

/**
 * HunterProvider — public business email discovery/verification via Hunter.io's
 * official API. Backend-only (HUNTER_API_KEY never reaches the client).
 *
 * Compliance: Hunter indexes publicly-published business email addresses
 * (found on company websites, public directories) via its own crawling under
 * its own terms — this app does not scrape anything itself, it calls Hunter's
 * documented REST API. No personal/private data is requested; role-based and
 * professional addresses are preferred over personal ones.
 *
 * Free plan: 25 domain searches + 50 verifications per month (account-wide,
 * shared across the whole app — see apiUsageService for tracking).
 */
class HunterProvider {
  get key() {
    return 'hunter';
  }
  get label() {
    return 'Hunter.io';
  }
  isConfigured() {
    return !!config.hunter.apiKey;
  }

  async request(path, params = {}) {
    if (!this.isConfigured()) throw new Error('Hunter is not configured (set HUNTER_API_KEY)');
    const url = new URL(`https://api.hunter.io/v2${path}`);
    url.searchParams.set('api_key', config.hunter.apiKey);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));

    const res = await fetch(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.errors?.[0]?.details || json?.errors?.[0]?.id || `Hunter API error ${res.status}`;
      const err = new Error(msg);
      err.statusCode = res.status;
      throw err;
    }
    return json;
  }

  /** Find candidate business emails for a domain. Costs 1 Hunter search credit. */
  async domainSearch(domain) {
    const json = await this.request('/domain-search', { domain, limit: 10 });
    const d = json.data || {};
    return {
      domain: d.domain,
      organization: d.organization || null,
      pattern: d.pattern || null,
      emails: (d.emails || []).map((e) => ({
        email: e.value,
        type: e.type, // 'personal' | 'generic'
        confidence: e.confidence ?? null,
        firstName: e.first_name || null,
        lastName: e.last_name || null,
        position: e.position || null,
        department: e.department || null,
        linkedin: e.linkedin || null,
        // Hunter's own lightweight check on this address, NOT a full verifier run.
        domainVerificationStatus: e.verification?.status || null,
        sources: (e.sources || []).map((s) => s.uri).slice(0, 3),
      })),
    };
  }

  /** Run Hunter's actual deliverability check on one address. Costs 1 verification credit. */
  async verifyEmail(email) {
    const json = await this.request('/email-verifier', { email });
    const d = json.data || {};
    return {
      email: d.email,
      result: d.result, // 'deliverable' | 'undeliverable' | 'risky' | 'unknown'
      score: d.score ?? null,
      status: d.status || null,
      acceptAll: !!d.accept_all,
      disposable: !!d.disposable,
      webmail: !!d.webmail,
    };
  }

  /** Remaining monthly credits, if you want to display them. Free to call — doesn't consume credits. */
  async accountInfo() {
    const json = await this.request('/account');
    const d = json.data || {};
    return {
      searchesUsed: d.requests?.searches?.used ?? null,
      searchesAvailable: d.requests?.searches?.available ?? null,
      verificationsUsed: d.requests?.verifications?.used ?? null,
      verificationsAvailable: d.requests?.verifications?.available ?? null,
      planName: d.plan_name || null,
    };
  }
}

module.exports = HunterProvider;
