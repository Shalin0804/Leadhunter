import { useState } from 'react';
import { FiSearch, FiAlertTriangle, FiInfo, FiLinkedin } from 'react-icons/fi';
import { Modal, EmptyState } from './ui';
import { leadiqApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { fmtNumber } from '../utils/format';

const SENIORITIES = ['VP', 'Director', 'Manager', 'Executive', 'SeniorIndividualContributor', 'Other'];

export default function LeadIQSearchModal({ open, onClose, onImported }) {
  const toast = useToast();
  const [f, setF] = useState({ city: '', state: '', country: '', industries: '', titles: '', seniority: '', companySizeMin: '', companySizeMax: '', keywords: '', limit: 25 });
  const [results, setResults] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [revealContacts, setRevealContacts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

  const runSearch = async () => {
    if (!f.city && !f.state && !f.country && !f.industries) {
      toast.error('Enter at least a location or an industry to search');
      return;
    }
    setBusy(true);
    try {
      const res = await leadiqApi.search({
        city: f.city || undefined,
        state: f.state || undefined,
        country: f.country || undefined,
        industries: csv(f.industries),
        titles: csv(f.titles),
        seniorities: f.seniority ? [f.seniority] : undefined,
        company_size_min: f.companySizeMin ? Number(f.companySizeMin) : undefined,
        company_size_max: f.companySizeMax ? Number(f.companySizeMax) : undefined,
        keywords: csv(f.keywords),
        limit: Math.min(Number(f.limit) || 25, 100),
      });
      setResults(res.people || []);
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
      const res = await leadiqApi.import(items, revealContacts);
      toast.success(`Imported: ${res.imported} new, ${res.alreadyExisted} already existed, ${res.failed} failed`);
      if (res.revealError) toast.error(`Contact reveal failed, imported profile-only: ${res.revealError}`);
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
      onClose={() => { setResults(null); onClose(); }}
      title="Search LeadIQ for real leads"
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
          Results come from LeadIQ&apos;s real, licensed prospecting database via their official API — this is not a
          scraper and never invents leads. Profile search (name, title, company, LinkedIn) is included; revealing
          real email/phone is a separate step that uses LeadIQ credits per contact — only turned on if you check
          &quot;Reveal contact info&quot; below.
        </div>
      </div>

      {!results && (
        <>
          <div className="form-row">
            <div className="field">
              <label>City</label>
              <input className="input" value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="e.g. Ahmedabad" />
            </div>
            <div className="field">
              <label>State / Region</label>
              <input className="input" value={f.state} onChange={(e) => set('state', e.target.value)} placeholder="e.g. Gujarat" />
            </div>
            <div className="field">
              <label>Country</label>
              <input className="input" value={f.country} onChange={(e) => set('country', e.target.value)} placeholder="e.g. India" />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Industries (comma-separated)</label>
              <input className="input" value={f.industries} onChange={(e) => set('industries', e.target.value)} placeholder="e.g. Restaurants, Hospitality" />
            </div>
            <div className="field">
              <label>Job titles (comma-separated)</label>
              <input className="input" value={f.titles} onChange={(e) => set('titles', e.target.value)} placeholder="e.g. Owner, Founder, Director" />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Seniority</label>
              <select className="select" value={f.seniority} onChange={(e) => set('seniority', e.target.value)}>
                <option value="">Any</option>
                {SENIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Company size (min)</label>
              <input className="input" type="number" value={f.companySizeMin} onChange={(e) => set('companySizeMin', e.target.value)} />
            </div>
            <div className="field">
              <label>Company size (max)</label>
              <input className="input" type="number" value={f.companySizeMax} onChange={(e) => set('companySizeMax', e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Keywords / role (comma-separated)</label>
              <input className="input" value={f.keywords} onChange={(e) => set('keywords', e.target.value)} placeholder="optional" />
            </div>
            <div className="field">
              <label>Number of leads (max 100)</label>
              <input className="input" type="number" value={f.limit} onChange={(e) => set('limit', e.target.value)} />
            </div>
          </div>
        </>
      )}

      {results && (
        <>
          <label className="flex items-center gap-2 text-sm mb-3" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={revealContacts} onChange={(e) => setRevealContacts(e.target.checked)} />
            Reveal real email/phone for imported leads (uses LeadIQ credits per contact)
          </label>
          {results.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th></th>
                    <th>Person</th>
                    <th>Title</th>
                    <th>Company</th>
                    <th>Location</th>
                    <th>Email</th>
                    <th>Website</th>
                    <th>LinkedIn</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, idx) => (
                    <tr key={idx}>
                      <td><input type="checkbox" checked={selected.has(idx)} onChange={() => toggle(idx)} /></td>
                      <td className="cell-strong">{r.contact_name || '—'}</td>
                      <td className="text-sm">{r.job_title || '—'}</td>
                      <td className="text-sm">
                        {r.company_name || '—'}
                        {r.employee_count ? <span className="cell-sub"> · {fmtNumber(r.employee_count)} employees</span> : null}
                      </td>
                      <td className="text-sm">{[r.city, r.state].filter(Boolean).join(', ') || '—'}</td>
                      <td className="text-sm">
                        {r.email ? <span className="badge green">Revealed</span> : <span className="text-muted">not revealed</span>}
                      </td>
                      <td className="text-sm">{r.website ? new URL(r.website).hostname : '—'}</td>
                      <td className="text-sm">
                        {r.linkedin_url ? (
                          <a href={r.linkedin_url} target="_blank" rel="noreferrer"><FiLinkedin /></a>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<FiInfo />} title="No matches" message="Try a broader location, industry, or title." />
          )}
        </>
      )}
    </Modal>
  );
}
