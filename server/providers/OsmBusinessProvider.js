/**
 * OsmBusinessProvider — free, no-signup business discovery via OpenStreetMap's
 * public Nominatim (geocoding) and Overpass (data query) APIs.
 *
 * Compliance: uses only OSM's official public endpoints, sends a proper
 * User-Agent, self-throttles well within their published usage policies, and
 * reads only data OSM contributors have published under the ODbL — no
 * scraping, no auth bypass. Coverage/detail varies by region (crowd-sourced),
 * so results can be sparser for some cities than a paid provider would give.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
// The main overpass-api.de instance is frequently overloaded (504s). Try a couple
// of public mirrors in order before giving up on a target.
const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 20000;
const USER_AGENT = 'LeadHunterCRM/1.0 (business discovery; contact: admin@leadhunter.local)';

// industry keyword -> OSM tag filters (best-effort; OSM coverage varies by tag/region)
const INDUSTRY_TAGS = {
  hotel: ['tourism=hotel', 'tourism=guest_house'],
  hotels: ['tourism=hotel', 'tourism=guest_house'],
  restaurant: ['amenity=restaurant', 'amenity=cafe'],
  restaurants: ['amenity=restaurant', 'amenity=cafe'],
  'real estate': ['office=estate_agent'],
  realty: ['office=estate_agent'],
  clinic: ['amenity=clinic', 'amenity=doctors'],
  clinics: ['amenity=clinic', 'amenity=doctors'],
  healthcare: ['amenity=clinic', 'amenity=doctors', 'amenity=hospital'],
  'law firm': ['office=lawyer'],
  'law firms': ['office=lawyer'],
  legal: ['office=lawyer'],
  school: ['amenity=school'],
  schools: ['amenity=school'],
  education: ['amenity=school', 'amenity=college'],
  travel: ['shop=travel_agency'],
  'travel agencies': ['shop=travel_agency'],
  manufacturer: ['man_made=works', 'craft=*'],
  manufacturers: ['man_made=works', 'craft=*'],
  startup: ['office=company', 'office=it'],
  startups: ['office=company', 'office=it'],
  it: ['office=it', 'office=company'],
  consulting: ['office=consulting'],
  retail: ['shop=*'],
  gym: ['leisure=fitness_centre'],
  salon: ['shop=hairdresser', 'shop=beauty'],
};

let lastNominatimCall = 0;
async function throttleNominatim() {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimCall));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();
}

const geocodeCache = new Map();

/** location string -> bounding box {south, north, west, east}. Cached + rate-limited per Nominatim policy. */
async function geocode(location) {
  if (geocodeCache.has(location)) return geocodeCache.get(location);
  await throttleNominatim();

  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim geocoding failed (${res.status})`);
  const data = await res.json();
  if (!data.length) throw new Error(`Could not geocode location: ${location}`);

  const [south, north, west, east] = data[0].boundingbox.map(Number);
  const box = { south, north, west, east, displayName: data[0].display_name };
  geocodeCache.set(location, box);
  return box;
}

function tagsForIndustry(industry) {
  const key = String(industry || '').trim().toLowerCase();
  return INDUSTRY_TAGS[key] || INDUSTRY_TAGS[key.replace(/s$/, '')] || ['office=company']; // generic fallback
}

function buildOverpassQuery(box, tagFilters, limit) {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`;
  const clauses = tagFilters
    .map((tf) => {
      const [k, v] = tf.split('=');
      const selector = v === '*' ? `["${k}"]` : `["${k}"="${v}"]`;
      return `  node${selector}(${bbox});\n  way${selector}(${bbox});`;
    })
    .join('\n');
  return `[out:json][timeout:25];\n(\n${clauses}\n);\nout center ${limit};`;
}

function elementToCanonical(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const website = tags.website || tags['contact:website'] || null;
  const phone = tags.phone || tags['contact:phone'] || null;
  const email = tags.email || tags['contact:email'] || null;
  const addressParts = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:city'] || tags['addr:suburb'],
    tags['addr:state'],
    tags['addr:postcode'],
    tags['addr:country'],
  ].filter(Boolean);

  return {
    company_name: tags.name || null,
    website,
    phone,
    email,
    city: tags['addr:city'] || tags['addr:suburb'] || null,
    state: tags['addr:state'] || null,
    registered_address: addressParts.join(', ') || null,
    lat,
    lon,
    osm_type: el.type,
    osm_id: el.id,
    external_id: `${el.type}/${el.id}`,
    source_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    raw_tags: tags,
  };
}

class OsmBusinessProvider {
  get key() {
    return 'osm';
  }
  get label() {
    return 'OpenStreetMap (free)';
  }
  isConfigured() {
    return true;
  }

  /**
   * @param {{ location: string, industry: string, limit?: number }} params
   * @returns {{ items: object[], apiCallsUsed: number, geocodedAs: string }}
   */
  async searchBusinesses({ location, industry, limit = 40 }) {
    const box = await geocode(location);
    const tagFilters = tagsForIndustry(industry);
    const query = buildOverpassQuery(box, tagFilters, limit);

    let lastError;
    for (const url of OVERPASS_URLS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
          body: query,
          signal: controller.signal,
        });
        if (!res.ok) {
          lastError = new Error(`Overpass query failed at ${url} (${res.status})`);
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const data = await res.json();
        const items = (data.elements || []).map(elementToCanonical).filter((c) => c.company_name);
        return { items, apiCallsUsed: 2, geocodedAs: box.displayName }; // 1 geocode + 1 overpass call
      } catch (e) {
        lastError = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('All Overpass mirrors failed');
  }
}

module.exports = OsmBusinessProvider;
module.exports.INDUSTRY_TAGS = INDUSTRY_TAGS;
