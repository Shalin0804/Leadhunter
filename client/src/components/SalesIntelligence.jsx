import { useState, useEffect, useCallback } from 'react';
import { FiCpu, FiTarget, FiMail, FiMessageCircle, FiPhone, FiShield, FiCalendar, FiRefreshCw, FiEdit2, FiCheck, FiX, FiCopy, FiSend, FiExternalLink } from 'react-icons/fi';
import { agentApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox } from './ui';
import { fmtDateTime, fmtRelative } from '../utils/format';

// Buttons -> sales_strategy focus (server: salesService.FOCUS).
const ACTIONS = [
  { focus: 'intelligence', label: 'Analyze lead', icon: <FiCpu /> },
  { focus: 'full', label: 'Generate sales strategy', icon: <FiTarget /> },
  { focus: 'cold_email', label: 'Generate email', icon: <FiMail /> },
  { focus: 'whatsapp', label: 'Generate WhatsApp pitch', icon: <FiMessageCircle /> },
  { focus: 'call_script', label: 'Generate call script', icon: <FiPhone /> },
  { focus: 'objections', label: 'Generate objection handling', icon: <FiShield /> },
  { focus: 'follow_up_plan', label: 'Generate follow-up plan', icon: <FiCalendar /> },
];
const PURPOSE_LABELS = {
  cold_email: 'Cold email', follow_up_email: 'Follow-up email', meeting_request: 'Meeting request', whatsapp: 'WhatsApp message',
  follow_up_whatsapp: 'Follow-up WhatsApp', linkedin: 'LinkedIn message', call_script: 'Call script', proposal: 'Proposal',
};
const DRAFT_TONE = { PENDING_APPROVAL: 'high', APPROVED: 'green', REJECTED: 'not_qualified', DRAFT: 'gray' };
const TASK_TONE = { PENDING: 'gray', RUNNING: 'blue', PAUSED: 'warm', COMPLETED: 'green', FAILED: 'hot', CANCELLED: 'not_qualified' };
const QUALITY_TONE = { high: 'green', medium: 'warm', low: 'gray', unknown: 'gray' };

// Field layout per section. text = one paragraph, list = one item per line.
const FIELDS = {
  intelligence: [['industry', 'Industry', 'text'], ['business_model', 'Business model', 'text'], ['services', 'Their services', 'list'], ['website_findings', 'Website findings', 'list'], ['technology_problems', 'Technology problems', 'list'], ['software_opportunities', 'Software opportunities', 'list'], ['relevant_services', 'Relevant Codefloor IT services', 'services'], ['lead_quality', 'Lead quality', 'quality'], ['missing_information', 'Missing information (research next)', 'list']],
  sales_angle: [['best_angle', 'Best sales angle', 'text'], ['primary_pain_point', 'Primary pain point', 'text'], ['recommended_solution', 'Recommended solution', 'text'], ['why_needed', 'Why they may need it', 'text'], ['expected_benefits', 'Expected benefits', 'list'], ['conversation_opener', 'Conversation opener', 'text'], ['why_codefloor', 'Why Codefloor IT', 'text'], ['alternative_angles', 'Alternative angles', 'list']],
  closing: [['negotiation_strategy', 'Negotiation strategy', 'text'], ['meeting_strategy', 'Meeting strategy', 'text'], ['closing_approach', 'Deal-closing approach', 'text'], ['recommended_next_step', 'Recommended next step', 'text']],
};
const SECTION_TITLES = { intelligence: 'Lead intelligence', sales_angle: 'Sales angle', objections: 'Objection handling', closing: 'Negotiation & closing', follow_up_schedule: 'Follow-up schedule' };

const lines = (v) => (v || []).join('\n');
const toList = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function SectionView({ name, value }) {
  if (!value) return <p className="text-muted text-sm">Not generated yet.</p>;
  if (name === 'objections') {
    return value.length ? value.map((o, i) => (
      <div key={i} className="mb-3">
        <div className="cell-strong">“{o.objection}”</div>
        <div className="text-sm mt-1">{o.response}</div>
        {o.next_action && <div className="cell-sub">Next: {o.next_action}</div>}
      </div>
    )) : <p className="text-muted text-sm">None.</p>;
  }
  if (name === 'follow_up_schedule') {
    return value.length ? (
      <ul className="reason-list">{value.map((s, i) => <li key={i}>Day {s.day} · {s.channel.toLowerCase()} · {s.action}</li>)}</ul>
    ) : <p className="text-muted text-sm">None.</p>;
  }
  return (
    <dl className="def-list">
      {FIELDS[name].filter(([k]) => value[k] != null && !(Array.isArray(value[k]) && !value[k].length)).map(([k, label, type]) => (
        <span key={k} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>
            {type === 'quality' ? (
              <><span className={`badge ${QUALITY_TONE[value[k].rating]}`}>{value[k].rating}</span>{value[k].reasons?.length > 0 && <ul className="reason-list">{value[k].reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}</>
            ) : Array.isArray(value[k]) ? (
              <ul className="reason-list" style={{ margin: 0 }}>{value[k].map((x, i) => <li key={i}>{x}</li>)}</ul>
            ) : value[k]}
          </dd>
        </span>
      ))}
    </dl>
  );
}

/** Form state <-> section JSON for the editor. */
function toForm(name, v) {
  if (name === 'objections') return (v || []).map((o) => ({ ...o }));
  if (name === 'follow_up_schedule') return (v || []).map((s) => ({ ...s }));
  const f = {};
  for (const [k, , type] of FIELDS[name]) {
    if (type === 'list') f[k] = lines(v?.[k]);
    else if (type === 'services') f[k] = v?.[k] || [];
    else if (type === 'quality') f[k] = { rating: v?.[k]?.rating || 'unknown', reasons: lines(v?.[k]?.reasons) };
    else f[k] = v?.[k] || '';
  }
  return f;
}
function fromForm(name, f) {
  if (name === 'objections') return f.filter((o) => o.objection.trim() && o.response.trim()).map((o) => ({ objection: o.objection.trim(), response: o.response.trim(), next_action: (o.next_action || '').trim() }));
  if (name === 'follow_up_schedule') return f.filter((s) => s.action.trim()).map((s) => ({ day: Number(s.day) || 0, channel: s.channel, action: s.action.trim() }));
  const out = {};
  for (const [k, , type] of FIELDS[name]) {
    if (type === 'list') out[k] = toList(f[k]);
    else if (type === 'services') out[k] = f[k];
    else if (type === 'quality') out[k] = { rating: f[k].rating, reasons: toList(f[k].reasons) };
    else out[k] = f[k].trim() || null;
  }
  return out;
}

function SectionEditor({ name, value, services, onSave, onCancel }) {
  const [f, setF] = useState(() => toForm(name, value));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(fromForm(name, f));
    } finally {
      setBusy(false);
    }
  };
  const row = (i, patch) => setF(f.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  let body;
  if (name === 'objections') {
    body = (
      <>
        {f.map((o, i) => (
          <div key={i} className="card card-pad mb-2" style={{ background: 'var(--surface-2)' }}>
            <input className="input mb-2" aria-label="Objection" placeholder="Objection" value={o.objection} onChange={(e) => row(i, { objection: e.target.value })} />
            <textarea className="input mb-2" rows={3} aria-label="Response" placeholder="Response" value={o.response} onChange={(e) => row(i, { response: e.target.value })} />
            <input className="input" aria-label="Next action" placeholder="Next action" value={o.next_action || ''} onChange={(e) => row(i, { next_action: e.target.value })} />
            <button type="button" className="btn btn-sm mt-2" onClick={() => setF(f.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setF([...f, { objection: '', response: '', next_action: '' }])}>Add objection</button>
      </>
    );
  } else if (name === 'follow_up_schedule') {
    body = (
      <>
        {f.map((s, i) => (
          <div key={i} className="flex gap-2 items-center mb-2">
            <input className="input" type="number" min={0} max={365} style={{ maxWidth: 80 }} aria-label="Day" value={s.day} onChange={(e) => row(i, { day: e.target.value })} />
            <select className="select" style={{ maxWidth: 130 }} aria-label="Channel" value={s.channel} onChange={(e) => row(i, { channel: e.target.value })}>
              {['EMAIL', 'WHATSAPP', 'PHONE', 'LINKEDIN'].map((c) => <option key={c}>{c}</option>)}
            </select>
            <input className="input" aria-label="Action" value={s.action} onChange={(e) => row(i, { action: e.target.value })} />
            <button type="button" className="icon-btn" title="Remove step" onClick={() => setF(f.filter((_, j) => j !== i))}><FiX /></button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={() => setF([...f, { day: 3, channel: 'EMAIL', action: '' }])}>Add step</button>
      </>
    );
  } else {
    body = FIELDS[name].map(([k, label, type]) => (
      <div className="field mb-2" key={k}>
        <label>{label}{type === 'list' ? ' (one per line)' : ''}</label>
        {type === 'services' ? (
          <div className="chip-row">
            {services.map((sv) => (
              <button type="button" key={sv} className={`chip ${f[k].includes(sv) ? 'active' : ''}`} aria-pressed={f[k].includes(sv)} onClick={() => setF({ ...f, [k]: f[k].includes(sv) ? f[k].filter((x) => x !== sv) : [...f[k], sv] })}>{sv}</button>
            ))}
          </div>
        ) : type === 'quality' ? (
          <>
            <select className="select mb-2" style={{ maxWidth: 160 }} value={f[k].rating} onChange={(e) => setF({ ...f, [k]: { ...f[k], rating: e.target.value } })}>
              {['high', 'medium', 'low', 'unknown'].map((q) => <option key={q}>{q}</option>)}
            </select>
            <textarea className="input" rows={2} aria-label="Reasons" placeholder="Reasons (one per line)" value={f[k].reasons} onChange={(e) => setF({ ...f, [k]: { ...f[k], reasons: e.target.value } })} />
          </>
        ) : (
          <textarea className="input" rows={type === 'list' ? 3 : 2} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        )}
      </div>
    ));
  }
  return (
    <div>
      {body}
      <div className="flex gap-2 mt-3">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={save}><FiCheck /> {busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function DraftCard({ d, phone, onChanged }) {
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const run = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast.success(msg);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([d.subject, d.body].filter(Boolean).join('\n\n'));
      toast.success('Copied');
    } catch {
      toast.error('Copy failed. Select the text and copy it manually');
    }
  };
  const digits = (phone || '').replace(/\D/g, '');
  const waLink = `https://wa.me/${digits}?text=${encodeURIComponent(d.body)}`;
  return (
    <div className="timeline-item">
      <div className="flex justify-between items-center gap-2" style={{ flexWrap: 'wrap' }}>
        <div className="t-title">{PURPOSE_LABELS[d.purpose] || d.channel.replace(/_/g, ' ').toLowerCase()} {d.subject && <span className="cell-sub">· {d.subject}</span>}</div>
        <span className={`badge ${DRAFT_TONE[d.status] || 'gray'}`}>{d.sent_at ? `Sent ${fmtRelative(d.sent_at)}` : d.status.replace('_', ' ').toLowerCase()}</span>
      </div>
      {edit ? (
        <>
          {d.subject != null && <input className="input mb-2 mt-2" aria-label="Subject" value={edit.subject || ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />}
          <textarea className="input mt-2" rows={8} aria-label="Message" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          <div className="flex gap-2 mt-2">
            <button className="btn btn-sm btn-primary" onClick={() => run(async () => { await agentApi.editDraft(d.id, { subject: d.subject != null ? edit.subject : undefined, body: edit.body }); setEdit(null); }, 'Draft saved')}><FiCheck /> Save</button>
            <button className="btn btn-sm" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="t-body" style={{ whiteSpace: 'pre-wrap' }}>{d.body}</div>
      )}
      {d.evidence?.length > 0 && <div className="cell-sub mt-1">Based on: {d.evidence.join(' · ')}</div>}
      {!edit && (
        <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
          {d.status !== 'APPROVED' && <button className="btn btn-sm" onClick={() => setEdit({ subject: d.subject, body: d.body })}><FiEdit2 /> Edit</button>}
          {d.status === 'PENDING_APPROVAL' && (
            <>
              <button className="btn btn-sm btn-primary" onClick={() => run(() => agentApi.decideDraft(d.id, 'approve'), 'Approved')}><FiCheck /> Approve</button>
              <button className="btn btn-sm" onClick={() => run(() => agentApi.decideDraft(d.id, 'reject'), 'Rejected')}><FiX /> Reject</button>
            </>
          )}
          <button className="btn btn-sm" onClick={copy}><FiCopy /> Copy</button>
          {d.status === 'APPROVED' && !d.sent_at && (
            <>
              {d.channel === 'WHATSAPP' && <a className="btn btn-sm" href={waLink} target="_blank" rel="noreferrer" title={digits ? 'Opens WhatsApp with this message; you press send' : 'No phone on file: WhatsApp will ask you to pick a chat'}><FiExternalLink /> Open in WhatsApp</a>}
              {['EMAIL', 'FOLLOW_UP'].includes(d.channel) && <a className="btn btn-sm" href="#email" title="Claude Code drafts are listed in the Email section's composer">Send from Email section</a>}
              <button className="btn btn-sm" onClick={() => run(() => agentApi.markSent(d.id), 'Marked as sent and logged')}><FiSend /> Mark as sent</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "AI Sales Intelligence" section of a lead profile (Main Admin). */
export default function SalesIntelligence({ leadId, phone }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await agentApi.salesLead(leadId));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [leadId]);
  useEffect(() => {
    load();
  }, [load]);

  // While Claude has work queued for this lead, refresh so results appear without a reload.
  const busyFocus = new Set((data?.tasks || []).filter((t) => ['PENDING', 'RUNNING', 'PAUSED'].includes(t.status)).map((t) => t.input?.focus).filter(Boolean));
  useEffect(() => {
    if (!busyFocus.size) return undefined;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyFocus.size, load]);

  if (error) return <Card title="AI Sales Intelligence"><ErrorBox message={error} onRetry={load} /></Card>;
  if (!data) return <Card title="AI Sales Intelligence"><Loader /></Card>;

  const pb = data.playbooks.find((p) => p.id === version) || data.playbooks[0];
  const queue = async (focus) => {
    try {
      await agentApi.salesQueue(leadId, focus);
      toast.success('Queued for Claude. Results appear here when Claude Code is connected and works the queue.');
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const saveSection = async (name, value) => {
    try {
      await agentApi.editPlaybook(pb.id, { [name]: value });
      toast.success('Saved');
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const scheduleFollowUps = async () => {
    try {
      const r = await agentApi.scheduleFollowUps(pb.id);
      toast.success(r.created ? `${r.created} follow-up tasks created` : 'These follow-ups were already scheduled');
    } catch (e) {
      toast.error(e.message);
    }
  };
  const salesTasks = data.tasks.filter((t) => ['sales_strategy', 'analyse_lead', 'generate_outreach'].includes(t.type)).slice(0, 6);

  return (
    <Card title="AI Sales Intelligence" actions={pb && <span className={`badge ${QUALITY_TONE[pb.lead_quality]}`}>Lead quality: {pb.lead_quality}</span>}>
      <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
        {ACTIONS.map((a) => (
          <button key={a.focus} className="btn btn-sm" disabled={busyFocus.has(a.focus)} onClick={() => queue(a.focus)} title={busyFocus.has(a.focus) ? 'Already queued' : undefined}>
            {a.icon} {busyFocus.has(a.focus) ? `${a.label} (queued)` : a.label}
          </button>
        ))}
        {pb && <button className="btn btn-sm" disabled={busyFocus.has('full')} onClick={() => queue('full')}><FiRefreshCw /> Regenerate analysis</button>}
      </div>
      <p className="cell-sub mb-3">Claude runs in Claude Code on your computer. Queued work waits until it is connected. Nothing is sent without your approval.</p>

      {salesTasks.length > 0 && (
        <details className="mb-3">
          <summary className="text-sm">Recent AI tasks ({salesTasks.length})</summary>
          <ul className="reason-list">
            {salesTasks.map((t) => (
              <li key={t.id}><span className={`badge ${TASK_TONE[t.status] || 'gray'}`}>{t.status.toLowerCase()}</span> {t.title} <span className="cell-sub">{fmtRelative(t.created_at)}</span>{t.error && <div className="text-sm text-danger">{t.error}</div>}</li>
            ))}
          </ul>
        </details>
      )}

      {!pb ? (
        <p className="text-muted text-sm">No sales playbook yet. Click "Generate sales strategy" to have Claude research this lead and write one.</p>
      ) : (
        <>
          <div className="flex gap-2 items-center mb-3" style={{ flexWrap: 'wrap' }}>
            <select className="select" style={{ maxWidth: 340 }} aria-label="Playbook version" value={pb.id} onChange={(e) => { setVersion(Number(e.target.value)); setEditing(null); }}>
              {data.playbooks.map((p) => <option key={p.id} value={p.id}>Version {p.version} · {fmtDateTime(p.created_at)}{p === data.playbooks[0] ? ' (latest)' : ''}</option>)}
            </select>
            <span className="cell-sub">Confidence {pb.confidence}%{pb.edited_at ? ` · edited ${fmtRelative(pb.edited_at)}` : ''}</span>
          </div>
          {pb.next_step && <div className="alert warn mb-3"><FiTarget /> Next step: {pb.next_step}</div>}
          {Object.keys(SECTION_TITLES).map((name) => (
            <div key={name} className="mb-3">
              <div className="flex justify-between items-center">
                <div className="section-title">{SECTION_TITLES[name]}</div>
                <div className="flex gap-2">
                  {name === 'follow_up_schedule' && pb.content.follow_up_schedule?.length > 0 && <button className="btn btn-sm" onClick={scheduleFollowUps}><FiCalendar /> Create follow-up tasks</button>}
                  {editing !== name && <button className="icon-btn" title={`Edit ${SECTION_TITLES[name]}`} onClick={() => setEditing(name)}><FiEdit2 /></button>}
                </div>
              </div>
              {editing === name ? (
                <SectionEditor name={name} value={pb.content[name]} services={data.codefloor_services} onSave={(v) => saveSection(name, v)} onCancel={() => setEditing(null)} />
              ) : (
                <SectionView name={name} value={pb.content[name]} />
              )}
            </div>
          ))}
          {pb.source_urls?.length > 0 && (
            <details className="mb-3">
              <summary className="text-sm">Sources ({pb.source_urls.length})</summary>
              <ul className="reason-list">{pb.source_urls.map((u) => <li key={u}><a href={u} target="_blank" rel="noreferrer">{u}</a></li>)}</ul>
            </details>
          )}
        </>
      )}

      <div className="section-title mt-4">Outreach drafts ({data.drafts.length})</div>
      {data.drafts.length ? (
        <div className="timeline mt-2">{data.drafts.map((d) => <DraftCard key={d.id} d={d} phone={phone} onChanged={load} />)}</div>
      ) : (
        <p className="text-muted text-sm">No drafts yet.</p>
      )}
    </Card>
  );
}
