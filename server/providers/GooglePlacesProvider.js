const config = require('../config/config');

/**
 * GooglePlacesProvider — pre-wired upgrade path for business discovery.
 * Inactive (isConfigured() === false) until GOOGLE_PLACES_API_KEY is set — no
 * billing surprises. Once a key is added, it's a straight swap for
 * OsmBusinessProvider (same searchBusinesses() shape) with no other code
 * changes needed. Uses Places API (New) Text Search — official Google API,
 * respects Google's terms and rate limits.
 */

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.websiteUri',
  'places.internationalPhoneNumber',
  'places.location',
  'places.types',
  'places.id',
  'nextPageToken',
].join(',');
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 3; // Google caps Text Search at 60 results (3 pages of 20) regardless
// A freshly issued nextPageToken isn't valid to use immediately — Google's docs call
// for a short wait before the next page becomes available.
const NEXT_PAGE_DELAY_MS = 2000;

/** Places API (New) returns city/state as typed address components, not a single field. */
function extractCityState(components) {
  if (!Array.isArray(components)) return { city: null, state: null };
  const byType = (type) => components.find((c) => c.types?.includes(type))?.longText || null;
  return {
    city: byType('locality') || byType('postal_town') || byType('administrative_area_level_2'),
    state: byType('administrative_area_level_1'),
  };
}

function placeToCanonical(p) {
  const { city, state } = extractCityState(p.addressComponents);
  return {
    company_name: p.displayName?.text || null,
    website: p.websiteUri || null,
    phone: p.internationalPhoneNumber || null,
    email: null, // Google Places never returns a verified email — never fabricate one.
    registered_address: p.formattedAddress || null,
    city,
    state,
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    external_id: p.id,
    source_url: p.id ? `https://www.google.com/maps/place/?q=place_id:${p.id}` : null,
    raw_tags: { types: p.types },
  };
}

async function fetchPage({ textQuery, pageSize, pageToken }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googlePlaces.apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      // A pageToken request must carry only the token — Google reuses the original
      // request's textQuery/maxResultCount and ignores (or rejects) anything else here.
      body: JSON.stringify(pageToken ? { pageToken } : { textQuery, maxResultCount: pageSize }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Google Places request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    throw new Error(`Google Places request failed: ${e.message}`); // e.g. network failure
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Google's error body (invalid key / permission denied / rate limit / quota) never
    // echoes the key back — the key is sent as a header, not in the request body — so
    // it's safe to surface this message as-is in logs and SearchRun.errors.
    const body = await res.text();
    let message = body.slice(0, 200);
    try {
      message = JSON.parse(body)?.error?.message?.slice(0, 200) || message;
    } catch {
      /* not JSON — keep the raw snippet */
    }
    throw new Error(`Google Places search failed (${res.status}): ${message}`);
  }
  return res.json();
}

class GooglePlacesProvider {
  get key() {
    return 'google_places';
  }
  get label() {
    return 'Google Places API (Phase 2 — needs a key)';
  }
  isConfigured() {
    return !!config.googlePlaces.apiKey;
  }

  async searchBusinesses({ location, industry, limit = 20 }) {
    if (!this.isConfigured()) throw new Error('Google Places is not configured (set GOOGLE_PLACES_API_KEY)');

    const textQuery = `${industry} in ${location}`;
    const items = [];
    let pageToken;
    let apiCallsUsed = 0;

    for (let page = 0; page < MAX_PAGES && items.length < limit; page += 1) {
      if (page > 0) await new Promise((r) => setTimeout(r, NEXT_PAGE_DELAY_MS));
      // eslint-disable-next-line no-await-in-loop
      const data = await fetchPage({ textQuery, pageSize: Math.min(limit - items.length, 20), pageToken });
      apiCallsUsed += 1;
      items.push(...(data.places || []).map(placeToCanonical));
      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
    }

    return { items, apiCallsUsed, geocodedAs: location };
  }
}

module.exports = GooglePlacesProvider;
