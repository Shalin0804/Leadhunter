import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { FiMail, FiZap, FiRefreshCw, FiEye, FiEdit2, FiSave, FiSend, FiCpu, FiTrash2, FiClock, FiCheck, FiAlertTriangle, FiCornerUpLeft } from 'react-icons/fi';
import { emailApi, taskApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Modal, Loader, ErrorBox } from './ui';
import { fmtDateTime, fmtRelative } from '../utils/format';

export const EMAIL_STATUS_TONE = { DRAFT: 'gray', QUEUED: 'blue', SENDING: 'blue', SENT: 'green', FAILED: 'hot', RECEIVED: 'warm' };
const GEN_LABEL = { manual: 'Written manually', rule_based: 'Rule-based template', nemotron: 'AI (Nemotron)', claude_code: 'Claude Code', system: 'System' };

export const EmailStatus = ({ value }) => (
  <span className={`badge ${EMAIL_STATUS_TONE[value] || 'gray'}`} title={value === 'SENT' ? 'Accepted by the Titan SMTP server. Delivery to the inbox is not confirmed.' : undefined}>
    {value === 'SENT' ? 'Sent (accepted)' : value === 'RECEIVED' ? 'Reply received' : value.charAt(0) + value.slice(1).toLowerCase()}
  </span>
);

/** Plain-text email exactly as it will be sent (body + the fixed opt-out footer). */
const Preview = ({ from, to, subject, body, footer }) => (
  <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
    <div className="text-sm"><strong>From:</strong> {from}</div>
    <div className="text-sm"><strong>To:</strong> {to || '—'}</div>
    <div className="text-sm mb-2"><strong>Subject:</strong> {subject || '—'}</div>
    <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{body}{footer}</div>
  </div>
);

/** Single-lead composer. Nothing is sent until "Send email" is clicked and confirmed. */
export function EmailComposerModal({ open, onClose, leadId, overview, initial, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({});
  const [preview, setPreview] = useState(false);
  const [useAI, setUseAI] = useState(false);
  const [busy, setBusy] = useState(null);
  const [confirmSend, setConfirmSend] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF({ to_email: overview?.recipients?.[0]?.email || '', subject: '', body: '', kind: 'initial', generated_by: 'manual', outreach_id: null, id: null, ...initial });
    setPreview(false);
    setConfirmSend(false);
  }, [open, initial, overview]);

  const set = (patch) => {
    setF((x) => ({ ...x, ...patch }));
    setConfirmSend(false);
  };
  const from = overview ? `${overview.from.name} <${overview.from.address || 'not configured'}>` : '';
  const generated = f.generated_by && f.generated_by !== 'manual';

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  };

  const generate = () => run('generate', async () => {
    const { draft } = await emailApi.generate({ lead_id: leadId, kind: f.kind, use_ai: useAI, to_email: f.to_email });
    set({ subject: draft.subject, body: draft.body, generated_by: draft.generated_by, outreach_id: null, to_email: f.to_email || draft.to_email });
    if (useAI && draft.ai_error) toast.error(`AI unavailable, used the rule-based template (${draft.ai_error})`);
  });

  const askClaude = () => run('claude', async () => {
    await emailApi.askClaude(leadId, f.kind);
    toast.success('Queued for Claude Code. Its draft will appear under "Claude Code drafts" once the agent runs it.');
  });

  const persist = async () => {
    const body = { lead_id: leadId, to_email: f.to_email, subject: f.subject, body: f.body, kind: f.kind, generated_by: f.generated_by, outreach_id: f.outreach_id };
    const { message } = f.id ? await emailApi.updateDraft(f.id, body) : await emailApi.saveDraft(body);
    setF((x) => ({ ...x, id: message.id }));
    return message;
  };

  const save = () => run('save', async () => {
    await persist();
    toast.success('Draft saved');
    onDone?.();
  });

  const send = () => run('send', async () => {
    const draft = await persist();
    const { message } = await emailApi.send(draft.id);
    if (message.status === 'SENT') {
      toast.success(`Email sent to ${message.to_email}`);
      onDone?.();
      onClose();
    } else {
      toast.error(`Sending failed: ${message.error || 'unknown error'}`);
      onDone?.();
    }
  });

  const ready = f.to_email && f.subject?.trim() && f.body?.trim();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={f.kind === 'follow_up' ? 'Follow-up email' : 'Compose email'}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" onClick={() => setPreview((p) => !p)}>{preview ? <><FiEdit2 /> Edit</> : <><FiEye /> Preview</>}</button>
          <button className="btn" disabled={!ready || !!busy} onClick={save}><FiSave /> {busy === 'save' ? 'Saving…' : 'Save draft'}</button>
          {confirmSend ? (
            <button className="btn btn-primary" disabled={!!busy} onClick={send}><FiSend /> {busy === 'send' ? 'Sending…' : `Confirm: send to ${f.to_email}`}</button>
          ) : (
            <button className="btn btn-primary" disabled={!ready || !!busy || !overview?.configured} title={overview?.configured ? undefined : 'Email is not configured on the server'} onClick={() => setConfirmSend(true)}><FiSend /> Send email</button>
          )}
        </>
      }
    >
      {overview?.blocked_reason && <div className="alert warn mb-3"><FiAlertTriangle /> {overview.blocked_reason}</div>}
      {preview ? (
        <Preview from={from} to={f.to_email} subject={f.subject} body={f.body} footer={overview?.footer} />
      ) : (
        <>
          <div className="form-row">
            <div className="field">
              <label>From</label>
              <input className="input" value={from} disabled />
            </div>
            <div className="field">
              <label>To</label>
              <select className="select" value={f.to_email || ''} onChange={(e) => set({ to_email: e.target.value })}>
                {!overview?.recipients?.length && <option value="">No email contact on file</option>}
                {(overview?.recipients || []).map((r) => (
                  <option key={r.id} value={r.email}>{r.email}{r.contact_name ? ` (${r.contact_name})` : ''}{r.verification_status ? ` · ${r.verification_status}` : ''}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2 items-center mb-3" style={{ flexWrap: 'wrap' }}>
            <select className="select" style={{ maxWidth: 170 }} value={f.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Email type">
              <option value="initial">First email</option>
              <option value="follow_up">Follow-up</option>
            </select>
            <button className="btn btn-sm" disabled={!!busy} onClick={generate}>
              {generated ? <FiRefreshCw /> : <FiZap />} {busy === 'generate' ? 'Generating…' : generated ? 'Regenerate' : 'AI generate'}
            </button>
            <button className="btn btn-sm" disabled={!!busy} onClick={askClaude} title="Queue this for the Claude Code agent. It writes a draft, it never sends."><FiCpu /> Ask Claude to draft</button>
            <label className="flex items-center gap-2 text-sm" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} /> Use Nemotron AI
            </label>
            {generated && <span className="badge blue">{GEN_LABEL[f.generated_by] || f.generated_by}</span>}
          </div>
          <div className="field mb-3">
            <label>Subject</label>
            <input className="input" maxLength={255} value={f.subject || ''} onChange={(e) => set({ subject: e.target.value })} />
          </div>
          <div className="field">
            <label>Email body</label>
            <textarea className="input" rows={12} value={f.body || ''} onChange={(e) => set({ body: e.target.value })} />
          </div>
          <p className="cell-sub mt-2">An unsubscribe line is added below the body when it is sent. Check every claim in the text before you send.</p>
        </>
      )}
    </Modal>
  );
}

/** The "Email" section of a lead profile: composer, Claude drafts, follow-ups, history. */
export function LeadEmailCard({ leadId, autoCompose = false }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [composer, setComposer] = useState(null);
  const [due, setDue] = useState('');
  const opened = useRef(false);

  const load = async () => {
    try {
      setData(await emailApi.lead(leadId));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);
  useEffect(() => {
    if (autoCompose && data && !opened.current) {
      opened.current = true;
      setComposer({});
    }
  }, [autoCompose, data]);

  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (error) return <Card title="Email"><ErrorBox message={error} onRetry={load} /></Card>;
  if (!data) return <Card title="Email"><Loader /></Card>;
  const openFollowUps = data.follow_ups.filter((t) => !['COMPLETED', 'CANCELLED'].includes(t.status));

  return (
    <Card
      title={`Email (${data.messages.length})`}
      actions={
        <div className="flex gap-2">
          <button className="btn btn-sm btn-primary" onClick={() => setComposer({})} disabled={!data.recipients.length}><FiMail /> Compose</button>
          <button className="btn btn-sm" onClick={() => setComposer({ kind: 'follow_up' })} disabled={!data.messages.some((m) => m.status === 'SENT')}><FiCornerUpLeft /> Follow-up</button>
        </div>
      }
    >
      {!data.configured && <div className="alert warn mb-3"><FiAlertTriangle /> Email is not configured on the server. See <Link to="/email">Email settings</Link>.</div>}
      {!data.recipients.length && <p className="text-muted text-sm">No usable email address on file for this company.</p>}
      {data.blocked_reason && <div className="alert warn mb-3"><FiAlertTriangle /> {data.blocked_reason}</div>}

      {data.claude_drafts.length > 0 && (
        <>
          <div className="section-title">Claude Code drafts</div>
          {data.claude_drafts.map((o) => (
            <div key={o.id} className="flex justify-between items-center gap-2" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <div className="text-sm"><strong>{o.subject || '(no subject)'}</strong> <span className="cell-sub">{o.channel === 'FOLLOW_UP' ? 'follow-up' : 'email'} · {o.status.replace('_', ' ').toLowerCase()} · {fmtRelative(o.created_at)}</span></div>
              <button className="btn btn-sm" onClick={() => setComposer({ subject: o.subject || '', body: o.body, generated_by: 'claude_code', outreach_id: o.id, kind: o.channel === 'FOLLOW_UP' ? 'follow_up' : 'initial' })}>Use</button>
            </div>
          ))}
        </>
      )}

      <div className="section-title mt-4">Follow-ups</div>
      {openFollowUps.length ? openFollowUps.map((t) => (
        <div key={t.id} className="flex justify-between items-center gap-2" style={{ padding: '6px 0' }}>
          <div className="text-sm"><FiClock /> {t.title} <span className="cell-sub">{t.due_date ? `due ${fmtDateTime(t.due_date)}` : 'no date'}</span></div>
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={() => setComposer({ kind: 'follow_up' })}>Draft</button>
            <button className="btn btn-sm" onClick={() => act(() => taskApi.update(t.id, { status: 'COMPLETED' }), 'Follow-up completed')}><FiCheck /> Done</button>
          </div>
        </div>
      )) : <p className="text-muted text-sm">No pending follow-ups.</p>}
      <div className="flex gap-2 items-center mt-2">
        <input className="input" type="datetime-local" style={{ maxWidth: 220 }} value={due} onChange={(e) => setDue(e.target.value)} aria-label="Follow-up date" />
        <button className="btn btn-sm" disabled={!due} onClick={() => act(async () => { await taskApi.create({ lead_id: leadId, title: 'Email follow-up', due_date: due, is_follow_up: true, priority: 'MEDIUM' }); setDue(''); }, 'Follow-up scheduled')}>Schedule follow-up</button>
      </div>

      <div className="section-title mt-4">Email history</div>
      {data.messages.length ? (
        <div className="timeline mt-2">
          {data.messages.map((m) => (
            <details className="timeline-item" key={m.id}>
              <summary style={{ cursor: 'pointer' }}>
                <span className="t-title">{m.direction === 'inbound' ? <FiCornerUpLeft /> : <FiSend />} {m.subject}</span>{' '}
                <EmailStatus value={m.status} />
                <div className="t-meta">
                  {m.direction === 'inbound' ? `from ${m.from_email}` : `to ${m.to_email}`} · {fmtDateTime(m.sent_at || m.received_at || m.created_at)}
                  {m.campaign_id ? ` · campaign #${m.campaign_id}` : ''}{m.opt_out ? ' · unsubscribe request' : ''}
                </div>
              </summary>
              {m.error && <div className="text-sm text-danger mt-2">{m.error}</div>}
              <div className="t-body" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              {['DRAFT', 'FAILED'].includes(m.status) && m.direction === 'outbound' && (
                <div className="flex gap-2 mt-2">
                  {m.status === 'DRAFT' && <button className="btn btn-sm" onClick={() => setComposer({ ...m })}><FiEdit2 /> Edit</button>}
                  {m.status === 'FAILED' && <button className="btn btn-sm" onClick={() => act(async () => { const r = await emailApi.send(m.id); if (r.message.status !== 'SENT') throw new Error(r.message.error); }, 'Email sent')}><FiRefreshCw /> Retry</button>}
                  {m.status === 'DRAFT' && <button className="btn btn-sm" onClick={() => act(() => emailApi.removeDraft(m.id), 'Draft removed')}><FiTrash2 /> Delete</button>}
                </div>
              )}
            </details>
          ))}
        </div>
      ) : <p className="text-muted text-sm">No emails yet.</p>}

      <EmailComposerModal open={!!composer} onClose={() => setComposer(null)} leadId={leadId} overview={data} initial={composer} onDone={load} />
    </Card>
  );
}

/**
 * Bulk email: one individually addressed email per lead. Steps: generate drafts ->
 * review/edit/remove -> explicit confirmation -> live per-recipient status.
 */
export function BulkEmailModal({ open, onClose, leadIds = [], campaignId = null, onDone }) {
  const toast = useToast();
  const [opts, setOpts] = useState({ name: '', kind: 'initial', use_ai: false });
  const [campaign, setCampaign] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState(null);

  const refresh = async (id) => setCampaign((await emailApi.campaign(id)).campaign);

  useEffect(() => {
    if (!open) return;
    setCampaign(null);
    setSkipped([]);
    setConfirmed(false);
    setEditing(null);
    if (campaignId) refresh(campaignId).catch((e) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, campaignId]);

  const sending = campaign && (campaign.status === 'SENDING' || campaign.running);
  useEffect(() => {
    if (!sending) return undefined;
    const t = setInterval(() => refresh(campaign.id).catch(() => {}), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending, campaign?.id]);

  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const prepare = () => run(async () => {
    const r = await emailApi.prepareCampaign({ lead_ids: leadIds, ...opts });
    setCampaign(r.campaign);
    setSkipped(r.skipped);
  });
  const askClaude = () => run(async () => {
    const results = await Promise.allSettled(leadIds.map((id) => emailApi.askClaude(id, opts.kind)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    toast.success(`${ok} of ${leadIds.length} queued for Claude Code. Generate the emails once the agent has drafted them; its drafts are used automatically.`);
  });

  const drafts = campaign?.messages?.filter((m) => ['DRAFT', 'QUEUED'].includes(m.status)) || [];
  const done = campaign ? (campaign.counts.SENT || 0) + (campaign.counts.FAILED || 0) : 0;
  const total = campaign?.counts?.total || 0;

  const saveEdit = () => run(async () => {
    await emailApi.updateDraft(editing.id, { subject: editing.subject, body: editing.body });
    setEditing(null);
    await refresh(campaign.id);
  });
  const remove = (id) => run(async () => {
    await emailApi.removeDraft(id);
    setConfirmed(false);
    await refresh(campaign.id);
  });
  const start = () => run(async () => {
    setCampaign((await emailApi.startCampaign(campaign.id, drafts.length)).campaign);
    toast.success('Sending started');
    onDone?.();
  });
  const cancel = () => run(async () => {
    setCampaign((await emailApi.cancelCampaign(campaign.id)).campaign);
    onDone?.();
  });

  const editable = campaign && ['DRAFT', 'PAUSED'].includes(campaign.status) && !campaign.running;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={campaign ? `${campaign.name}` : `Send email to ${leadIds.length} leads`}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          {!campaign && !campaignId && <button className="btn" disabled={busy} onClick={askClaude}><FiCpu /> Ask Claude to draft</button>}
          {!campaign && !campaignId && <button className="btn btn-primary" disabled={busy || !leadIds.length} onClick={prepare}><FiZap /> {busy ? 'Generating…' : 'Generate emails'}</button>}
          {sending && <button className="btn btn-danger" disabled={busy} onClick={cancel}>Stop sending</button>}
          {editable && drafts.length > 0 && <button className="btn btn-primary" disabled={busy || !confirmed} onClick={start}><FiSend /> Send {drafts.length} emails</button>}
        </>
      }
    >
      {!campaign && campaignId ? <Loader /> : !campaign ? (
        <>
          <p className="text-sm">Each selected lead gets its own personalised email, addressed only to them. Nothing is sent until you review the emails and confirm.</p>
          <div className="form-row">
            <div className="field"><label>Campaign name</label><input className="input" value={opts.name} placeholder="e.g. Pune dentists, week 1" onChange={(e) => setOpts({ ...opts, name: e.target.value })} /></div>
            <div className="field">
              <label>Email type</label>
              <select className="select" value={opts.kind} onChange={(e) => setOpts({ ...opts, kind: e.target.value })}>
                <option value="initial">First email</option>
                <option value="follow_up">Follow-up</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={opts.use_ai} onChange={(e) => setOpts({ ...opts, use_ai: e.target.checked })} /> Use Nemotron AI (slower; falls back to the template)
          </label>
          <p className="cell-sub mt-2">Where Claude Code has already drafted an email for a lead, that draft is used.</p>
        </>
      ) : (
        <>
          <div className="flex gap-2 items-center mb-3" style={{ flexWrap: 'wrap' }}>
            <span className="badge blue">{campaign.status.toLowerCase()}</span>
            <span className="text-sm"><strong>{total}</strong> recipients · {campaign.counts.SENT || 0} sent · {campaign.counts.FAILED || 0} failed · {drafts.length} waiting</span>
            {campaign.status_note && <span className="text-sm text-danger">{campaign.status_note}</span>}
          </div>
          {campaign.status !== 'DRAFT' && <div className="metric-bar mb-3" aria-label="Sending progress"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>}
          {skipped.length > 0 && (
            <details className="mb-3">
              <summary className="text-sm">{skipped.length} leads skipped</summary>
              <ul className="reason-list">{skipped.map((s) => <li key={s.lead_id}>{s.company}: {s.reason}</li>)}</ul>
            </details>
          )}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Recipient</th><th>Subject / preview</th><th>Status</th><th /></tr></thead>
              <tbody>
                {campaign.messages.map((m) => (
                  <tr key={m.id}>
                    <td><div className="cell-strong">{m.lead?.company?.company_name}</div><div className="cell-sub">{m.to_email}</div></td>
                    <td style={{ minWidth: 280 }}>
                      {editing?.id === m.id ? (
                        <>
                          <input className="input mb-2" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
                          <textarea className="input" rows={8} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                          <div className="flex gap-2 mt-2"><button className="btn btn-sm btn-primary" disabled={busy} onClick={saveEdit}>Save</button><button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button></div>
                        </>
                      ) : (
                        <details>
                          <summary className="text-sm" style={{ cursor: 'pointer' }}><strong>{m.subject}</strong> <span className="cell-sub">{GEN_LABEL[m.generated_by] || m.generated_by}</span></summary>
                          <div className="text-sm mt-2" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                        </details>
                      )}
                      {m.error && <div className="text-sm text-danger">{m.error}</div>}
                    </td>
                    <td><EmailStatus value={m.status} /></td>
                    <td>
                      {editable && m.status === 'DRAFT' && editing?.id !== m.id && (
                        <div className="row-actions">
                          <button className="icon-btn" title="Edit" onClick={() => setEditing({ id: m.id, subject: m.subject, body: m.body })}><FiEdit2 /></button>
                          <button className="icon-btn" title="Remove recipient" onClick={() => remove(m.id)}><FiTrash2 /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {editable && drafts.length > 0 && (
            <label className="flex items-center gap-2 text-sm mt-3" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              I have reviewed these emails and want to send {drafts.length} separate emails from the official mailbox, one per recipient.
            </label>
          )}
        </>
      )}
    </Modal>
  );
}
