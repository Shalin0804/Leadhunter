/**
 * Validates a source_url reported by Hermes before it's allowed to back a
 * "verified"/"likely" fact — see hermesResultParser. A field with no valid
 * source can never be treated as a fact, only as "inferred".
 */

const PRIVATE_HOSTNAME_RE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/i;

/** @returns {boolean} true if this looks like a real, fetchable public source URL. */
function isValidSourceUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (PRIVATE_HOSTNAME_RE.test(parsed.hostname)) return false;
  return true;
}

/** De-dupe a list of source URLs while dropping invalid ones. */
function normalizeSources(urls = []) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!isValidSourceUrl(url)) continue; // eslint-disable-line no-continue
    const key = url.trim();
    if (seen.has(key)) continue; // eslint-disable-line no-continue
    seen.add(key);
    out.push(key);
  }
  return out;
}

module.exports = { isValidSourceUrl, normalizeSources };
