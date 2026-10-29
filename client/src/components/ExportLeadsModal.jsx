import { useEffect, useMemo, useRef, useState } from 'react';
import { FiDownload, FiRefreshCw, FiRotateCcw } from 'react-icons/fi';
import { Modal, Loader, ErrorBox } from './ui';
import { leadApi, userApi } from '../services/endpoints';
import { useApi, useDebounced } from '../hooks/useApi';
import { useToast } from '../context/ToastContext';
import { titleCase, fmtDateTime, fmtNumber, STATUS_LABELS, CONTACT_STATUS_LABELS, LEAD_SOURCE_LABELS } from '../utils/format';

const PRESETS = [
  ['all', 'All Time'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last7', 'Last 7 Days'],
  ['last30', 'Last 30 Days'],
  ['thisMonth', 'This Month'],
  ['lastMonth', 'Last Month'],
  ['custom', 'Custom Date Range'],
];

const NUMBER_FILTERS = ['min_score', 'max_score', 'employees_min', 'employees_max', 'search_run_id'];
const EMPTY_FILTERS = {};

// Calendar dates in the browser's own timezone; the server converts them to UTC with the same timezone.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function presetRange(preset) {
  const t = new Date();
  const shift = (n) => ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n));
  switch (preset) {
    case 'today': return [shift(0), shift(0)];
    case 'yesterday': return [shift(-1), shift(-1)];
    case 'last7': return [shift(-6), shift(0)];
    case 'last30': return [shift(-29), shift(0)];
    case 'thisMonth': return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(new Date(t.getFullYear(), t.getMonth() + 1, 0))];
    case 'lastMonth': return [ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), ymd(new Date(t.getFullYear(), t.getMonth(), 0))];
    default: return null;
  }
}

const LABELS = { status: STATUS_LABELS, contact_status: CONTACT_STATUS_LABELS, source: LEAD_SOURCE_LABELS };
const label = (group, v) => LABELS[group]?.[v] || titleCase(String(v).toLowerCase());

/** Multi-select as toggle chips — any selected value matches (OR within a group, AND across groups). */
function ChipGroup({ title, group, options, value = [], onChange }) {
  if (!options?.length) return null;
  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="field export-span">
      <label>{title}</label>
      <div className="chip-row">
        {options.map((o) => (
          <button type="button" key={o} className={`chip chip-sm ${value.includes(o) ? 'active' : ''}`} aria-pressed={value.includes(o)} onClick={() => toggle(o)}>
            {label(group, o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ExportLeadsModal({ open, onClose, initialFilters = EMPTY_FILTERS }) {
  const toast = useToast();
  const { data: meta, error: metaError, reload: reloadMeta } = useApi(() => (open ? leadApi.exportMeta() : null), [open]);
  const { data: users } = useApi(() => (open ? userApi.list() : null), [open]);
  const { data: history, reload: reloadHistory } = useApi(() => (open ? leadApi.exportHistory() : null), [open]);

  const [preset, setPreset] = useState('all');
  const [dateField, setDateField] = useState('created_at');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [filters, setFilters] = useState(initialFilters);
  const [columns, setColumns] = useState(null); // null = all, until meta loads
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const seq = useRef(0);

  // Start from the Leads page's current filters each time the modal opens.
  useEffect(() => {
    if (open) setFilters(initialFilters);
  }, [open, initialFilters]);

  useEffect(() => {
    if (meta && !columns) setColumns(meta.columns.map((c) => c.key));
  }, [meta, columns]);

  const setF = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const text = (k, title, placeholder) => (
    <div className="field">
      <label htmlFor={`exf-${k}`}>{title}</label>
      <input id={`exf-${k}`} className="input" value={filters[k] || ''} placeholder={placeholder} onChange={(e) => setF(k, e.target.value)} />
    </div>
  );
  const number = (k, title, max) => (
    <div className="field">
      <label htmlFor={`exf-${k}`}>{title}</label>
      <input id={`exf-${k}`} className="input" type="number" min="0" max={max} value={filters[k] ?? ''} onChange={(e) => setF(k, e.target.value)} />
    </div>
  );
  const choice = (k, title, options) => (
    <div className="field">
      <label htmlFor={`exf-${k}`}>{title}</label>
      <select id={`exf-${k}`} className="select" value={filters[k] || ''} onChange={(e) => setF(k, e.target.value)}>
        <option value="">Any</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );

  const range = preset === 'custom' ? [custom.from, custom.to] : presetRange(preset);
  const rangeError =
    preset === 'custom' && (!custom.from || !custom.to)
      ? 'Pick both a start and an end date.'
      : range && range[0] > range[1]
        ? 'Start date cannot be later than end date.'
        : null;

  // Request body shared by preview and export, so both see exactly the same criteria.
  const criteria = useMemo(() => {
    const f = {};
    for (const [k, v] of Object.entries(filters)) {
      if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
      f[k] = NUMBER_FILTERS.includes(k) ? Number(v) : v;
    }
    return {
      date_field: dateField,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(range ? { date_from: range[0], date_to: range[1] } : {}),
      filters: f,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, dateField, preset, custom.from, custom.to]);

  const runPreview = async () => {
    if (rangeError) return;
    const mine = ++seq.current;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const r = await leadApi.exportPreview(criteria);
      if (mine === seq.current) setPreview(r);
    } catch (e) {
      if (mine === seq.current) {
        setPreview(null);
        setPreviewError(e.message);
      }
    } finally {
      if (mine === seq.current) setPreviewing(false);
    }
  };

  // Live count: re-preview shortly after the criteria stop changing.
  const debouncedKey = useDebounced(JSON.stringify(criteria), 450);
  useEffect(() => {
    if (open) runPreview();
    else setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debouncedKey, rangeError]);

  const stale = JSON.stringify(criteria) !== debouncedKey || previewing;
  const canExport = !exporting && !rangeError && !stale && preview?.count > 0 && columns?.length > 0;

  const doExport = async () => {
    if (!canExport) return;
    setExporting(true);
    try {
      await leadApi.exportXlsx({ ...criteria, columns });
      toast.success(`Exported ${fmtNumber(preview.count)} leads to Excel`);
      reloadHistory();
    } catch (e) {
      toast.error(e.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const reset = () => {
    setFilters({});
    setPreset('all');
    setDateField('created_at');
    setCustom({ from: '', to: '' });
  };

  const toggleColumn = (key) =>
    setColumns((cols) => (cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]));

  const e = meta?.enums || {};
  const footer = (
    <>
      <button className="btn" onClick={reset} disabled={exporting}><FiRotateCcw /> Reset Filters</button>
      <button className="btn" onClick={runPreview} disabled={previewing || exporting || !!rangeError}><FiRefreshCw /> Preview Matching Leads</button>
      <button className="btn btn-primary" onClick={doExport} disabled={!canExport} aria-busy={exporting}>
        {exporting ? <><span className="spinner spinner-sm" /> Generating Excel…</> : <><FiDownload /> Export Excel</>}
      </button>
    </>
  );

  return (
    <Modal open={open} onClose={exporting ? undefined : onClose} title="Export Leads to Excel (.xlsx)" size="lg" footer={footer}>
      {metaError ? (
        <ErrorBox message={metaError} onRetry={reloadMeta} />
      ) : !meta || !columns ? (
        <Loader label="Loading export options…" />
      ) : (
        <div className="export-modal">
          <section>
            <h4 className="section-title">A. Date Range</h4>
            <div className="chip-row mb-3">
              {PRESETS.map(([v, l]) => (
                <button type="button" key={v} className={`chip ${preset === v ? 'active' : ''}`} aria-pressed={preset === v} onClick={() => setPreset(v)}>{l}</button>
              ))}
            </div>
            <div className="export-grid">
              <div className="field">
                <label htmlFor="exf-date-field">Date field</label>
                <select id="exf-date-field" className="select" value={dateField} onChange={(ev) => setDateField(ev.target.value)} disabled={preset === 'all'}>
                  {meta.date_fields.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="exf-from">Start date</label>
                <input id="exf-from" className="input" type="date" value={preset === 'custom' ? custom.from : range?.[0] || ''} disabled={preset !== 'custom'} onChange={(ev) => setCustom((c) => ({ ...c, from: ev.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="exf-to">End date (inclusive)</label>
                <input id="exf-to" className="input" type="date" value={preset === 'custom' ? custom.to : range?.[1] || ''} disabled={preset !== 'custom'} onChange={(ev) => setCustom((c) => ({ ...c, to: ev.target.value }))} />
              </div>
            </div>
            {rangeError && <p className="text-sm export-error" role="alert">{rangeError}</p>}
          </section>

          <section>
            <h4 className="section-title">B. Lead Filters</h4>
            <p className="text-sm text-muted export-hint">Leads must match every filter you set. Text filters match partially and ignore case.</p>
            <div className="export-grid">
              {text('company_name', 'Company name')}
              {text('website', 'Website / domain')}
              {text('email', 'Email')}
              {text('phone', 'Phone number')}
              {text('city', 'City')}
              {text('state', 'State')}
              {text('industry', 'Industry')}
              {text('category', 'Business category')}
              {number('employees_min', 'Min company size')}
              {number('employees_max', 'Max company size')}
              {number('min_score', 'Min lead score', 100)}
              {number('max_score', 'Max lead score', 100)}
              {choice('contacted', 'Contacted', [['yes', 'Contacted'], ['no', 'Not contacted']])}
              {choice('has_website', 'Website', [['yes', 'Has website'], ['no', 'No website']])}
              {choice('follow_up', 'Follow-up', [['due', 'Due / overdue'], ['scheduled', 'Scheduled (future)'], ['none', 'No follow-up set']])}
              {choice('assigned_user_id', 'Assigned user', [['unassigned', 'Unassigned'], ...(users?.users || []).map((u) => [String(u.id), u.name])])}
              {choice('provider', 'Discovery provider', meta.providers.map((p) => [p, titleCase(p)]))}
              {choice('search_run_id', 'Search run', meta.search_runs.map((r) => [String(r.id), `#${r.id} — ${fmtDateTime(r.started_at)}`]))}
              <ChipGroup title="Lead source" group="source" options={meta.sources} value={filters.source} onChange={(v) => setF('source', v)} />
              <ChipGroup title="Pipeline stage" group="status" options={e.status} value={filters.status} onChange={(v) => setF('status', v)} />
              <ChipGroup title="Contact status" group="contact_status" options={e.contact_status} value={filters.contact_status} onChange={(v) => setF('contact_status', v)} />
              <ChipGroup title="Qualification status" group="lead_status" options={e.lead_status} value={filters.lead_status} onChange={(v) => setF('lead_status', v)} />
              <ChipGroup title="Lead priority" group="priority" options={e.priority} value={filters.priority} onChange={(v) => setF('priority', v)} />
              <ChipGroup title="Lead temperature" group="lead_temperature" options={e.lead_temperature} value={filters.lead_temperature} onChange={(v) => setF('lead_temperature', v)} />
              <ChipGroup title="AI qualification" group="ai" options={e.ai_qualification_status} value={filters.ai_qualification_status} onChange={(v) => setF('ai_qualification_status', v)} />
              <ChipGroup title="Website audit status" group="website_status" options={e.website_status} value={filters.website_status} onChange={(v) => setF('website_status', v)} />
              <ChipGroup title="Detected signals" group="signals" options={e.signal_types} value={filters.signal_types} onChange={(v) => setF('signal_types', v)} />
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-2">
              <h4 className="section-title">C. Export Columns ({columns.length}/{meta.columns.length})</h4>
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm" onClick={() => setColumns(meta.columns.map((c) => c.key))}>Select All Columns</button>
                <button type="button" className="btn btn-sm" onClick={() => setColumns([])}>Deselect All Columns</button>
              </div>
            </div>
            <div className="export-columns">
              {meta.columns.map((c) => (
                <label key={c.key} className="export-check">
                  <input type="checkbox" checked={columns.includes(c.key)} onChange={() => toggleColumn(c.key)} /> {c.header}
                </label>
              ))}
            </div>
            {!columns.length && <p className="text-sm export-error" role="alert">Select at least one column.</p>}
          </section>

          <section className="export-summary" aria-live="polite">
            <h4 className="section-title">D. Export Summary</h4>
            {previewError ? (
              <ErrorBox message={previewError} onRetry={runPreview} />
            ) : (
              <dl>
                <dt>Date range</dt>
                <dd>{preview?.summary ? `${preview.summary.dateRange}${range ? ` (${preview.summary.dateField})` : ''}` : '—'}</dd>
                <dt>Applied filters</dt>
                <dd>{preview?.summary?.filters?.length ? preview.summary.filters.join(', ') : 'None'}</dd>
                <dt>Matching leads</dt>
                <dd><strong>{stale ? 'Counting…' : preview ? fmtNumber(preview.count) : '—'}</strong></dd>
                <dt>Selected columns</dt>
                <dd>{columns.length}</dd>
              </dl>
            )}
            {!stale && preview?.count === 0 && <p className="text-sm export-error">No leads match these criteria. Adjust the date range or filters to export.</p>}
            {history?.items?.length > 0 && (
              <p className="text-sm text-muted mt-2">
                Last export: {fmtDateTime(history.items[0].created_at)} — {fmtNumber(history.items[0].row_count)} leads ({history.items[0].status.toLowerCase()})
              </p>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
