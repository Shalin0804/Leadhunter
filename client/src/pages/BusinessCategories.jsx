import { useState } from 'react';
import { FiPlus, FiEdit2, FiTag } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { leadDiscoveryApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Modal } from '../components/ui';
import { fmtIST } from '../utils/rbac';
import { titleCase } from '../utils/format';

const PRIORITY = { 5: 'Top', 4: 'High', 3: 'Normal', 2: 'Low', 1: 'Minimal' };

function CategoryForm({ initial, categories, opportunityTypes, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({
    name: initial?.name || '',
    keyword: initial?.keyword || '',
    description: initial?.description || '',
    parent_id: initial?.parent_id || '',
    priority: initial?.priority || 3,
    opportunity_types: initial?.opportunity_types || [],
    is_enabled: initial?.is_enabled ?? true,
  }));
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleType = (t) => set('opportunity_types', f.opportunity_types.includes(t) ? f.opportunity_types.filter((x) => x !== t) : [...f.opportunity_types, t]);
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { ...f, parent_id: f.parent_id || null, priority: Number(f.priority) };
      if (initial?.id) await leadDiscoveryApi.updateCategory(initial.id, body);
      else await leadDiscoveryApi.createCategory(body);
      toast.success('Category saved');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open onClose={onClose} title={initial?.id ? `Edit ${initial.name}` : 'Add business category'}>
      <form onSubmit={save}>
        <div className="field"><label>Name</label><input className="input" required minLength={2} maxLength={80} value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field">
          <label>Search keyword (sent to discovery providers)</label>
          <input className="input" maxLength={60} placeholder="e.g. hotels, clinics, real estate" value={f.keyword} onChange={(e) => set('keyword', e.target.value)} />
        </div>
        <div className="field"><label>Description</label><textarea className="input" rows={2} maxLength={500} value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
        <div className="grid-2">
          <div className="field">
            <label>Industry group (parent)</label>
            <select className="select" value={f.parent_id} onChange={(e) => set('parent_id', e.target.value)}>
              <option value="">— None —</option>
              {categories.filter((c) => c.id !== initial?.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Priority</label>
            <select className="select" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
              {[5, 4, 3, 2, 1].map((p) => <option key={p} value={p}>{p} — {PRIORITY[p]}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Relevant opportunity types</label>
          <div className="chip-row">
            {opportunityTypes.map((t) => (
              <button type="button" key={t} className={`chip ${f.opportunity_types.includes(t) ? 'active' : ''}`} onClick={() => toggleType(t)}>{titleCase(t.toLowerCase())}</button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 mb-3">
          <input type="checkbox" checked={f.is_enabled} onChange={(e) => set('is_enabled', e.target.checked)} /> Enabled for Lead Discovery
        </label>
        <button className="btn btn-primary btn-block">Save</button>
      </form>
    </Modal>
  );
}

export default function BusinessCategories() {
  const toast = useToast();
  const [filters, setFilters] = useState({ search: '', status: '', sort: 'priority' });
  const [editing, setEditing] = useState(null);
  const search = useDebounced(filters.search, 300);
  const { data, loading, error, reload } = useApi(() => leadDiscoveryApi.categories({ search, status: filters.status, sort: filters.sort }), [search, filters.status, filters.sort]);
  const { data: all } = useApi(() => leadDiscoveryApi.categories(), [data]);

  const toggle = async (c) => {
    try {
      await leadDiscoveryApi.updateCategory(c.id, { is_enabled: !c.is_enabled });
      toast.success(`${c.name} ${c.is_enabled ? 'disabled' : 'enabled'}`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Business Categories</h1>
          <p>What Lead Discovery searches for. Only enabled categories appear to employees; changes are recorded in the Audit Trail.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({})}><FiPlus /> Add category</button>
      </div>

      <Card className="mb-3">
        <div className="filters">
          <div className="field"><label>Search</label><input className="input" placeholder="Name or keyword" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></div>
          <div className="field">
            <label>Status</label>
            <select className="select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>
            </select>
          </div>
          <div className="field">
            <label>Sort</label>
            <select className="select" value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })}>
              <option value="priority">Priority</option><option value="name">Name</option><option value="updated_at">Last updated</option>
            </select>
          </div>
        </div>
      </Card>

      <Card bodyClass="">
        {loading && !data ? <Loader /> : error ? <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div> : !data.categories.length ? (
          <EmptyState icon={<FiTag />} title="No categories match" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Category</th><th>Keyword</th><th>Group</th><th>Opportunity types</th><th>Priority</th><th>Status</th><th>Updated</th><th></th></tr></thead>
              <tbody>
                {data.categories.map((c) => (
                  <tr key={c.id}>
                    <td><div className="cell-strong">{c.name}</div>{c.description && <div className="cell-sub">{c.description}</div>}</td>
                    <td className="text-sm"><code>{c.keyword}</code></td>
                    <td className="text-sm">{c.parent?.name || '—'}</td>
                    <td>{(c.opportunity_types || []).map((t) => <span key={t} className="badge blue" style={{ marginRight: 4 }}>{titleCase(t.toLowerCase())}</span>)}</td>
                    <td className="text-sm">{c.priority} — {PRIORITY[c.priority]}</td>
                    <td><button className={`badge ${c.is_enabled ? 'green' : 'not_qualified'}`} style={{ cursor: 'pointer', border: 'none' }} onClick={() => toggle(c)} title="Toggle">{c.is_enabled ? 'Enabled' : 'Disabled'}</button></td>
                    <td className="text-sm">{fmtIST(c.updated_at).split(',')[0]}</td>
                    <td><button className="btn btn-sm" onClick={() => setEditing(c)} title="Edit"><FiEdit2 /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <CategoryForm initial={editing.id ? editing : null} categories={all?.categories || []} opportunityTypes={data?.opportunity_types || []} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  );
}
