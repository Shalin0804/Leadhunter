import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiBookOpen } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { contactApi } from '../services/endpoints';
import { Card, Loader, ErrorBox, EmptyState, Pagination } from '../components/ui';
import ContactValue from '../components/ContactValue';
import { fmtIST, leadCode } from '../utils/rbac';

const STATE = {
  verified: ['green', 'Verified', 'Passed the email verifier'],
  invalid: ['not_qualified', 'Invalid', 'The verifier reported it undeliverable'],
  found_unverified: ['gray', 'Found, not verified', 'Published by a source; no verification has been run'],
};
const ENRICH = { not_attempted: 'Not yet checked', pending: 'Check pending', success: 'Checked', failed: 'Check failed', skipped: 'Check skipped' };

export default function Contacts() {
  const [f, setF] = useState({ search: '', type: '', verification: '', named: '', sort: '' });
  const [page, setPage] = useState(1);
  const search = useDebounced(f.search, 350);
  const query = useMemo(() => ({ ...f, search, page, limit: 25 }), [f.type, f.verification, f.named, f.sort, search, page]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data, loading, error, reload } = useApi(() => contactApi.list(query), [JSON.stringify(query)]);
  const set = (k, v) => {
    setF((x) => ({ ...x, [k]: v }));
    setPage(1);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Contacts</h1>
          <p>Public business contact details for the leads you can access. Values are revealed per field and every reveal is logged.</p>
        </div>
      </div>
      <Card className="mb-3">
        <div className="filters">
          <div className="field"><label>Search</label><input className="input" placeholder="Contact, role or company" value={f.search} onChange={(e) => set('search', e.target.value)} /></div>
          <div className="field">
            <label>Type</label>
            <select className="select" value={f.type} onChange={(e) => set('type', e.target.value)}>
              <option value="">Any</option><option value="phone">Phone</option><option value="email">Email</option><option value="linkedin">LinkedIn</option>
            </select>
          </div>
          <div className="field">
            <label>Verification</label>
            <select className="select" value={f.verification} onChange={(e) => set('verification', e.target.value)}>
              <option value="">Any</option><option value="verified">Verified</option><option value="unverified">Found, not verified</option><option value="invalid">Invalid</option>
            </select>
          </div>
          <div className="field">
            <label>Person</label>
            <select className="select" value={f.named} onChange={(e) => set('named', e.target.value)}>
              <option value="">Any</option><option value="true">Named contact only</option>
            </select>
          </div>
          <div className="field">
            <label>Sort</label>
            <select className="select" value={f.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="">Recently updated</option><option value="company">Company</option>
            </select>
          </div>
        </div>
      </Card>
      <Card bodyClass="">
        {loading && !data ? <Loader /> : error ? <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div> : !data.items.length ? (
          <EmptyState icon={<FiBookOpen />} title="No contacts found" message="Contacts appear here once discovery or enrichment finds them for leads you can access." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Contact</th><th>Value</th><th>Company</th><th>Lead</th><th>Status</th><th>Source</th><th>Updated</th></tr></thead>
                <tbody>
                  {data.items.map((c) => {
                    const [tone, label, title] = STATE[c.state];
                    return (
                      <tr key={c.id}>
                        <td>
                          <div className="cell-strong">{c.contact_name || <span className="text-muted">No named person</span>}</div>
                          <div className="cell-sub">{[c.job_title, c.type].filter(Boolean).join(' · ')}{c.is_role_based ? ' · role inbox' : ''}</div>
                        </td>
                        <td className="text-sm">{c.lead_id ? <ContactValue contact={c} leadId={c.lead_id} /> : c.value || c.value_masked}</td>
                        <td><div>{c.company.company_name}</div><div className="cell-sub">{[c.company.city, c.company.industry].filter(Boolean).join(' · ')}</div></td>
                        <td className="text-sm">{c.lead_id ? <Link to={`/leads/${c.lead_id}`}>{leadCode(c.lead_id)}</Link> : '—'}</td>
                        <td>
                          <span className={`badge ${tone}`} title={title}>{label}</span>
                          <div className="cell-sub">Enrichment: {ENRICH[c.company.enrichment_status] || c.company.enrichment_status}</div>
                        </td>
                        <td className="text-sm">{c.source || 'unknown'}{c.confidence != null && <div className="cell-sub">{c.confidence}% confidence</div>}</td>
                        <td className="text-sm">{fmtIST(c.updated_at).split(',')[0]}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
