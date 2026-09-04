/**
 * Generates outreach drafts from real, observed facts only — never invents
 * personalization. Template-based (no external API, no cost). A viewer can
 * check every claim in the message against `evidence`.
 */

function pickEvidence(company, analysis) {
  const facts = [];
  if (company.industry) facts.push(`industry: ${company.industry}`);
  if (company.city || company.state) facts.push(`location: ${[company.city, company.state].filter(Boolean).join(', ')}`);
  if (!company.has_website) facts.push('no website on file');
  else if (analysis?.missingAssets?.length) facts.push(`missing: ${analysis.missingAssets.join(', ')}`);
  if (analysis?.recommendedService) facts.push(`recommended service: ${analysis.recommendedService}`);
  return facts;
}

function generate(channel, { company, analysis, contactName }) {
  const name = contactName || 'there';
  const biz = company.company_name;
  const locality = company.city || company.state || '';
  const service = analysis?.recommendedService || 'a stronger online presence';
  const noWebsite = !company.has_website;
  const evidence = pickEvidence(company, analysis);

  let subject;
  let body;

  switch (channel) {
    case 'EMAIL':
      subject = noWebsite
        ? `Quick idea for ${biz}'s online presence`
        : `A few thoughts on ${biz}'s website`;
      body =
        `Hi ${name},\n\n` +
        (noWebsite
          ? `I noticed ${biz}${locality ? ` in ${locality}` : ''} doesn't currently have a website. `
          : `I took a look at ${biz}'s current site. `) +
        `We're Codefloor IT Tech — we build ${service.toLowerCase()} for businesses like yours.\n\n` +
        `Would you be open to a short call this week to see if it's a fit? No pressure either way.\n\n` +
        `Best,\n[Your name]`;
      break;
    case 'WHATSAPP':
      body =
        `Hi${name !== 'there' ? ` ${name}` : ''}, this is [Your name] from Codefloor IT Tech. ` +
        (noWebsite
          ? `We help businesses like ${biz} get online with a professional website. `
          : `We help businesses like ${biz} modernize their website/software. `) +
        `Open to a quick chat?`;
      break;
    case 'LINKEDIN':
      body =
        `Hi ${name}, I work with Codefloor IT Tech helping ${company.industry ? `${company.industry.toLowerCase()} businesses` : 'businesses'} ` +
        `improve their ${service.toLowerCase()}. Came across ${biz} and thought it might be relevant — open to connecting?`;
      break;
    case 'PHONE_TALKING_POINTS':
      body =
        `1. Introduce Codefloor IT Tech.\n` +
        `2. Mention: ${evidence.join('; ') || `${biz} matched our target list for ${service}`}.\n` +
        `3. Ask about their current setup for ${service.toLowerCase()}.\n` +
        `4. Offer a free audit / mockup.\n` +
        `5. Close with a specific next step (email a proposal / book a demo).`;
      break;
    case 'FOLLOW_UP':
      body =
        `Hi ${name}, following up on my earlier message about ${service.toLowerCase()} for ${biz}. ` +
        `Happy to answer any questions — is this still worth a quick chat?`;
      break;
    default:
      body = `Hi ${name}, reaching out from Codefloor IT Tech regarding ${service.toLowerCase()} for ${biz}.`;
  }

  return { channel, subject: subject || null, body, evidence };
}

module.exports = { generate, pickEvidence };
