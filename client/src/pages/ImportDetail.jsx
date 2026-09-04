import { useParams, useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiDownload } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { importApi } from '../services/endpoints';
import { Card, Loader, ErrorBox, EmptyState } from '../components/ui';
import { fmtDateTime } from '../utils/format';

export default function ImportDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => importApi.get(id), [id]);

  if (loading) return <Loader />;
  if (error)
    return (
      <div className="page">
        <ErrorBox message={error} onRetry={reload} />
      </div>
    );

  const imp = data.import;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm mb-3" onClick={() => navigate('/imports')}>
            <FiArrowLeft /> Imports
          </button>
          <h1>Import #{imp.id}</h1>
          <p>
            {imp.original_filename} · {fmtDateTime(imp.created_at)} · by {imp.user?.name || 'Unknown'}
          </p>
        </div>
        {imp.errors?.length > 0 && (
          <button className="btn" onClick={() => importApi.errorsCsv(imp.id)}>
            <FiDownload /> Error CSV
          </button>
        )}
      </div>

      <div className="grid stat-grid mb-3">
        {[
          ['Total', imp.total_records],
          ['Imported', imp.imported_count],
          ['Updated', imp.updated_count],
          ['Duplicates', imp.duplicate_count],
          ['Invalid', imp.invalid_count],
        ].map(([k, v]) => (
          <div key={k} className="card stat-card">
            <span className="stat-label">{k}</span>
            <div className="stat-value">{v}</div>
          </div>
        ))}
      </div>

      <Card title={`Errors (${imp.errors?.length || 0})`} bodyClass="">
        {imp.errors?.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Field</th>
                  <th>Message</th>
                  <th>Company</th>
                </tr>
              </thead>
              <tbody>
                {imp.errors.map((e) => (
                  <tr key={e.id}>
                    <td>{e.row_number ?? '—'}</td>
                    <td>{e.field || '—'}</td>
                    <td>{e.message}</td>
                    <td className="cell-sub">{e.raw_row?.company_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No errors" message="Every row in this import was processed successfully." />
        )}
      </Card>
    </div>
  );
}
