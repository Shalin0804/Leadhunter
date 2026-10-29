/**
 * Geographic search contract shared by discovery providers:
 *   geo = { locationId, countryCode, latitude, longitude, radiusKm }
 *
 * How the radius is honoured, per provider (reported on every SearchRun):
 *   native       — the provider's API filters by radius (OSM Overpass `around:`, Yelp
 *                  `radius`), and we still post-filter its coordinates (Yelp treats radius
 *                  as a suggestion; Overpass ways use their centre point).
 *   post_filter  — the API can't filter by radius, but returns coordinates, so results
 *                  outside the circle are dropped here.
 *   none         — no coordinates come back (LeadIQ): the radius cannot be enforced.
 * Results without coordinates are kept but counted as `unverified` — never silently
 * claimed to be inside the radius.
 */

const MAX_RADIUS_KM = 100;

const PROVIDER_RADIUS = {
  osm: { mode: 'native', maxKm: 50 },
  yelp: { mode: 'native', maxKm: 40 }, // Yelp Fusion: radius <= 40,000 m
  serper: { mode: 'post_filter' },
  google_places: { mode: 'post_filter' },
  leadiq: { mode: 'none' },
};

function haversineKm(a, b) {
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** Validate + normalize a geo target. Throws a 400-style error on bad input; returns null when no radius search is requested. */
function normalizeGeo({ latitude, longitude, radiusKm, locationId, countryCode } = {}) {
  if (!isNum(radiusKm)) return null;
  const err = (m) => Object.assign(new Error(m), { statusCode: 400 });
  const r = Number(radiusKm);
  if (r <= 0 || r > MAX_RADIUS_KM) throw err(`radius_km must be greater than 0 and at most ${MAX_RADIUS_KM}`);
  if (!isNum(latitude) || !isNum(longitude)) throw err('A radius search needs a location with coordinates');
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (lat < -90 || lat > 90) throw err('latitude must be between -90 and 90');
  if (lon < -180 || lon > 180) throw err('longitude must be between -180 and 180');
  return { latitude: lat, longitude: lon, radiusKm: r, locationId: locationId || null, countryCode: countryCode || null };
}

/** The radius a provider will actually be asked for (clamped to its maximum). */
function providerGeo(providerKey, geo) {
  if (!geo) return null;
  const cap = PROVIDER_RADIUS[providerKey];
  if (!cap || cap.mode !== 'native') return null;
  return { ...geo, radiusKm: Math.min(geo.radiusKm, cap.maxKm) };
}

/** Drop items with coordinates outside the circle. Returns { kept, excluded, unverified }. */
function applyRadius(items, geo) {
  if (!geo) return { kept: items, excluded: 0, unverified: 0 };
  let excluded = 0;
  let unverified = 0;
  const kept = items.filter((it) => {
    if (!isNum(it.lat) || !isNum(it.lon)) {
      unverified += 1;
      return true;
    }
    const inside = haversineKm(geo, { latitude: Number(it.lat), longitude: Number(it.lon) }) <= geo.radiusKm;
    if (!inside) excluded += 1;
    return inside;
  });
  return { kept, excluded, unverified };
}

/** One provider's entry for SearchRun.search_params.radius. */
function radiusReport(providerKey, geo, { excluded, unverified, total }) {
  const cap = PROVIDER_RADIUS[providerKey] || { mode: 'none' };
  const sent = providerGeo(providerKey, geo);
  const enforced = cap.mode !== 'none' && unverified === 0;
  return {
    mode: cap.mode,
    requested_km: geo.radiusKm,
    sent_to_provider_km: sent ? sent.radiusKm : null,
    results: total,
    excluded_outside_radius: excluded,
    without_coordinates: unverified,
    enforced, // true only when every kept result was checked against the circle
    note:
      cap.mode === 'none'
        ? 'Provider returns no coordinates — radius could not be enforced'
        : unverified
          ? `${unverified} result(s) had no coordinates and could not be checked`
          : sent && sent.radiusKm < geo.radiusKm
            ? `Provider maximum is ${sent.radiusKm} km`
            : null,
  };
}

module.exports = { MAX_RADIUS_KM, PROVIDER_RADIUS, haversineKm, normalizeGeo, providerGeo, applyRadius, radiusReport };
