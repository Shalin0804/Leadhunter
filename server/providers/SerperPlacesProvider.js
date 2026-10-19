const config = require('../config/config');

/**
 * SerperPlacesProvider — business discovery via Serper.dev's Google Places
 * endpoint (POST https://google.serper.dev/places, X-API-KEY header).
 * Cheaper alternative to the official Google Places API. Disabled until
 * SERPER_API_KEY is set; the orchestrator skips it when unconfigured.
 *
 * Serper returns the address as a single string, so city/state are taken from
 * the searched location rather than parsed out of it.
 */

const SEARCH_URL = 'https://google.serper.dev/places';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 3; // ~10 results per page

function placeToCanonical(p, { city, state }) {
  return {
    company_name: p.title || null,
    website: p.website || null,
    phone: p.phoneNumber || null,
    email: null, // never fabricated
    registered_address: p.address || null,
    city,
    state,
    lat: p.latitude ?? null,
    lon: p.longitude ?? null,
    external_id: p.cid || p.placeId || null,
    source_url: p.cid ? `https://maps.google.com/?cid=${p.cid}` : null,
    raw_tags: { category: p.category, rating: p.rating, rating_count: p.ratingCount },
  };
}

async function fetchPage(q, page) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': config.serper.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, page }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Serper request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new Error(`Serper request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Serper search failed (${res.status}): ${String(json.message || '').slice(0, 200)}`);
  return json;
}

class SerperPlacesProvider {
  get key() {
    return 'serper';
  }
  get label() {
    return 'Serper.dev (Google Places)';
  }
  isConfigured() {
    return !!config.serper.apiKey;
  }

  async searchBusinesses({ location, industry, limit = 20 }) {
    if (!this.isConfigured()) throw new Error('Serper is not configured (set SERPER_API_KEY)');

    const [city = null, state = null] = String(location).split(',').map((s) => s.trim() || null);
    const q = `${industry} in ${location}`;
    const items = [];
    let apiCallsUsed = 0;

    for (let page = 1; page <= MAX_PAGES && items.length < limit; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchPage(q, page);
      apiCallsUsed += 1;
      const places = data.places || [];
      items.push(...places.map((p) => placeToCanonical(p, { city, state })).filter((c) => c.company_name));
      if (places.length < 10) break; // last page
    }

    return { items: items.slice(0, limit), apiCallsUsed, geocodedAs: location };
  }
}

module.exports = SerperPlacesProvider;
