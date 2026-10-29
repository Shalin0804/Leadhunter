/**
 * Adds smaller localities around one location from OpenStreetMap (ODbL — attribution
 * "© OpenStreetMap contributors" is stored on every row and shown in the UI).
 *
 * Deliberately bounded instead of a country-wide dump: one Overpass query per admin
 * click, limited to a radius (max 25 km) around a location that has coordinates, and
 * sent through the same throttled mirrors as business discovery. This fills the gaps
 * GeoNames leaves (villages, hamlets, suburbs, neighbourhoods) only where a sales team
 * actually works.
 *
 * Identity: rows are keyed by source 'osm' + 'node/<id>' (stable OSM ids), so re-running
 * never duplicates. Cross-source: a place is skipped as already known when a location of
 * the same normalized name already exists within 2 km — never merged by name alone.
 */
const { Op } = require('sequelize');
const { Location } = require('../models');
const { overpass } = require('../providers/OsmBusinessProvider');
const { haversineKm } = require('./geoSearch');
const { normalize } = require('./locationImportService');

const PLACE_TYPES = ['suburb', 'neighbourhood', 'quarter', 'village', 'hamlet', 'town', 'locality'];
const MAX_RADIUS_KM = 25;
const SAME_PLACE_KM = 2;
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

async function discoverLocalities(parent, { radiusKm = 10, overpassFn = overpass } = {}) {
  if (parent.latitude == null || parent.longitude == null) {
    throw Object.assign(new Error('This location has no coordinates — add them first'), { statusCode: 400 });
  }
  const r = Math.min(MAX_RADIUS_KM, Math.max(1, Number(radiusKm) || 10));
  const lat = Number(parent.latitude);
  const lon = Number(parent.longitude);
  const query = `[out:json][timeout:25];\nnode["place"~"^(${PLACE_TYPES.join('|')})$"]["name"](around:${Math.round(r * 1000)},${lat},${lon});\nout 2000;`;
  const data = await overpassFn(query);

  // Only rows inside the search box can be twins — never load a whole country.
  const dLat = (r + SAME_PLACE_KM) / 111;
  const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  const nearby = await Location.findAll({
    where: {
      country_code: parent.country_code,
      [Op.or]: [{ source: 'osm', parent_id: parent.id }, { latitude: { [Op.between]: [lat - dLat, lat + dLat] }, longitude: { [Op.between]: [lon - dLon, lon + dLon] } }],
    },
    attributes: ['id', 'normalized_name', 'latitude', 'longitude', 'source', 'source_external_id'], raw: true });
  const known = new Set(nearby.filter((l) => l.source === 'osm').map((l) => l.source_external_id));
  const counts = { found: 0, imported: 0, already_imported: 0, matched_other_source: 0 };
  const rows = [];
  for (const el of data.elements || []) {
    if (el.type !== 'node' || !el.tags?.name) continue; // eslint-disable-line no-continue
    counts.found += 1;
    const ext = `node/${el.id}`;
    if (known.has(ext)) {
      counts.already_imported += 1;
      continue; // eslint-disable-line no-continue
    }
    const norm = normalize(el.tags['name:en'] || el.tags.name);
    const point = { latitude: el.lat, longitude: el.lon };
    const twin = nearby.find((l) => l.normalized_name === norm && l.latitude != null && haversineKm(point, { latitude: Number(l.latitude), longitude: Number(l.longitude) }) <= SAME_PLACE_KM);
    if (twin) {
      counts.matched_other_source += 1;
      continue; // eslint-disable-line no-continue
    }
    known.add(ext);
    rows.push({
      source: 'osm',
      source_external_id: ext,
      name: el.tags['name:en'] || el.tags.name,
      normalized_name: norm,
      alternate_names: el.tags['name:en'] && el.tags['name:en'] !== el.tags.name ? [el.tags.name] : null,
      country_code: parent.country_code,
      location_type: 'area',
      administrative_level: 3,
      feature_code: `osm:${el.tags.place}`,
      parent_id: parent.id,
      latitude: el.lat,
      longitude: el.lon,
      population: Number(el.tags.population) || null,
      metadata: { attribution: ATTRIBUTION, place: el.tags.place },
      discovered_at: new Date(),
      last_verified_at: new Date(),
    });
  }
  if (rows.length) await Location.bulkCreate(rows);
  counts.imported = rows.length;
  return { ...counts, radius_km: r, attribution: ATTRIBUTION, coverage_note: 'Only places mapped in OpenStreetMap with a name are returned; coverage varies by region.' };
}

module.exports = { discoverLocalities, PLACE_TYPES, MAX_RADIUS_KM };
