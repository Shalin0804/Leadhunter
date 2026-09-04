import { useState } from 'react';
import { FiSearch, FiDownload, FiAlertTriangle, FiInfo } from 'react-icons/fi';
import { Modal, EmptyState } from './ui';
import { apolloApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { fmtNumber } from '../utils/format';

const EMPLOYEE_RANGES = [
  { label: 'Any size', value: '' },
  { label: '1-10', value: '1,10' },
  { label: '11-50', value: '11,50' },
  { label: '51-200', value: '51,200' },
  { label: '201-500', value: '201,500' },
  { label: '501-1000', value: '501,1000' },
  { label: '1000+', value: '1001,1000000' },
];

export default function ApolloSearchModal({ open, onClose, onImported }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', location: '', employeeRange: '' });
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const runSearch = async () => {
    if (!f.name && !f.location) {
      toast.error('Enter a company name or a location to search');
      return;
    }
    setBusy(true);
    try {
      const res = await apolloApi.search({
        name: f.name || undefined,
        locations: f.location ? f.location.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        employee_ranges: f.employeeRange ? [f.employeeRange] : undefined,
        per_page: 25,
      });
      setResults(res.items || []);
      setSelected(new Set());
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (idx) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const importChosen = async (items) => {
    if (!items.length) return;
    setImporting(true);
    try {
      const res = await apolloApi.import(items);
      toast.success(`Imported: ${res.created} new, ${res.updated} updated`);
      onImported?.();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Search Apollo for companies"
      size="lg"
      footer={
        results?.length ? (
          <>
            <button className="btn" onClick={() => setResults(null)}>Back to search</button>
            <button
              className="btn"
              onClick={() => importChosen(Array.from(selected).map((i) => results[i]))}
              disabled={!selected.size || importing}
            >
              Import selected ({selected.size})
            </button>
            <button className="btn btn-primary" onClick={() => importChosen(results)} disabled={importing}>
              {importing ? 'Importing…' : `Import all ${results.length}`}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={runSearch} disabled={busy}>
            <FiSearch /> {busy ? 'Searching…' : 'Search'}
          </button>
        )
      }
    >
      <div className="card card-pad mb-3" style={{ display: 'flex', gap: 10, background: 'var(--surface-2)' }}>
        <FiAlertTriangle style={{ marginTop: 2, color: 'var(--warning)' }} />
        <div className="text-sm text-muted">
          Each search costs <strong>1 Apollo credit</strong> (0 if no results). Results come from Apollo's licensed
          B2B database via their official API — this is not a scraper. Imported companies are scored automatically.
        </div>
      </div>

      {!results && (
        <>
          <div className="form-row">
            <div className="field">
              <label>Company name</label>
              <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Acme" />
            </div>
            <div className="field">
              <label>Location(s)</label>
              <input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="e.g. Mumbai, India" />
            </div>
          </div>
          <div className="field">
            <label>Employee count</label>
            <select className="select" value={f.employeeRange} onChange={(e) => set('employeeRange', e.target.value)}>
              {EMPLOYEE_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        </>
      )}

      {results && (
        results.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th></th>
                  <th>Company</th>
                  <th>Industry</th>
                  <th>Location</th>
                  <th>Employees</th>
                  <th>Phone</th>
                  <th>Website</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => (
                  <tr key={idx}>
                    <td><input type="checkbox" checked={selected.has(idx)} onChange={() => toggle(idx)} /></td>
                    <td className="cell-strong">{r.company_name}</td>
                    <td className="text-sm">{r.industry || '—'}</td>
                    <td className="text-sm">{[r.city, r.state].filter(Boolean).join(', ') || '—'}</td>
                    <td className="text-sm">{r.employee_count ? fmtNumber(r.employee_count) : '—'}</td>
                    <td className="text-sm">{r.phone || <span className="text-muted">not on file</span>}</td>
                    <td className="text-sm">{r.website ? new URL(r.website).hostname : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<FiInfo />} title="No matches" message="Try a broader name or location." />
        )
      )}
    </Modal>
  );
}
