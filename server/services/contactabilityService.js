/**
 * contactability_score: 0-10, a plain reflection of "how easily can we reach
 * this business through a legitimate channel". Deterministic, no external
 * calls — computed from whatever contact data the company already has.
 */

function computeContactability({ contacts = [], hasWebsite = false, hasSocial = false }) {
  const emails = contacts.filter((c) => c.type === 'email');
  const phones = contacts.filter((c) => c.type === 'phone');
  const hasVerifiedEmail = emails.some((c) => c.verification_status === 'VERIFIED' || c.verification_status === 'VALID');
  const hasEmail = emails.length > 0;
  const hasPhone = phones.length > 0;

  let score = 0;
  const reasons = [];

  if (hasVerifiedEmail && hasPhone && hasWebsite) {
    score = 10;
    reasons.push('Verified email + phone + website');
  } else if (hasVerifiedEmail && hasPhone) {
    score = 8;
    reasons.push('Verified email + phone');
  } else if (hasEmail) {
    score = 6;
    reasons.push(hasVerifiedEmail ? 'Verified email' : 'Email on file (not yet verified)');
  } else if (hasPhone) {
    score = 4;
    reasons.push('Phone on file');
  } else if (hasSocial || hasWebsite) {
    score = 2;
    reasons.push(hasWebsite ? 'Website / contact page only' : 'Social profile only');
  } else {
    score = 0;
    reasons.push('No usable contact channel found');
  }

  return { score, reasons, hasVerifiedEmail, hasEmail, hasPhone };
}

module.exports = { computeContactability };
