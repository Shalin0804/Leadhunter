import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiUploadCloud, FiCheckCircle, FiAlertCircle, FiArrowRight, FiFile } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { importApi, signalApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, EmptyState, ErrorBox } from '../components/ui';
import { fmtDateTime } from '../utils/format';

const COMPANY_COLUMNS = [
  'company_name', 'cin', 'registration_number', 'date_of_incorporation', 'company_status',
  'company_type', 'company_category', 'industry', 'roc', 'state', 'city',
  'registered_address', 'authorized_capital', 'paid_up_capital', 'website', 'email', 'phone',
];
const SIGNAL_COLUMNS = [
  'company_name', 'website', 'contact_name', 'contact_email', 'contact_phone',
  'service', 'source', 'source_url', 'headline', 'detail', 'captured_at',
];

const STEPS = ['Upload', 'Preview & validate', 'Confirm', 'Summary'];

const MODES = {
  companies: {
    label: 'Companies',
    columns: COMPANY_COLUMNS,
    sample: 'server/seed/sample-companies.csv',
    hint: (
      <>Only <strong>company_name</strong> is required. Header aliases (e.g. <em>registration_date</em>, <em>sector</em>) are auto-detected.</>
    ),
    preview: (file) => importApi.preview(file),
    run: (file) => importApi.run(file, true),
  },
  signals: {
    label: 'Buying Signals',
    columns: SIGNAL_COLUMNS,
    sample: 'server/seed/sample-signals.csv',
    hint: (
      <>
        Needs at least <strong>company_name</strong>, <strong>website</strong> or <strong>contact_email</strong>. Works with
        exports from LinkedIn Lead Gen Forms, Meta Lead Ads, Typeform, or your website contact form. Free-text
        <em> service</em> / <em>source</em> values are mapped automatically.
      </>
    ),
    preview: (file) => signalApi.previewImport(file),
    run: (file) => signalApi.runImport(file),
  },
};

export default function Imports() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const mode = params.get('type') === 'signals' ? 'signals' : 'companies';
  const M = MODES[mode];

  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const history = useApi(() => importApi.list({ limit: 12 }), []);

  const reset = () => {
    setStep(0);
    setFile(null);
    setPreview(null);
    setResult(null);
    setErr(null);
  };

  const switchMode = (m) => {
    reset();
    setParams(m === 'signals' ? { type: 'signals' } : {}, { replace: true });
  };

  const doPreview = async (f) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await M.preview(f);
      setPreview(res);
      setFile(f);
      setStep(1);
    } catch (e) {
      setErr(e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await M.run(file);
      setResult(res.import);
      setStep(3);
      toast.success('Import completed');
      history.reload();
    } catch (e) {
      setErr(e.message);
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  const t = preview?.totals || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>CSV Import</h1>
          <p>Import new companies or buying signals from a CSV / lead-form export.</p>
        </div>
        {step > 0 && <button className="btn" onClick={reset}>Start over</button>}
      </div>

      <div className="flex gap-2 mb-3">
        {Object.entries(MODES).map(([key, m]) => (
          <button key={key} className={`chip ${mode === key ? 'active' : ''}`} onClick={() => switchMode(key)}>
            {m.label}
          </button>
        ))}
      </div>

      <Card className="mb-3">
        <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
          {STEPS.map((s, i) => (
            <div key={s} className={`chip ${i === step ? 'active' : ''}`} style={{ cursor: 'default' }}>
              {i + 1}. {s}
            </div>
          ))}
        </div>

        {err && <ErrorBox message={err} />}

        {step === 0 && (
          <div>
            <label className="card" style={{ display: 'block', padding: 32, textAlign: 'center', borderStyle: 'dashed', cursor: 'pointer' }}>
              <FiUploadCloud size={30} color="var(--primary)" />
              <div style={{ fontWeight: 600, marginTop: 8 }}>{busy ? 'Reading file…' : `Choose a ${M.label} CSV`}</div>
              <div className="help-text">Max 10 MB. UTF-8 encoded.</div>
              <input type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && doPreview(e.target.files[0])} />
            </label>
            <div className="mt-4">
              <div className="section-title">Recognised columns</div>
              <div className="chip-row">
                {M.columns.map((c) => <span key={c} className="badge gray">{c}</span>)}
              </div>
              <p className="help-text mt-2">
                {M.hint} A sample file is at <code>{M.sample}</code>.
              </p>
            </div>
          </div>
        )}

        {step === 1 && preview && (
          <div>
            <div className="grid stat-grid mb-3">
              {(mode === 'signals'
                ? [['Total rows', t.total_records], ['Valid', t.valid_records], ['Invalid', t.invalid_records]]
                : [
                    ['Total rows', t.total_records],
                    ['Valid', t.valid_records],
                    ['New', t.new_records],
                    ['Duplicates', t.duplicate_records],
                    ['Invalid', t.invalid_records],
                  ]
              ).map(([k, v]) => (
                <div key={k} className="card stat-card">
                  <span className="stat-label">{k}</span>
                  <div className="stat-value">{v ?? 0}</div>
                </div>
              ))}
            </div>

            {preview.unknownHeaders?.length > 0 && (
              <p className="help-text">Ignored columns: {preview.unknownHeaders.join(', ')}</p>
            )}

            <div className="section-title">Preview (first {preview.preview.length} rows)</div>
            <div className="table-wrap mb-3">
              <table className="data">
                <thead>
                  {mode === 'signals' ? (
                    <tr><th>Row</th><th>Company / contact</th><th>Wants</th><th>Source</th><th>Signal</th></tr>
                  ) : (
                    <tr><th>Row</th><th>Company</th><th>CIN</th><th>Incorporated</th><th>Industry</th><th>State</th><th>Flag</th></tr>
                  )}
                </thead>
                <tbody>
                  {preview.preview.map((r) => mode === 'signals' ? (
                    <tr key={r.row_number}>
                      <td>{r.row_number}</td>
                      <td className="cell-strong">{r.company_name}{r.contact_name ? ` · ${r.contact_name}` : ''}</td>
                      <td><span className="badge blue">{r.service}</span></td>
                      <td className="text-sm">{r.source}</td>
                      <td className="text-sm">{r.headline || '—'}</td>
                    </tr>
                  ) : (
                    <tr key={r.row_number}>
                      <td>{r.row_number}</td>
                      <td className="cell-strong">{r.company_name}</td>
                      <td className="cell-sub">{r.cin || '—'}</td>
                      <td>{r.date_of_incorporation || '—'}</td>
                      <td>{r.industry || '—'}</td>
                      <td>{r.state || '—'}</td>
                      <td>{r._duplicate ? <span className="badge warm">Duplicate</span> : <span className="badge green">New</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.errors?.length > 0 && (
              <>
                <div className="section-title">
                  <FiAlertCircle style={{ verticalAlign: '-2px' }} /> Validation errors ({preview.errors.length})
                </div>
                <div className="table-wrap mb-3">
                  <table className="data">
                    <thead><tr><th>Row</th><th>Field</th><th>Message</th></tr></thead>
                    <tbody>
                      {preview.errors.slice(0, 50).map((e, i) => (
                        <tr key={i}><td>{e.row_number}</td><td>{e.field || '—'}</td><td>{e.message}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="flex justify-between items-center">
              <span className="help-text">Lead scores are recalculated on import.</span>
              <button className="btn btn-primary" onClick={() => setStep(2)}>Continue <FiArrowRight /></button>
            </div>
          </div>
        )}

        {step === 2 && preview && (
          <EmptyState
            icon={<FiFile />}
            title={`Import ${t.valid_records} ${mode === 'signals' ? 'signals' : 'companies'} from ${file?.name}?`}
            message={
              mode === 'signals'
                ? `${t.valid_records} signals will be matched to existing companies or create new ones. ${t.invalid_records} invalid rows skipped.`
                : `${t.new_records} new, ${t.duplicate_records} duplicates updated, ${t.invalid_records} invalid rows skipped.`
            }
            action={
              <div className="flex gap-2">
                <button className="btn" onClick={() => setStep(1)}>Back</button>
                <button className="btn btn-primary" onClick={doImport} disabled={busy}>
                  {busy ? 'Importing…' : 'Confirm import'}
                </button>
              </div>
            }
          />
        )}

        {step === 3 && result && (
          <div>
            <EmptyState icon={<FiCheckCircle color="var(--success)" />} title="Import complete" message={`Import #${result.id} · ${result.original_filename}`} />
            <div className="grid stat-grid">
              {(mode === 'signals'
                ? [
                    ['Total rows', result.summary?.total_records],
                    ['Signals created', result.summary?.signals_created],
                    ['Companies matched', result.summary?.companies_matched],
                    ['Companies created', result.summary?.companies_created],
                    ['Invalid', result.summary?.invalid_records],
                  ]
                : [
                    ['Total records', result.summary?.total_records],
                    ['Imported', result.summary?.successfully_imported],
                    ['Updated', result.summary?.updated],
                    ['Duplicates', result.summary?.duplicate_records],
                    ['Invalid', result.summary?.invalid_records],
                  ]
              ).map(([k, v]) => (
                <div key={k} className="card stat-card">
                  <span className="stat-label">{k}</span>
                  <div className="stat-value">{v ?? 0}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <Link className="btn btn-primary" to={mode === 'signals' ? '/signals' : '/discovery'}>
                {mode === 'signals' ? 'View signals' : 'View companies'}
              </Link>
              <Link className="btn" to={`/imports/${result.id}`}>Import details</Link>
              {result.errors?.length > 0 && (
                <button className="btn" onClick={() => importApi.errorsCsv(result.id).catch((e) => toast.error(e.message))}>
                  Download error CSV
                </button>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="Import history" bodyClass="">
        {history.loading ? (
          <Loader />
        ) : !history.data?.items?.length ? (
          <EmptyState title="No imports yet" message="Your CSV imports will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>ID</th><th>File</th><th>Type</th><th>When</th><th>Status</th>
                  <th>Imported</th><th>Updated / matched</th><th>Invalid</th><th></th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((imp) => (
                  <tr key={imp.id}>
                    <td>#{imp.id}</td>
                    <td className="cell-strong">{imp.original_filename || '—'}</td>
                    <td><span className="badge gray">{imp.provider === 'signal-csv' ? 'Signals' : 'Companies'}</span></td>
                    <td className="nowrap text-sm">{fmtDateTime(imp.created_at)}</td>
                    <td>
                      <span className={`badge ${imp.status === 'completed' ? 'green' : imp.status === 'failed' ? 'hot' : 'gray'}`}>
                        {imp.status}
                      </span>
                    </td>
                    <td>{imp.imported_count}</td>
                    <td>{imp.updated_count}</td>
                    <td>{imp.invalid_count}</td>
                    <td><Link className="btn btn-sm" to={`/imports/${imp.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
