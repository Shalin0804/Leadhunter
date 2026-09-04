import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiPlus, FiUploadCloud, FiDownload, FiUserPlus, FiExternalLink, FiInfo } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { signalApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, Modal, ScoreBadge } from '../components/ui';
import {
  fmtDate,
  fmtRelative,
  fmtNumber,
  SIGNAL_SERVICE_LABELS,
  SIGNAL_SOURCE_LABELS,
  SIGNAL_STATUS_LABELS,
} from '../utils/format';

const SERVICES = Object.keys(SIGNAL_SERVICE_LABELS);
const SOURCES = Object.keys(SIGNAL_SOURCE_LABELS);
const STATUSES = Object.keys(SIGNAL_STATUS_LABELS);

const STATUS_TONE = { NEW: 'blue', REVIEWED: 'warm', CONVERTED: 'green', DISMISSED: 'gray' };

function NewSignalModal({ open, onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({
    company_name: '',
    website: '',
    contact_name: '',
    contact_email: '',
    contact_phone: '',
    service: 'WEBSITE_DEVELOPMENT',
    source: 'linkedin',
    source_url: '',
    headline: '',
    detail: '',
    confidence: 'MEDIUM',
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!f.company_name && !f.website && !f.contact_email) {
      toast.error('Enter a company name, website or contact email');
      return;
    }
    setBusy(true);
    try {
      const res = await signalApi.create(f);
      toast.success(res.companyCreated ? 'Signal logged — new company created' : 'Signal logged');
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Log a buying signal"
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save signal'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label>Company name</label>
          <input className="input" value={f.company_name} onChange={(e) => set('company_name', e.target.value)} placeholder="Matched to an existing company if possible" />
        </div>
        <div className="field">
          <label>Website</label>
          <input className="input" value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="example.com" />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label>Service wanted</label>
          <select className="select" value={f.service} onChange={(e) => set('service', e.target.value)}>
            {SERVICES.map((s) => <option key={s} value={s}>{SIGNAL_SERVICE_LABELS[s]}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Source</label>
          <select className="select" value={f.source} onChange={(e) => set('source', e.target.value)}>
            {SOURCES.map((s) => <option key={s} value={s}>{SIGNAL_SOURCE_LABELS[s]}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Source link (optional)</label>
        <input className="input" value={f.source_url} onChange={(e) => set('source_url', e.target.value)} placeholder="Link to the post / message / form entry" />
      </div>
      <div className="field">
        <label>Headline</label>
        <input className="input" value={f.headline} onChange={(e) => set('headline', e.target.value)} placeholder="What are they asking for, in their words?" />
      </div>
      <div className="field">
        <label>Detail</label>
        <textarea className="input" rows={3} value={f.detail} onChange={(e) => set('detail', e.target.value)} />
      </div>
      <div className="form-row">
        <div className="field">
          <label>Contact name</label>
          <input className="input" value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} />
        </div>
        <div className="field">
          <label>Contact email</label>
          <input className="input" value={f.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label>Contact phone</label>
          <input className="input" value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
        </div>
        <div className="field">
          <label>Confidence</label>
          <select className="select" value={f.confidence} onChange={(e) => set('confidence', e.target.value)}>
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>HIGH</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

export default function Signals() {
  const toast = useToast();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ service: '', source: '', status: '', search: '' });
  const [showNew, setShowNew] = useState(false);

  const stats = useApi(() => signalApi.stats(), []);
  const query = useMemo(() => ({ ...filters, page, limit: 15 }), [filters, page]);
  const { data, loading, error, reload } = useApi(() => signalApi.list(query), [JSON.stringify(query)]);

  const setF = (k, v) => {
    setFilters((p) => ({ ...p, [k]: v }));
    setPage(1);
  };

  const refreshAll = () => {
    reload();
    stats.reload();
  };

  const setStatus = async (id, status) => {
    try {
      await signalApi.update(id, { status });
      toast.success(`Marked ${SIGNAL_STATUS_LABELS[status]}`);
      refreshAll();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const convert = async (id) => {
    try {
      const res = await signalApi.convert(id, { priority: 'HIGH' });
      toast.success('Lead created from signal');
      navigate(`/leads/${res.lead.id}`);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Buying Signals</h1>
          <p>Prospects who have actively asked for website, software or CRM work.</p>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => signalApi.exportCsv(query).catch((e) => toast.error(e.message))}>
            <FiDownload /> Export
          </button>
          <Link className="btn" to="/imports?type=signals">
            <FiUploadCloud /> Import CSV
          </Link>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            <FiPlus /> Log signal
          </button>
        </div>
      </div>

      <div className="card card-pad mb-3" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--surface-2)' }}>
        <FiInfo style={{ marginTop: 2, color: 'var(--primary)' }} />
        <div className="text-sm text-muted">
          Signals come from channels you're permitted to use — inbound forms, referrals, event contacts, replies to
          your own posts, and exports from LinkedIn Lead Gen Forms / Meta Lead Ads. This is not a scraper. An active
          signal adds a large boost to the company's lead score.
        </div>
      </div>

      {stats.data && (
        <div className="grid stat-grid mb-3">
          {[
            ['Active signals', stats.data.active],
            ['New this week', stats.data.newThisWeek],
            ['Converted to leads', stats.data.converted],
            ['Total', stats.data.total],
          ].map(([k, v]) => (
            <div key={k} className="card stat-card">
              <span className="stat-label">{k}</span>
              <div className="stat-value">{fmtNumber(v ?? 0)}</div>
            </div>
          ))}
        </div>
      )}

      {stats.data?.byService?.length > 0 && (
        <Card title="Most requested services" className="mb-3">
          <div className="chip-row">
            {stats.data.byService.map((r) => (
              <span key={r.service} className="badge blue">
                {SIGNAL_SERVICE_LABELS[r.service] || r.service}: {r.count}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card className="mb-3">
        <div className="filters">
          <div className="field">
            <label>Search</label>
            <input className="input" value={filters.search} onChange={(e) => setF('search', e.target.value)} placeholder="Headline, contact, company" />
          </div>
          <div className="field">
            <label>Service</label>
            <select className="select" value={filters.service} onChange={(e) => setF('service', e.target.value)}>
              <option value="">Any</option>
              {SERVICES.map((s) => <option key={s} value={s}>{SIGNAL_SERVICE_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Source</label>
            <select className="select" value={filters.source} onChange={(e) => setF('source', e.target.value)}>
              <option value="">Any</option>
              {SOURCES.map((s) => <option key={s} value={s}>{SIGNAL_SOURCE_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select className="select" value={filters.status} onChange={(e) => setF('status', e.target.value)}>
              <option value="">Any</option>
              {STATUSES.map((s) => <option key={s} value={s}>{SIGNAL_STATUS_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
      </Card>

      <Card bodyClass="">
        {loading ? (
          <Loader />
        ) : error ? (
          <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>
        ) : !data?.items?.length ? (
          <EmptyState
            title="No signals yet"
            message="Log a signal when a prospect asks for work, or import a CSV from your lead forms."
            action={<button className="btn btn-primary" onClick={() => setShowNew(true)}>Log signal</button>}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Wants</th>
                    <th>Source</th>
                    <th>Signal</th>
                    <th>Score</th>
                    <th>Status</th>
                    <th>Captured</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.company ? (
                          <Link to={`/companies/${s.company.id}`} className="cell-strong">{s.company.company_name}</Link>
                        ) : (
                          <span className="cell-strong">{s.company_name_raw || '—'}</span>
                        )}
                        {s.contact_name && <div className="cell-sub">{s.contact_name}{s.contact_email ? ` · ${s.contact_email}` : ''}</div>}
                      </td>
                      <td><span className="badge blue">{SIGNAL_SERVICE_LABELS[s.service] || s.service}</span></td>
                      <td className="text-sm">
                        {SIGNAL_SOURCE_LABELS[s.source] || s.source}
                        {s.source_url && (
                          <a href={s.source_url} target="_blank" rel="noreferrer" title="Open source">
                            {' '}<FiExternalLink style={{ verticalAlign: '-2px' }} />
                          </a>
                        )}
                      </td>
                      <td style={{ maxWidth: 280 }} className="text-sm">{s.headline || s.detail || '—'}</td>
                      <td>{s.company ? <ScoreBadge value={s.company.lead_score} /> : '—'}</td>
                      <td>
                        <select
                          className="select"
                          style={{ padding: '3px 6px', fontSize: 12, maxWidth: 130 }}
                          value={s.status}
                          onChange={(e) => setStatus(s.id, e.target.value)}
                        >
                          {STATUSES.map((st) => <option key={st} value={st}>{SIGNAL_STATUS_LABELS[st]}</option>)}
                        </select>
                      </td>
                      <td className="nowrap text-sm" title={fmtDate(s.captured_at)}>{fmtRelative(s.captured_at)}</td>
                      <td>
                        <div className="row-actions">
                          {s.lead_id ? (
                            <Link className="icon-btn" to={`/leads/${s.lead_id}`} title="Open lead"><FiExternalLink /></Link>
                          ) : (
                            <button className="icon-btn" title="Convert to lead" onClick={() => convert(s.id)}><FiUserPlus /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={setPage} />
          </>
        )}
      </Card>

      <NewSignalModal open={showNew} onClose={() => setShowNew(false)} onDone={refreshAll} />
    </div>
  );
}
