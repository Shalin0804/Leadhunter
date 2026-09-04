const config = require('../config/config');

/**
 * GooglePlacesProvider — pre-wired upgrade path for business discovery.
 * Inactive (isConfigured() === false) until GOOGLE_PLACES_API_KEY is set — no
 * billing surprises. Once a key is added, it's a straight swap for
 * OsmBusinessProvider (same searchBusinesses() shape) with no other code
 * changes needed. Uses Places API (New) Text Search — official Google API,
 * respects Google's terms and rate limits.
 */
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

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.googlePlaces.apiKey,
        'X-Goog-FieldMask':
          'places.displayName,places.formattedAddress,places.websiteUri,places.internationalPhoneNumber,places.location,places.types,places.id',
      },
      body: JSON.stringify({ textQuery: `${industry} in ${location}`, maxResultCount: Math.min(limit, 20) }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google Places search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();

    const items = (data.places || []).map((p) => ({
      company_name: p.displayName?.text || null,
      website: p.websiteUri || null,
      phone: p.internationalPhoneNumber || null,
      email: null,
      registered_address: p.formattedAddress || null,
      city: null,
      state: null,
      lat: p.location?.latitude,
      lon: p.location?.longitude,
      external_id: p.id,
      source_url: p.id ? `https://www.google.com/maps/place/?q=place_id:${p.id}` : null,
      raw_tags: { types: p.types },
    }));

    return { items, apiCallsUsed: 1, geocodedAs: location };
  }
}

module.exports = GooglePlacesProvider;
