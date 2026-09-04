import { Link } from 'react-router-dom';
import { FiTrash2 } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { noteApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState } from '../components/ui';
import { fmtDateTime, fmtRelative } from '../utils/format';

export default function Notes() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi(() => noteApi.list({ limit: 100 }), []);

  const remove = async (id) => {
    if (!window.confirm('Delete this note?')) return;
    try {
      await noteApi.remove(id);
      toast.success('Note deleted');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Notes</h1>
          <p>All notes across companies and leads, newest first.</p>
        </div>
      </div>

      <Card bodyClass="">
        {loading ? (
          <Loader />
        ) : error ? (
          <div className="card-pad">
            <ErrorBox message={error} onRetry={reload} />
          </div>
        ) : !data?.items?.length ? (
          <EmptyState title="No notes yet" message="Add notes from a company or lead profile." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Note</th>
                  <th>Attached to</th>
                  <th>Author</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((n) => (
                  <tr key={n.id}>
                    <td style={{ maxWidth: 460 }}>{n.body}</td>
                    <td className="text-sm">
                      {n.lead_id ? (
                        <Link to={`/leads/${n.lead_id}`}>Lead · {n.company?.company_name}</Link>
                      ) : n.company_id ? (
                        <Link to={`/companies/${n.company_id}`}>{n.company?.company_name || 'Company'}</Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="text-sm">{n.user?.name || '—'}</td>
                    <td className="nowrap text-sm" title={fmtDateTime(n.created_at)}>
                      {fmtRelative(n.created_at)}
                    </td>
                    <td>
                      <button className="icon-btn" onClick={() => remove(n.id)} title="Delete">
                        <FiTrash2 />
                      </button>
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
