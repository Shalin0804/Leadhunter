/**
 * Lightweight website audit — a single GET of the homepage (no crawling, no
 * bypassing anything). Used to detect "no website / inaccessible / broken /
 * poor / outdated / good / excellent" the same way a visitor's browser would
 * see the page, plus a set of real feature flags (contact page, booking,
 * ordering, appointment, e-commerce, contact form/email/phone on page).
 *
 * Status meanings:
 *   no_website   — no website on file at all
 *   inaccessible — DNS/timeout/connection failure; we never got an HTTP response
 *   broken       — the domain resolves and responded, but with an error status (4xx/5xx)
 *   live         — a normal 2xx/3xx page was fetched and read
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

const CONTACT_PAGE_RE = /href=["'][^"']*\/?(contact|contact-us|get-in-touch|reach-us)[^"']*["']/i;
const CONTACT_FORM_RE = /<form\b[^>]*>[\s\S]{0,1000}?(type=["']email["']|name=["'][^"']*(email|message|contact)[^"']*["'])/i;
const EMAIL_ON_PAGE_RE = /mailto:[^"'\s)]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE_ON_PAGE_RE = /tel:[+\d][\d\-\s()]{6,}|(\+?\d[\d\-\s()]{8,}\d)/;
const BOOKING_RE = /\b(book\s*(a\s*)?(table|room|now)|reservation|reserve\s*now|opentable|calendly|sirvoy|book\.com)\b/i;
const ORDERING_RE = /\b(order\s*online|order\s*now|zomato|swiggy|ubereats|uber\s*eats|doordash)\b/i;
const APPOINTMENT_RE = /\b(book\s*an?\s*appointment|schedule\s*(a\s*)?(visit|consultation|appointment)|request\s*an?\s*appointment)\b/i;
const ECOMMERCE_RE = /\b(add\s*to\s*cart|shopping\s*cart|checkout|shop\s*now|buy\s*now)\b/i;
const SOCIAL_LINK_RE = /(instagram\.com|facebook\.com|wa\.me|whatsapp\.com)/i;

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
    // DNS failure, connection refused, or our own abort on timeout — never got a response.
    return { ok: false, error: e.message, responseTimeMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function extractTag(html, re) {
  const m = html.match(re);
  return m ? m[1].trim().slice(0, 500) : null;
}

function detectFeatureFlags(html) {
  const hasContactPage = CONTACT_PAGE_RE.test(html);
  const hasContactForm = CONTACT_FORM_RE.test(html);
  const emailOnPage = EMAIL_ON_PAGE_RE.test(html);
  const phoneOnPage = PHONE_ON_PAGE_RE.test(html);
  const hasBookingFeature = BOOKING_RE.test(html);
  const hasOnlineOrdering = ORDERING_RE.test(html);
  const hasAppointmentFeature = APPOINTMENT_RE.test(html);
  const hasEcommerce = ECOMMERCE_RE.test(html) || CMS_PATTERNS.some(([re, name]) => name === 'Shopify' && re.test(html));
  // "Social-only": a very thin page whose main content is just links out to social
  // media, with no real contact info of its own — a real, observable pattern, not a guess.
  const socialOnly = html.length > 0 && html.length < 3000 && SOCIAL_LINK_RE.test(html) && !hasContactPage && !emailOnPage && !phoneOnPage;
  return { hasContactPage, hasContactForm, emailOnPage, phoneOnPage, hasBookingFeature, hasOnlineOrdering, hasAppointmentFeature, hasEcommerce, socialOnly };
}

const EMPTY_FLAGS = {
  hasContactPage: false,
  hasContactForm: false,
  emailOnPage: false,
  phoneOnPage: false,
  hasBookingFeature: false,
  hasOnlineOrdering: false,
  hasAppointmentFeature: false,
  hasEcommerce: false,
  socialOnly: false,
};

/**
 * @param {string|null} website
 * @returns {{ status, health, isHttps, isMobileFriendly, responseTimeMs, httpStatus, pageTitle, metaDescription, technologies, opportunityScore, signals, featureFlags }}
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
      featureFlags: EMPTY_FLAGS,
    };
  }

  const url = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const result = await fetchHomepage(url);

  if (!result.ok) {
    return {
      status: 'inaccessible',
      health: 'unknown',
      isHttps: /^https:/i.test(url),
      isMobileFriendly: null,
      responseTimeMs: result.responseTimeMs ?? null,
      httpStatus: null,
      pageTitle: null,
      metaDescription: null,
      technologies: [],
      opportunityScore: 90,
      signals: [`Website inaccessible — no response (${result.error || 'unknown error'})`],
      featureFlags: EMPTY_FLAGS,
    };
  }

  if (!result.status || result.status >= 400) {
    return {
      status: 'broken',
      health: 'unknown',
      isHttps: /^https:/i.test(result.finalUrl || url),
      isMobileFriendly: null,
      responseTimeMs: result.responseTimeMs ?? null,
      httpStatus: result.status ?? null,
      pageTitle: null,
      metaDescription: null,
      technologies: [],
      opportunityScore: 85,
      signals: [`Website returned an error status (HTTP ${result.status ?? 'unknown'})`],
      featureFlags: EMPTY_FLAGS,
    };
  }

  const html = result.html || '';
  const signals = [];
  const isHttps = /^https:/i.test(result.finalUrl || url);
  const isMobileFriendly = /name=["']viewport["']/i.test(html);
  const pageTitle = extractTag(html, /<title[^>]*>([^<]*)<\/title>/i);
  const metaDescription = extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const technologies = CMS_PATTERNS.filter(([re]) => re.test(html)).map(([, name]) => name);
  const featureFlags = detectFeatureFlags(html);

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
  if (!featureFlags.hasContactPage && !featureFlags.emailOnPage && !featureFlags.phoneOnPage) {
    signals.push('No contact page, email, or phone number found on the site');
  }
  if (featureFlags.socialOnly) signals.push('Site is effectively a thin page pointing to social media, not a real business site');
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
    featureFlags,
  };
}

module.exports = { auditWebsite, fetchHomepage };
