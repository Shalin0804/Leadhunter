const config = require('../config/config');

/**
 * YelpBusinessProvider — business discovery via Yelp Fusion's official
 * `/businesses/search` REST API. Backend-only API key, disabled by default.
 *
 * Compliance: calls Yelp's documented public API only — no scraping, no
 * login/CAPTCHA bypass. If YELP_API_KEY is not set, `isConfigured()` returns
 * false and the discovery orchestrator simply skips this provider (OSM
 * continues on its own); this never throws or breaks the pipeline.
 *
 * KNOWN LIMITATION: Yelp's API does not return a business's own website —
 * only its Yelp profile page. `website` is therefore always null here; a
 * lead sourced from Yelp alone will show "no website" for that field until
 * a website is found via another provider or the same domain is discovered
 * by OSM and the two records are merged by dedupeService.
 */

// industry keyword -> Yelp category alias (https://docs.developer.yelp.com/docs/resources-categories)
const CATEGORY_ALIASES = {
  hotel: 'hotels',
  hotels: 'hotels',
  restaurant: 'restaurants',
  restaurants: 'restaurants',
  cafe: 'coffee',
  'real estate': 'realestateagents',
  realty: 'realestateagents',
  clinic: 'physicians',
  clinics: 'physicians',
  healthcare: 'physicians',
  'law firm': 'lawyers',
  'law firms': 'lawyers',
  legal: 'lawyers',
  school: 'education',
  schools: 'education',
  education: 'education',
  travel: 'travelservices',
  'travel agencies': 'travelservices',
  it: 'itservices',
  startup: 'itservices',
  startups: 'itservices',
  consulting: 'consulting',
  retail: 'shopping',
  gym: 'gyms',
  salon: 'hairsalons',
};

function categoryForIndustry(industry) {
  const key = String(industry || '').trim().toLowerCase();
  return CATEGORY_ALIASES[key] || CATEGORY_ALIASES[key.replace(/s$/, '')] || null; // null -> Yelp free-text `term` search instead
}

function businessToCanonical(b) {
  const loc = b.location || {};
  const addressParts = [loc.address1, loc.address2, loc.address3, loc.city, loc.state, loc.zip_code, loc.country].filter(Boolean);
  return {
    company_name: b.name || null,
    website: null, // Yelp does not expose the business's own website — see module doc.
    phone: b.phone || b.display_phone || null,
    email: null,
    city: loc.city || null,
    state: loc.state || null,
    registered_address: addressParts.join(', ') || null,
    lat: b.coordinates?.latitude ?? null,
    lon: b.coordinates?.longitude ?? null,
    external_id: b.id,
    source_url: b.url || null, // Yelp profile page
    raw_tags: { categories: (b.categories || []).map((c) => c.alias), rating: b.rating, review_count: b.review_count },
  };
}

class YelpBusinessProvider {
  get key() {
    return 'yelp';
  }
  get label() {
    return 'Yelp Fusion';
  }
  isConfigured() {
    return !!config.yelp.apiKey;
  }

  /**
   * @param {{ location: string, industry: string, limit?: number }} params
   * @returns {{ items: object[], apiCallsUsed: number }}
   */
  async searchBusinesses({ location, industry, limit = 40 }) {
    if (!this.isConfigured()) {
      throw new Error('Yelp is not configured (set YELP_API_KEY)');
    }

    const category = categoryForIndustry(industry);
    const url = new URL('https://api.yelp.com/v3/businesses/search');
    url.searchParams.set('location', location);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 50)));
    if (category) url.searchParams.set('categories', category);
    else url.searchParams.set('term', industry);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.yelp.apiKey}` } });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.description || json?.error?.code || `Yelp API error ${res.status}`;
      throw new Error(msg);
    }

    const items = (json.businesses || []).map(businessToCanonical).filter((c) => c.company_name);
    return { items, apiCallsUsed: 1 };
  }
}

module.exports = YelpBusinessProvider;
module.exports.CATEGORY_ALIASES = CATEGORY_ALIASES;
