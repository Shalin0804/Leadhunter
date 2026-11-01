import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiCheckCircle, FiAlertTriangle, FiSend, FiRefreshCw, FiInbox } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { emailApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination } from '../components/ui';
import { BulkEmailModal, EmailStatus } from '../components/email';
import { fmtDateTime } from '../utils/format';

const Row = ({ label, children }) => (
  <>
    <dt>{label}</dt>
    <dd>{children ?? '—'}</dd>
  </>
);

function SettingsCard({ s, reload }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [to, setTo] = useState(s.admin_email || '');
  const run = async (label, fn, msg) => {
    setBusy(label);
    try {
      const r = await fn();
      toast.success(typeof msg === 'function' ? msg(r) : msg);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const st = s.status || {};
  const lastOk = st.last_verified_at && (!st.last_verify_failed_at || st.last_verified_at > st.last_verify_failed_at);
  return (
    <>
      <Card
        title="Email settings"
        actions={s.configured ? <span className="badge green"><FiCheckCircle /> Configured</span> : <span className="badge hot"><FiAlertTriangle /> Not configured</span>}
      >
        {!s.configured && (
          <div className="alert warn mb-3"><FiAlertTriangle /> Set {s.missing.join(', ')} in the server environment (Render → Environment), then redeploy.</div>
        )}
        <dl className="def-list">
          <Row label="Email provider">{s.provider}</Row>
          <Row label="Sender email">{s.from_address}</Row>
          <Row label="Sender name">{s.from_name}</Row>
          <Row label="SMTP host">{s.host}</Row>
          <Row label="SMTP port">{s.port} <span className="cell-sub">{s.secure ? 'SSL/TLS' : 'STARTTLS'}</span></Row>
          <Row label="SMTP user">{s.user}</Row>
          <Row label="SMTP password">{s.password_set ? 'Set (hidden)' : <span className="text-danger">Not set</span>} <span className="cell-sub">env TITAN_SMTP_PASSWORD</span></Row>
        </dl>
        <p className="cell-sub mt-2">Credentials live only in the server environment. They are never stored in the database or sent to the browser.</p>
      </Card>
      <Card title="Connection">
        <dl className="def-list">
          <Row label="Connection status">
            {st.last_verified_at || st.last_verify_failed_at ? (
              lastOk ? <span className="badge green">Connected</span> : <span className="badge hot">Failing</span>
            ) : <span className="badge gray">Not tested</span>}
          </Row>
          <Row label="Last successful connection">{fmtDateTime(st.last_verified_at)}</Row>
          {!lastOk && st.last_verify_error && <Row label="Last error"><span className="text-danger text-sm">{st.last_verify_error}</span></Row>}
          <Row label="Last email sent">{fmtDateTime(st.last_sent_at)}</Row>
          <Row label="Sent, last hour">{s.usage.last_hour} / {s.limits.hourly}</Row>
          <Row label="Sent, last 24 hours">{s.usage.last_24h} / {s.limits.daily}</Row>
          <Row label="Bulk limits">{s.limits.bulk_max} per campaign · {Math.round(s.limits.send_delay_ms / 1000)} s between emails · same address once per {s.limits.duplicate_window_hours} h</Row>
        </dl>
        <div className="flex gap-2 mt-3" style={{ flexWrap: 'wrap' }}>
          <button className="btn" disabled={!s.configured || !!busy} onClick={() => run('verify', emailApi.testConnection, 'SMTP connection OK')}>
            <FiRefreshCw /> {busy === 'verify' ? 'Testing…' : 'Test SMTP connection'}
          </button>
        </div>
        <div className="flex gap-2 mt-2 items-center" style={{ flexWrap: 'wrap' }}>
          <input className="input" style={{ maxWidth: 260 }} type="email" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Test recipient" placeholder="you@codefloorit.in" />
          <button className="btn" disabled={!s.configured || !to || !!busy} onClick={() => run('test', () => emailApi.testEmail(to), `Test email accepted for ${to}`)}>
            <FiSend /> {busy === 'test' ? 'Sending…' : 'Send test email'}
          </button>
        </div>
      </Card>
      <Card title="Reply tracking (IMAP)">
        <dl className="def-list">
          <Row label="Status">{s.imap.enabled ? <span className="badge green">Enabled</span> : <span className="badge gray">Off</span>}</Row>
          <Row label="IMAP server">{s.imap.host}:{s.imap.port}</Row>
          <Row label="Last sync">{fmtDateTime(st.last_imap_sync_at)}{st.last_imap_imported != null && <span className="cell-sub"> · {st.last_imap_imported} replies imported</span>}</Row>
          {st.last_imap_error && <Row label="Last error"><span className="text-danger text-sm">{st.last_imap_error}</span></Row>}
        </dl>
        {!s.imap.enabled && <p className="text-sm text-muted mt-2">{s.imap.problem}. When it is on, replies to your emails are matched to their leads and shown in each lead's email history.</p>}
        <button className="btn mt-3" disabled={!s.imap.enabled || !!busy} onClick={() => run('sync', emailApi.syncReplies, (r) => `Checked ${r.fetched} messages, imported ${r.imported} replies`)}>
          <FiInbox /> {busy === 'sync' ? 'Syncing…' : 'Sync replies now'}
        </button>
      </Card>
    </>
  );
}

export default function EmailCenter() {
  const settings = useApi(() => emailApi.settings(), []);
  const followUps = useApi(() => emailApi.followUps(), []);
  const [cPage, setCPage] = useState(1);
  const campaigns = useApi(() => emailApi.campaigns({ page: cPage, limit: 10 }), [cPage]);
  const [mPage, setMPage] = useState(1);
  const [mStatus, setMStatus] = useState('');
  const recent = useApi(() => emailApi.recent({ page: mPage, limit: 15, status: mStatus }), [mPage, mStatus]);
  const [openCampaign, setOpenCampaign] = useState(null);

  // Keep campaign progress live while any campaign is sending.
  const anySending = campaigns.data?.items?.some((c) => c.status === 'SENDING');
  useEffect(() => {
    if (!anySending) return undefined;
    const t = setInterval(() => campaigns.reload(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anySending]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Email</h1>
          <p>Outreach from the official Codefloor IT mailbox (Titan Mail). Every email is sent individually and only after you confirm it.</p>
        </div>
        <Link className="btn" to="/leads">Select leads to email</Link>
      </div>

      {settings.loading && !settings.data ? <Loader /> : settings.error ? <ErrorBox message={settings.error} onRetry={settings.reload} /> : (
        <div className="grid chart-grid mb-3"><SettingsCard s={settings.data} reload={settings.reload} /></div>
      )}

      <Card title="Pending follow-ups" className="mb-3" bodyClass="">
        {followUps.loading && !followUps.data ? <Loader /> : followUps.error ? <div className="card-pad"><ErrorBox message={followUps.error} onRetry={followUps.reload} /></div> : followUps.data.items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Lead</th><th>Follow-up</th><th>Due</th><th>Last email sent</th><th>Replied</th><th /></tr></thead>
              <tbody>
                {followUps.data.items.map((t) => (
                  <tr key={t.id}>
                    <td><Link className="cell-strong" to={`/leads/${t.lead_id}#email`}>{t.lead?.company?.company_name || `Lead #${t.lead_id}`}</Link></td>
                    <td className="text-sm">{t.title}</td>
                    <td className="nowrap text-sm">{fmtDateTime(t.due_date)}</td>
                    <td className="text-sm">{t.last_sent ? <>{t.last_sent.subject}<div className="cell-sub">{fmtDateTime(t.last_sent.sent_at)}</div></> : '—'}</td>
                    <td>{t.replied ? <span className="badge warm">Replied — don't follow up</span> : ['DO_NOT_CONTACT', 'NOT_INTERESTED'].includes(t.lead?.contact_status) ? <span className="badge not_qualified">Opted out</span> : <span className="badge gray">No reply</span>}</td>
                    <td><Link className="btn btn-sm" to={`/leads/${t.lead_id}#email`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState title="No pending follow-ups" message="Schedule one from a lead's Email section." />}
      </Card>

      <Card title="Campaigns" className="mb-3" bodyClass="">
        {campaigns.loading && !campaigns.data ? <Loader /> : campaigns.error ? <div className="card-pad"><ErrorBox message={campaigns.error} onRetry={campaigns.reload} /></div> : campaigns.data.items.length ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Campaign</th><th>Status</th><th>Progress</th><th>Created</th><th /></tr></thead>
                <tbody>
                  {campaigns.data.items.map((c) => {
                    const done = (c.counts.SENT || 0) + (c.counts.FAILED || 0);
                    return (
                      <tr key={c.id}>
                        <td className="cell-strong">{c.name}{c.status_note && <div className="cell-sub text-danger">{c.status_note}</div>}</td>
                        <td><span className="badge blue">{c.status.toLowerCase()}</span></td>
                        <td style={{ minWidth: 180 }}>
                          <div className="metric-bar"><span style={{ width: `${c.counts.total ? (done / c.counts.total) * 100 : 0}%` }} /></div>
                          <div className="cell-sub">{c.counts.SENT || 0} sent · {c.counts.FAILED || 0} failed · {c.counts.total} total</div>
                        </td>
                        <td className="nowrap text-sm">{fmtDateTime(c.created_at)}</td>
                        <td><button className="btn btn-sm" onClick={() => setOpenCampaign(c.id)}>{['DRAFT', 'PAUSED'].includes(c.status) ? 'Review / send' : 'View'}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pagination={campaigns.data.pagination} onChange={setCPage} />
          </>
        ) : <EmptyState title="No campaigns yet" message="Select leads on the Leads page and choose Send email." />}
      </Card>

      <Card title="Recent emails" bodyClass="" actions={
        <select className="select" style={{ maxWidth: 180 }} value={mStatus} onChange={(e) => { setMStatus(e.target.value); setMPage(1); }} aria-label="Filter by status">
          <option value="">All statuses</option>
          {['DRAFT', 'QUEUED', 'SENT', 'FAILED', 'RECEIVED'].map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}
        </select>
      }>
        {recent.loading && !recent.data ? <Loader /> : recent.error ? <div className="card-pad"><ErrorBox message={recent.error} onRetry={recent.reload} /></div> : recent.data.items.length ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Lead</th><th>Subject</th><th>{'To / from'}</th><th>Status</th><th>When</th></tr></thead>
                <tbody>
                  {recent.data.items.map((m) => (
                    <tr key={m.id}>
                      <td>{m.lead_id ? <Link to={`/leads/${m.lead_id}#email`}>{m.lead?.company?.company_name || `Lead #${m.lead_id}`}</Link> : <span className="cell-sub">{m.kind === 'test' ? 'Test email' : '—'}</span>}</td>
                      <td className="text-sm">{m.subject}{m.error && <div className="cell-sub text-danger">{m.error}</div>}</td>
                      <td className="text-sm">{m.direction === 'inbound' ? m.from_email : m.to_email}</td>
                      <td><EmailStatus value={m.status} /></td>
                      <td className="nowrap text-sm">{fmtDateTime(m.sent_at || m.received_at || m.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={recent.data.pagination} onChange={setMPage} />
          </>
        ) : <EmptyState title="No emails yet" />}
      </Card>

      <BulkEmailModal open={!!openCampaign} campaignId={openCampaign} onClose={() => { setOpenCampaign(null); campaigns.reload(); recent.reload(); }} onDone={campaigns.reload} />
    </div>
  );
}
