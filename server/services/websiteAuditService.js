/**
 * Lightweight website audit — a single GET of the homepage (no crawling, no
 * bypassing anything). Used to detect "no website / poor / outdated / good /
 * excellent" the same way a visitor's browser would see the page.
 */

const TIMEOUT_MS = 8000;
const MODERN_SIGNALS = [
  /viewport/i, // responsive meta tag
  /react|vue|angular|next\.js|nuxt/i,
];
const OUTDATED_SIGNALS = [/<frameset/i, /<marquee/i, /<font\s/i, /flash/i, /table.*cellpadding/i];
const CMS_PATTERNS = [
  [/wp-content|wp-includes/i, 'WordPress'],
  [/cdn\.shopify\.com/i, 'Shopify'],
  [/static\.wixstatic\.com/i, 'Wix'],
  [/squarespace/i, 'Squarespace'],
  [/webflow/i, 'Webflow'],
  [/joomla/i, 'Joomla'],
];

async function fetchHomepage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'LeadHunterCRM-WebsiteAudit/1.0 (+https://codefloor.example)' },
    });
    const html = res.headers.get('content-type')?.includes('text/html') ? await res.text() : '';
    return { ok: true, status: res.status, finalUrl: res.url, html, responseTimeMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message, responseTimeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function extractTag(html, re) {
  const m = html.match(re);
  return m ? m[1].trim().slice(0, 500) : null;
}

/**
 * @param {string|null} website
 * @returns {{ status, health, isHttps, isMobileFriendly, responseTimeMs, httpStatus, pageTitle, metaDescription, technologies, opportunityScore, signals }}
 */
async function auditWebsite(website) {
  if (!website) {
    return {
      status: 'no_website',
      health: 'unknown',
      isHttps: null,
      isMobileFriendly: null,
      responseTimeMs: null,
      httpStatus: null,
      pageTitle: null,
      metaDescription: null,
      technologies: [],
      opportunityScore: 100,
      signals: ['No website on file'],
    };
  }

  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const result = await fetchHomepage(url);
  const signals = [];

  if (!result.ok || !result.status || result.status >= 400) {
    return {
      status: 'down',
      health: 'unknown',
      isHttps: /^https:/i.test(url),
      isMobileFriendly: null,
      responseTimeMs: result.responseTimeMs ?? null,
      httpStatus: result.status ?? null,
      pageTitle: null,
      metaDescription: null,
      technologies: [],
      opportunityScore: 70,
      signals: [`Website unreachable (${result.error || result.status || 'no response'})`],
    };
  }

  const html = result.html || '';
  const isHttps = /^https:/i.test(result.finalUrl || url);
  const isMobileFriendly = /name=["']viewport["']/i.test(html);
  const pageTitle = extractTag(html, /<title[^>]*>([^<]*)<\/title>/i);
  const metaDescription = extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const technologies = CMS_PATTERNS.filter(([re]) => re.test(html)).map(([, name]) => name);

  let score = 0; // higher = more modern/healthy
  if (isHttps) score += 20;
  else signals.push('Not served over HTTPS');
  if (isMobileFriendly) score += 25;
  else signals.push('No mobile-responsive viewport tag');
  if (pageTitle) score += 15;
  else signals.push('Missing page title');
  if (metaDescription) score += 15;
  else signals.push('Missing meta description');
  if (result.responseTimeMs < 2000) score += 10;
  else signals.push(`Slow to load (${result.responseTimeMs}ms)`);
  if (MODERN_SIGNALS.some((re) => re.test(html))) score += 15;
  if (OUTDATED_SIGNALS.some((re) => re.test(html))) {
    score -= 30;
    signals.push('Contains outdated-era markup (frames/marquee/table layout)');
  }
  score = Math.max(0, Math.min(100, score));

  let health;
  if (score >= 80) health = 'excellent';
  else if (score >= 60) health = 'good';
  else if (score >= 40) health = 'fair';
  else if (score >= 20) health = 'poor';
  else health = 'outdated';

  return {
    status: 'live',
    health,
    isHttps,
    isMobileFriendly,
    responseTimeMs: result.responseTimeMs,
    httpStatus: result.status,
    pageTitle,
    metaDescription,
    technologies,
    opportunityScore: 100 - score, // inverse: worse site = bigger opportunity
    signals,
  };
}

module.exports = { auditWebsite, fetchHomepage };
