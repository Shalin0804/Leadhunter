import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUploadCloud, FiCheckCircle, FiAlertCircle, FiArrowRight, FiFile } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { importApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState } from '../components/ui';
import { fmtDateTime } from '../utils/format';

const REQUIRED_COLUMNS = [
  'company_name', 'cin', 'registration_number', 'date_of_incorporation', 'company_status',
  'company_type', 'company_category', 'industry', 'roc', 'state', 'city',
  'registered_address', 'authorized_capital', 'paid_up_capital', 'website', 'email', 'phone',
];

const STEPS = ['Upload', 'Preview & validate', 'Confirm', 'Summary'];

export default function Imports() {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [err, setErr] = useState(null);

  const history = useApi(() => importApi.list({ limit: 10 }), []);

  const reset = () => {
    setStep(0);
    setFile(null);
    setPreview(null);
    setResult(null);
    setErr(null);
  };

  const doPreview = async (f) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await importApi.preview(f);
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
      const res = await importApi.run(file, updateExisting);
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

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>CSV Import</h1>
          <p>Bring in new companies from a licensed dataset or your own CSV export.</p>
        </div>
        {step > 0 && (
          <button className="btn" onClick={reset}>
            Start over
          </button>
        )}
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
            <label
              className="card"
              style={{ display: 'block', padding: 32, textAlign: 'center', borderStyle: 'dashed', cursor: 'pointer' }}
            >
              <FiUploadCloud size={30} color="var(--primary)" />
              <div style={{ fontWeight: 600, marginTop: 8 }}>{busy ? 'Reading file…' : 'Choose a CSV file'}</div>
              <div className="help-text">Max 10 MB. UTF-8 encoded.</div>
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(e) => e.target.files?.[0] && doPreview(e.target.files[0])}
              />
            </label>
            <div className="mt-4">
              <div className="section-title">Expected columns</div>
              <div className="chip-row">
                {REQUIRED_COLUMNS.map((c) => (
                  <span key={c} className="badge gray">
                    {c}
                  </span>
                ))}
              </div>
              <p className="help-text mt-2">
                Only <strong>company_name</strong> is required. Common header aliases (e.g. <em>registration_date</em>,
                <em> sector</em>) are detected automatically. A sample file is at{' '}
                <code>server/seed/sample-companies.csv</code>.
              </p>
            </div>
          </div>
        )}

        {step === 1 && preview && (
          <div>
            <div className="grid stat-grid mb-3">
              {[
                ['Total rows', preview.totals.total_records],
                ['Valid', preview.totals.valid_records],
                ['New', preview.totals.new_records],
                ['Duplicates', preview.totals.duplicate_records],
                ['Invalid', preview.totals.invalid_records],
              ].map(([k, v]) => (
                <div key={k} className="card stat-card">
                  <span className="stat-label">{k}</span>
                  <div className="stat-value">{v}</div>
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
                  <tr>
                    <th>Row</th>
                    <th>Company</th>
                    <th>CIN</th>
                    <th>Incorporated</th>
                    <th>Industry</th>
                    <th>State</th>
                    <th>City</th>
                    <th>Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((r) => (
                    <tr key={r.row_number}>
                      <td>{r.row_number}</td>
                      <td className="cell-strong">{r.company_name}</td>
                      <td className="cell-sub">{r.cin || '—'}</td>
                      <td>{r.date_of_incorporation || '—'}</td>
                      <td>{r.industry || '—'}</td>
                      <td>{r.state || '—'}</td>
                      <td>{r.city || '—'}</td>
                      <td>
                        {r._duplicate ? (
                          <span className="badge warm">Duplicate</span>
                        ) : (
                          <span className="badge green">New</span>
                        )}
                      </td>
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
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>Field</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.errors.slice(0, 50).map((e, i) => (
                        <tr key={i}>
                          <td>{e.row_number}</td>
                          <td>{e.field || '—'}</td>
                          <td>{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div className="flex justify-between items-center">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
                Update existing companies on duplicate match
              </label>
              <button className="btn btn-primary" onClick={() => setStep(2)}>
                Continue <FiArrowRight />
              </button>
            </div>
          </div>
        )}

        {step === 2 && preview && (
          <div>
            <EmptyState
              icon={<FiFile />}
              title={`Import ${preview.totals.valid_records} companies from ${file?.name}?`}
              message={`${preview.totals.new_records} new, ${preview.totals.duplicate_records} duplicates ${
                updateExisting ? 'will be updated' : 'will be skipped'
              }, ${preview.totals.invalid_records} invalid rows skipped. Lead scores are calculated on import.`}
              action={
                <div className="flex gap-2">
                  <button className="btn" onClick={() => setStep(1)}>
                    Back
                  </button>
                  <button className="btn btn-primary" onClick={doImport} disabled={busy}>
                    {busy ? 'Importing…' : 'Confirm import'}
                  </button>
                </div>
              }
            />
          </div>
        )}

        {step === 3 && result && (
          <div>
            <EmptyState
              icon={<FiCheckCircle color="var(--success)" />}
              title="Import complete"
              message={`Import #${result.id} · ${result.original_filename}`}
            />
            <div className="grid stat-grid">
              {[
                ['Total records', result.summary?.total_records],
                ['Imported', result.summary?.successfully_imported],
                ['Updated', result.summary?.updated],
                ['Duplicates', result.summary?.duplicate_records],
                ['Invalid', result.summary?.invalid_records],
              ].map(([k, v]) => (
                <div key={k} className="card stat-card">
                  <span className="stat-label">{k}</span>
                  <div className="stat-value">{v ?? 0}</div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-4">
              <Link className="btn btn-primary" to="/discovery">
                View companies
              </Link>
              <Link className="btn" to={`/imports/${result.id}`}>
                Import details
              </Link>
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
                  <th>ID</th>
                  <th>File</th>
                  <th>When</th>
                  <th>Status</th>
                  <th>Imported</th>
                  <th>Updated</th>
                  <th>Duplicates</th>
                  <th>Invalid</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((imp) => (
                  <tr key={imp.id}>
                    <td>#{imp.id}</td>
                    <td className="cell-strong">{imp.original_filename || '—'}</td>
                    <td className="nowrap text-sm">{fmtDateTime(imp.created_at)}</td>
                    <td>
                      <span className={`badge ${imp.status === 'completed' ? 'green' : imp.status === 'failed' ? 'hot' : 'gray'}`}>
                        {imp.status}
                      </span>
                    </td>
                    <td>{imp.imported_count}</td>
                    <td>{imp.updated_count}</td>
                    <td>{imp.duplicate_count}</td>
                    <td>{imp.invalid_count}</td>
                    <td>
                      <Link className="btn btn-sm" to={`/imports/${imp.id}`}>
                        View
                      </Link>
                    </td>
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
