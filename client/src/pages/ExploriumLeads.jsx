import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiSearch, FiInfo, FiEye, FiDownload, FiExternalLink, FiRefreshCw, FiAlertTriangle } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { exploriumApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, Modal } from '../components/ui';
import { fmtNumber } from '../utils/format';

const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'];
const INDUSTRIES = ['Hospitality', 'Logistics', 'Manufacturing', 'Textile', 'Consulting', 'Retail', 'Real Estate', 'Healthcare'];
const LOCATIONS = [
  { label: 'Ahmedabad', city: 'Ahmedabad', state: 'Gujarat', country: 'India' },
  { label: 'Gujarat', city: '', state: 'Gujarat', country: 'India' },
  { label: 'India', city: '', state: '', country: 'India' },
];

// Shown only as reported by the server, which sets it from a real Explorium response.
const CONNECTION = {
  connected: { label: 'Connected', tone: 'green' },
  not_configured: { label: 'Not Configured', tone: 'gray' },
  auth_failed: { label: 'Authentication Failed', tone: 'hot' },
  usage_limit: { label: 'Usage Limit Reached', tone: 'warm' },
  unavailable: { label: 'Service Unavailable', tone: 'hot' },
};

const RESULT_LABELS = {
  imported: { label: 'Imported', tone: 'green' },
  duplicate: { label: 'Skipped — duplicate', tone: 'gray' },
  missing_required: { label: 'Missing required info', tone: 'warm' },
  failed: { label: 'Failed', tone: 'hot' },
};

const hostname = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

function DetailsModal({ item, onClose, onImport, importing }) {
  if (!item) return null;
  const rows = [
    ['Industry', item.industry],
    ['Company size', item.company_size && `${item.company_size} employees`],
    ['Revenue range', item.revenue_range],
    ['City', item.city],
    ['State / region', item.state],
    ['Country', item.country],
    ['Explorium ID', item.external_id],
  ];
  return (
    <Modal
      open
      onClose={onClose}
      title={item.company_name || 'Company details'}
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          {item.in_crm ? (
            <Link className="btn btn-primary" to={`/companies/${item.existing_company_id}`}>Open in LeadHunter</Link>
          ) : (
            <button className="btn btn-primary" onClick={() => onImport([item])} disabled={importing}>
              <FiDownload /> {importing ? 'Importing…' : 'Import to LeadHunter'}
            </button>
          )}
        </>
      }
    >
      {item.description && <p className="text-sm mb-3">{item.description}</p>}
      <div className="form-row">
        {rows.map(([k, v]) => (
          <div key={k} className="field">
            <label>{k}</label>
            <div className="text-sm">{v || <span className="text-muted">Not provided by Explorium</span>}</div>
          </div>
        ))}
        <div className="field">
          <label>Website</label>
          <div className="text-sm">
            {item.website ? <a href={item.website} target="_blank" rel="noreferrer">{hostname(item.website)}</a> : <span className="text-muted">Not provided by Explorium</span>}
          </div>
        </div>
        <div className="field">
          <label>LinkedIn</label>
          <div className="text-sm">
            {item.linkedin_url ? <a href={item.linkedin_url} target="_blank" rel="noreferrer">Company page</a> : <span className="text-muted">Not provided by Explorium</span>}
          </div>
        </div>
      </div>
      <p className="text-sm text-muted">
        Lead score and recommended service are calculated by LeadHunter&apos;s existing rule-based scoring engine when
        the company is imported (it audits the website first). Nothing here indicates the company needs a new website.
      </p>
    </Modal>
  );
}

function SummaryModal({ summary, onClose, onRetry, importing }) {
  if (!summary) return null;
  const notImported = summary.results.filter((r) => r.status !== 'imported');
  return (
    <Modal
      open
      onClose={onClose}
      title="Import summary"
      size="lg"
      footer={
        <>
          {summary.failedItems.length > 0 && (
            <button className="btn" onClick={onRetry} disabled={importing}>
              <FiRefreshCw /> {importing ? 'Retrying…' : `Retry ${summary.failedItems.length} failed`}
            </button>
          )}
          <Link className="btn" to="/leads?source=explorium">View in Leads</Link>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="grid stat-grid mb-3">
        {[
          ['Successfully imported', summary.imported],
          ['Skipped as duplicate', summary.duplicates],
          ['Failed imports', summary.failed],
          ['Missing required information', summary.missingRequired],
        ].map(([k, v]) => (
          <div key={k} className="card stat-card">
            <span className="stat-label">{k}</span>
            <div className="stat-value">{fmtNumber(v)}</div>
          </div>
        ))}
      </div>
      {notImported.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Company</th><th>Result</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {notImported.map((r, i) => (
                <tr key={i}>
                  <td className="cell-strong">{r.company_name || '—'}</td>
                  <td><span className={`badge ${RESULT_LABELS[r.status]?.tone || 'gray'}`}>{RESULT_LABELS[r.status]?.label || r.status}</span></td>
                  <td className="text-sm">{r.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm text-muted mt-2">Retrying is safe: anything already imported is detected as a duplicate and skipped. Batch {summary.batchId}</p>
    </Modal>
  );
}

export default function ExploriumLeads() {
  const toast = useToast();
  const status = useApi(() => exploriumApi.status(), []);
  const stats = useApi(() => exploriumApi.stats(), []);

  const [f, setF] = useState({ company_name: '', industry: '', city: 'Ahmedabad', state: 'Gujarat', country: 'India', company_size: '', has_website: '', limit: 25 });
  const [applied, setApplied] = useState(null); // filters of the search currently shown
  const [result, setResult] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [liveStatus, setLiveStatus] = useState(null); // connection state learned from a failed search
  const [selected, setSelected] = useState(new Set());
  const [quickFilter, setQuickFilter] = useState('');
  const [detail, setDetail] = useState(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState(null);

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const connectionKey = liveStatus || status.data?.status;
  const connection = CONNECTION[connectionKey];
  const notConfigured = connectionKey === 'not_configured';

  const runSearch = async (filters, page) => {
    setSearching(true);
    setSearchError(null);
    try {
      const res = await exploriumApi.search({ ...filters, page });
      setResult(res);
      setApplied(filters);
      setSelected(new Set());
      setQuickFilter('');
      setLiveStatus(null);
    } catch (e) {
      setSearchError(e.message);
      if (e.details?.connection) setLiveStatus(e.details.connection);
    } finally {
      setSearching(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!f.company_name && !f.industry && !f.city && !f.state && !f.country && !f.company_size && !f.has_website) {
      toast.error('Enter at least one search filter');
      return;
    }
    runSearch(f, 1);
  };

  const items = result?.items || [];
  const importable = items.filter((it) => !it.in_crm);
  const visible = items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => !quickFilter || `${it.company_name} ${it.industry} ${it.city}`.toLowerCase().includes(quickFilter.toLowerCase()));

  const toggle = (idx) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });

  const importChosen = async (chosen) => {
    if (!chosen.length) return;
    setImporting(true);
    try {
      const res = await exploriumApi.import(chosen);
      // Server returns one result per item, in order.
      const done = new Map();
      res.results.forEach((r, i) => {
        if (r.company_id && r.status !== 'failed') done.set(chosen[i], r.company_id);
      });
      setResult((prev) => prev && { ...prev, items: prev.items.map((it) => (done.has(it) ? { ...it, in_crm: true, existing_company_id: done.get(it) } : it)) });
      setSummary({ ...res, failedItems: chosen.filter((_, i) => res.results[i]?.status === 'failed') });
      setSelected(new Set());
      setDetail(null);
      stats.reload();
      if (res.imported) toast.success(`Imported ${res.imported} lead${res.imported === 1 ? '' : 's'} into LeadHunter`);
    } catch (e) {
      toast.error(`Import request failed: ${e.message}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Explorium Leads</h1>
          <p>Find B2B companies in Explorium AgentSource and import them as LeadHunter prospects.</p>
        </div>
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          {status.loading ? (
            <span className="badge gray">Checking connection…</span>
          ) : status.error && !connection ? (
            <span className="badge gray" title={status.error}>Status unknown</span>
          ) : (
            <span className={`badge ${connection?.tone || 'gray'}`} title={status.data?.message || ''}>{connection?.label || 'Status unknown'}</span>
          )}
          {connectionKey === 'connected' && status.data?.credits?.remaining != null && (
            <span className="text-sm text-muted">{fmtNumber(status.data.credits.remaining)} credits left</span>
          )}
          <button className="btn btn-sm" onClick={() => { setLiveStatus(null); status.reload(); }} disabled={status.loading} title="Re-check connection">
            <FiRefreshCw />
          </button>
        </div>
      </div>

      {notConfigured && (
        <div className="card card-pad mb-3" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--surface-2)' }}>
          <FiAlertTriangle style={{ marginTop: 2, color: 'var(--warning)' }} />
          <div className="text-sm">
            <strong>Explorium is not configured.</strong> Set <code>EXPLORIUM_API_KEY</code> in the server environment
            (key from admin.explorium.ai → Access &amp; Authentication) and restart the API. Search stays disabled until
            then — no data is shown that Explorium did not return.
          </div>
        </div>
      )}
      {!notConfigured && connection && connectionKey !== 'connected' && (
        <div className="mb-3"><ErrorBox message={`${connection.label}${status.data?.message && !liveStatus ? ` — ${status.data.message}` : ''}`} /></div>
      )}

      <div className="grid stat-grid mb-3">
        {[
          ['Total Explorium leads', stats.data ? fmtNumber(stats.data.total) : '—', 'In LeadHunter'],
          ['New leads imported', stats.data ? fmtNumber(stats.data.recent) : '—', 'Last 7 days'],
          ['Already in LeadHunter', result ? fmtNumber(items.length - importable.length) : '—', 'On this results page'],
          ['Available to import', result ? fmtNumber(importable.length) : '—', 'On this results page'],
        ].map(([k, v, sub]) => (
          <div key={k} className="card stat-card">
            <span className="stat-label">{k}</span>
            <div className="stat-value">{v}</div>
            <span className="cell-sub">{sub}</span>
          </div>
        ))}
      </div>

      <Card className="mb-3">
        <form onSubmit={onSubmit}>
          <div className="filters">
            <div className="field">
              <label htmlFor="ex-name">Company name</label>
              <input id="ex-name" className="input" value={f.company_name} onChange={(e) => set('company_name', e.target.value)} maxLength={120} />
            </div>
            <div className="field">
              <label htmlFor="ex-industry">Industry</label>
              <input id="ex-industry" className="input" value={f.industry} onChange={(e) => set('industry', e.target.value)} placeholder="e.g. Hospitality" maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="ex-city">City</label>
              <input id="ex-city" className="input" value={f.city} onChange={(e) => set('city', e.target.value)} maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="ex-state">State</label>
              <input id="ex-state" className="input" value={f.state} onChange={(e) => set('state', e.target.value)} maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="ex-country">Country</label>
              <input id="ex-country" className="input" value={f.country} onChange={(e) => set('country', e.target.value)} maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="ex-size">Company size</label>
              <select id="ex-size" className="select" value={f.company_size} onChange={(e) => set('company_size', e.target.value)}>
                <option value="">Any</option>
                {COMPANY_SIZES.map((s) => <option key={s} value={s}>{s} employees</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ex-web">Company website</label>
              <select id="ex-web" className="select" value={f.has_website} onChange={(e) => set('has_website', e.target.value)}>
                <option value="">Any</option>
                <option value="yes">Has a website</option>
                <option value="no">No website</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ex-limit">Per page</label>
              <select id="ex-limit" className="select" value={f.limit} onChange={(e) => set('limit', Number(e.target.value))}>
                {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" type="submit" disabled={searching || notConfigured}>
              <FiSearch /> {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          <div className="chip-row mt-2">
            {LOCATIONS.map((l) => (
              <button
                type="button"
                key={l.label}
                className={`chip ${f.city === l.city && f.state === l.state && f.country === l.country ? 'active' : ''}`}
                onClick={() => setF((p) => ({ ...p, city: l.city, state: l.state, country: l.country }))}
              >
                {l.label}
              </button>
            ))}
            {INDUSTRIES.map((ind) => (
              <button type="button" key={ind} className={`chip ${f.industry === ind ? 'active' : ''}`} onClick={() => set('industry', f.industry === ind ? '' : ind)}>
                {ind}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted mt-2" style={{ marginBottom: 0 }}>
            <FiInfo style={{ verticalAlign: '-2px' }} /> Each search uses Explorium credits. Only the most specific
            location you fill in is sent (city, else state, else country). Explorium has no company-level email or
            phone, so those can&apos;t be searched or shown here.
          </p>
        </form>
      </Card>

      <Card
        bodyClass=""
        title={result ? `Results${result.pagination.total ? ` (${fmtNumber(result.pagination.total)})` : ''}` : 'Results'}
        actions={
          items.length > 0 && (
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              <input className="input" style={{ maxWidth: 180 }} value={quickFilter} onChange={(e) => setQuickFilter(e.target.value)} placeholder="Filter this page" aria-label="Filter this page" />
              <button className="btn btn-sm" onClick={() => importChosen(Array.from(selected).map((i) => items[i]))} disabled={!selected.size || importing}>
                Import selected ({selected.size})
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => importChosen(importable)} disabled={!importable.length || importing}>
                {importing ? 'Importing…' : `Import all on page (${importable.length})`}
              </button>
            </div>
          )
        }
      >
        {searching ? (
          <Loader label="Searching Explorium…" />
        ) : searchError ? (
          <div className="card-pad"><ErrorBox message={searchError} onRetry={applied || !notConfigured ? () => runSearch(applied || f, result?.pagination.page || 1) : undefined} /></div>
        ) : !result ? (
          <EmptyState icon={<FiSearch />} title="No search run yet" message={notConfigured ? 'Configure the Explorium API key to enable search.' : 'Choose filters above and press Search.'} />
        ) : !items.length ? (
          <EmptyState title="No companies found" message="Explorium returned no matches. Try a broader location or industry." />
        ) : (
          <>
            {(result.resolved?.industry || result.resolved?.location || result.creditsUsed != null) && (
              <div className="text-sm text-muted" style={{ padding: '10px 16px' }}>
                {result.resolved?.industry && <>Industry matched: <strong>{result.resolved.industry.join(', ')}</strong>. </>}
                {result.resolved?.location && <>Location matched: <strong>{result.resolved.location}</strong>. </>}
                {result.creditsUsed != null && <>Credits used: <strong>{result.creditsUsed}</strong>.</>}
              </div>
            )}
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select all importable on this page"
                        checked={importable.length > 0 && selected.size === importable.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(items.map((it, i) => (it.in_crm ? null : i)).filter((i) => i !== null)) : new Set())}
                      />
                    </th>
                    <th>Company</th>
                    <th>Industry</th>
                    <th>Website</th>
                    <th>Size</th>
                    <th>City</th>
                    <th>Country</th>
                    <th>Import status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ it, idx }) => (
                    <tr key={it.external_id || idx}>
                      <td>
                        <input type="checkbox" aria-label={`Select ${it.company_name}`} checked={selected.has(idx)} disabled={it.in_crm} onChange={() => toggle(idx)} />
                      </td>
                      <td className="cell-strong">{it.company_name || '—'}</td>
                      <td className="text-sm" style={{ maxWidth: 220 }}>{it.industry || '—'}</td>
                      <td className="text-sm">
                        {it.website ? <a href={it.website} target="_blank" rel="noreferrer">{hostname(it.website)}</a> : '—'}
                      </td>
                      <td className="text-sm nowrap">{it.company_size || '—'}</td>
                      <td className="text-sm">{it.city || '—'}</td>
                      <td className="text-sm">{it.country || '—'}</td>
                      <td>
                        {it.in_crm ? <span className="badge gray">In LeadHunter</span> : <span className="badge blue">Available</span>}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button className="icon-btn" title="View details" aria-label={`View details for ${it.company_name}`} onClick={() => setDetail(it)}><FiEye /></button>
                          {it.in_crm ? (
                            <Link className="icon-btn" to={`/companies/${it.existing_company_id}`} title="Open in LeadHunter"><FiExternalLink /></Link>
                          ) : (
                            <button className="icon-btn" title="Import to LeadHunter" aria-label={`Import ${it.company_name}`} onClick={() => importChosen([it])} disabled={importing}><FiDownload /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={result.pagination} onChange={(p) => runSearch(applied, p)} />
          </>
        )}
      </Card>

      <DetailsModal item={detail} onClose={() => setDetail(null)} onImport={importChosen} importing={importing} />
      <SummaryModal summary={summary} onClose={() => setSummary(null)} onRetry={() => importChosen(summary.failedItems)} importing={importing} />
    </div>
  );
}
