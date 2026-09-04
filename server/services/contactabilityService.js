/**
 * contactability_score: 0-10, a plain reflection of "how easily can we reach
 * this business through a legitimate channel". Deterministic, no external
 * calls — computed from whatever contact data has already been collected
 * (contacts on file, website audit feature flags, public social/LinkedIn).
 *
 * Additive rubric (Prospecting Engine 2.0, capped at 10):
 *   +3  verified business email
 *   +2  unverified-but-plausible public email (present, not yet verified)
 *   +2  business phone on file
 *   +1  contact page found on the website
 *   +1  public LinkedIn / company profile
 *   +1  website contact form detected
 *   +1  multiple contact methods available
 *
 * Never claims a channel is "verified" unless a provider's own verification
 * endpoint actually ran and said so (see enrichmentService).
 */

function computeContactability({
  contacts = [],
  hasWebsite = false,
  hasSocial = false,
  linkedinUrl = null,
  hasContactPage = false,
  hasContactForm = false,
} = {}) {
  const emails = contacts.filter((c) => c.type === 'email');
  const phones = contacts.filter((c) => c.type === 'phone');
  const hasVerifiedEmail = emails.some((c) => c.verification_status === 'VERIFIED' || c.verification_status === 'VALID');
  const hasPlausibleEmail = emails.length > 0 && !hasVerifiedEmail;
  const hasPhone = phones.length > 0;
  const hasLinkedin = !!linkedinUrl || hasSocial;

  let score = 0;
  const reasons = [];

  if (hasVerifiedEmail) {
    score += 3;
    reasons.push('Verified business email');
  } else if (hasPlausibleEmail) {
    score += 2;
    reasons.push('Unverified but plausible public email on file');
  }

  if (hasPhone) {
    score += 2;
    reasons.push('Business phone on file');
  }

  if (hasContactPage) {
    score += 1;
    reasons.push('Contact page found on the website');
  }

  if (hasLinkedin) {
    score += 1;
    reasons.push(linkedinUrl ? 'Public LinkedIn profile on file' : 'Public social/company profile found');
  }

  if (hasContactForm) {
    score += 1;
    reasons.push('Website contact form detected');
  }

  const methodCount = [hasVerifiedEmail || hasPlausibleEmail, hasPhone, hasContactPage || hasContactForm, hasLinkedin].filter(Boolean).length;
  if (methodCount >= 2) {
    score += 1;
    reasons.push('Multiple contact methods available');
  }

  if (!reasons.length) {
    reasons.push(hasWebsite ? 'Website found, but no usable contact channel detected on it' : 'No usable contact channel found');
  }

  score = Math.min(10, score);

  return { score, reasons, hasVerifiedEmail, hasEmail: emails.length > 0, hasPhone };
}

module.exports = { computeContactability };
