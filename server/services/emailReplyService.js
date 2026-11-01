const { Op } = require('sequelize');
const config = require('../config/config');
const { EmailMessage, Lead, Activity } = require('../models');
const leadService = require('./leadService');
const email = require('./emailService');
const ApiError = require('../utils/ApiError');

/**
 * Optional reply sync over IMAP (Titan: imap.titan.email:993, same mailbox credentials).
 * SMTP can't receive, so this is the only way replies reach the CRM. Only mail that is a
 * reply to something we sent (In-Reply-To / References), or comes from an address we have
 * emailed, is imported — the rest of the inbox is ignored. Message-ID is unique, so
 * re-running a sync never imports the same reply twice.
 */

const LOOKBACK_DAYS = 14;
const OPT_OUT_RE = /\b(unsubscribe|remove me|stop emailing|do not contact)\b/i;

function imapProblem() {
  const c = config.email;
  if (!c.imap.enabled) return 'IMAP reply sync is off (set TITAN_IMAP_ENABLED=true)';
  if (!c.user || !c.pass) return 'TITAN_SMTP_USER / TITAN_SMTP_PASSWORD are required for IMAP too';
  return null;
}

/** Real IMAP fetch: INBOX messages since `since`, reduced to the fields matching needs. */
async function fetchFromImap(since) {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const c = config.email;
  const client = new ImapFlow({ host: c.imap.host, port: c.imap.port, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  const out = [];
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const m of client.fetch({ since }, { source: true })) {
        // eslint-disable-next-line no-await-in-loop
        const p = await simpleParser(m.source);
        out.push({
          messageId: p.messageId || null,
          inReplyTo: p.inReplyTo || null,
          references: [].concat(p.references || []),
          from: p.from?.value?.[0]?.address || null,
          subject: p.subject || '(no subject)',
          date: p.date || new Date(),
          text: (p.text || '').slice(0, 20000),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}

/** The outbound email this inbound one answers, or null. */
async function matchOutbound(m, ourAddress) {
  const from = email.normEmail(m.from);
  if (!from || from === ourAddress) return null;
  const refs = [m.inReplyTo, ...(m.references || [])].filter(Boolean);
  if (refs.length) {
    const byRef = await EmailMessage.findOne({ where: { direction: 'outbound', message_id: { [Op.in]: refs }, lead_id: { [Op.ne]: null } } });
    if (byRef) return byRef;
  }
  return EmailMessage.findOne({ where: { direction: 'outbound', status: 'SENT', to_email: from, lead_id: { [Op.ne]: null } }, order: [['sent_at', 'DESC']] });
}

async function syncReplies({ fetchMessages = fetchFromImap, user = null } = {}) {
  const problem = imapProblem();
  if (problem) throw new ApiError(503, problem);
  const status = await email.getStatus();
  const since = new Date(Math.max(Date.now() - LOOKBACK_DAYS * 86400e3, status.last_imap_sync_at ? new Date(status.last_imap_sync_at).getTime() - 86400e3 : -Infinity));
  let messages;
  try {
    messages = await fetchMessages(since);
  } catch (err) {
    await email.setStatus({ last_imap_error: String(err.message).slice(0, 500), last_imap_failed_at: new Date().toISOString() });
    throw new ApiError(502, `IMAP sync failed: ${err.message}`);
  }

  const ourAddress = email.normEmail(email.fromAddress());
  let imported = 0;
  let ignored = 0;
  for (const m of messages) {
    // eslint-disable-next-line no-await-in-loop
    if (!m.messageId || m.messageId.length > 255 || (await EmailMessage.count({ where: { message_id: m.messageId } }))) { ignored += 1; continue; }
    // eslint-disable-next-line no-await-in-loop
    const out = await matchOutbound(m, ourAddress);
    if (!out) { ignored += 1; continue; }
    const optOut = OPT_OUT_RE.test(m.text.split(/\n>|\nOn .+wrote:/)[0]); // only the new text, not the quoted original
    try {
      // eslint-disable-next-line no-await-in-loop
      const reply = await EmailMessage.create({
        lead_id: out.lead_id, company_id: out.company_id, campaign_id: out.campaign_id, direction: 'inbound', kind: 'reply', status: 'RECEIVED',
        to_email: ourAddress, from_email: email.normEmail(m.from).slice(0, 254), subject: String(m.subject).slice(0, 255), body: m.text || '(empty)',
        message_id: m.messageId, in_reply_to: String(m.inReplyTo || out.message_id || '').slice(0, 255) || null, opt_out: optOut, received_at: new Date(m.date),
      });
      // eslint-disable-next-line no-await-in-loop
      await Activity.create({ lead_id: out.lead_id, company_id: out.company_id, user_id: null, type: 'reply_received', title: `Email reply: ${reply.subject}`.slice(0, 200), body: reply.body.slice(0, 500), occurred_at: reply.received_at, meta: { email_message_id: reply.id, opt_out: optOut } });
      // eslint-disable-next-line no-await-in-loop
      const lead = await Lead.findByPk(out.lead_id);
      // A reply moves a contacted lead to Replied; an unsubscribe marks it Do Not Contact. Later stages are left alone.
      if (lead && (optOut || ['CONTACTED', 'FOLLOW_UP'].includes(lead.contact_status))) {
        // eslint-disable-next-line no-await-in-loop
        await leadService.setContactStatus(lead.id, optOut ? 'DO_NOT_CONTACT' : 'REPLIED', { userId: user?.id, note: optOut ? 'Replied "unsubscribe" by email' : 'Replied by email', method: 'EMAIL' });
      }
      imported += 1;
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err; // a parallel sync got it first
      ignored += 1;
    }
  }
  await email.setStatus({ last_imap_sync_at: new Date().toISOString(), last_imap_error: null, last_imap_imported: imported });
  return { fetched: messages.length, imported, ignored };
}

module.exports = { syncReplies, imapProblem, fetchFromImap, OPT_OUT_RE };
