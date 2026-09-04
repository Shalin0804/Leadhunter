import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { FiArrowLeft, FiFileText, FiClock, FiUser, FiExternalLink } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { leadApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, ScoreBadge, TemperatureBadge, StatusBadge } from '../components/ui';
import { AddNoteModal, AddFollowUpModal, AssignModal } from '../components/actionModals';
import { fmtDate, fmtDateTime, fmtMoney, fmtRelative, titleCase, STATUS_LABELS } from '../utils/format';

const STATUSES = Object.keys(STATUS_LABELS);
const Row = ({ label, children }) => (
  <>
    <dt>{label}</dt>
    <dd>{children ?? '—'}</dd>
  </>
);

export default function LeadProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [modal, setModal] = useState(null);
  const { data, loading, error, reload } = useApi(() => leadApi.get(id), [id]);

  if (loading) return <Loader label="Loading lead…" />;
  if (error)
    return (
      <div className="page">
        <ErrorBox message={error} onRetry={reload} />
      </div>
    );

  const { lead, activities, tasks, notes } = data;

  const setStatus = async (status) => {
    try {
      await leadApi.updateStatus(id, status);
      toast.success(`Moved to ${STATUS_LABELS[status]}`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const setField = async (patch) => {
    try {
      await leadApi.update(id, patch);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm mb-3" onClick={() => navigate(-1)}>
            <FiArrowLeft /> Back
          </button>
          <h1>{lead.company?.company_name}</h1>
          <p>
            <Link to={`/companies/${lead.company_id}`}>
              View company profile <FiExternalLink style={{ verticalAlign: '-2px' }} />
            </Link>
          </p>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => setModal({ type: 'assign' })}>
            <FiUser /> Assign
          </button>
          <button className="btn" onClick={() => setModal({ type: 'note' })}>
            <FiFileText /> Note
          </button>
          <button className="btn" onClick={() => setModal({ type: 'follow' })}>
            <FiClock /> Follow-up
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
        {STATUSES.map((s) => (
          <button
            key={s}
            className={`chip ${lead.status === s ? 'active' : ''}`}
            onClick={() => setStatus(s)}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="profile-grid">
        <div className="grid" style={{ gap: 16 }}>
          <Card title="Lead details">
            <dl className="def-list">
              <Row label="Score">
                <ScoreBadge value={lead.lead_score} />
              </Row>
              <Row label="Temperature">
                <TemperatureBadge value={lead.lead_temperature} />
              </Row>
              <Row label="Status">
                <StatusBadge value={lead.status} />
              </Row>
              <Row label="Recommended service">{lead.recommended_service}</Row>
              <Row label="Priority">
                <select className="select" style={{ maxWidth: 160 }} value={lead.priority} onChange={(e) => setField({ priority: e.target.value })}>
                  <option>LOW</option>
                  <option>MEDIUM</option>
                  <option>HIGH</option>
                </select>
              </Row>
              <Row label="Estimated value">
                <input
                  className="input"
                  style={{ maxWidth: 180 }}
                  type="number"
                  defaultValue={lead.estimated_value || ''}
                  onBlur={(e) => setField({ estimated_value: e.target.value })}
                />
              </Row>
              <Row label="Next follow-up">
                <input
                  className="input"
                  style={{ maxWidth: 220 }}
                  type="datetime-local"
                  defaultValue={lead.next_follow_up_at ? new Date(lead.next_follow_up_at).toISOString().slice(0, 16) : ''}
                  onBlur={(e) => setField({ next_follow_up_at: e.target.value })}
                />
              </Row>
              <Row label="Assigned user">{lead.assignedUser?.name || 'Unassigned'}</Row>
              <Row label="Last contacted">{fmtDateTime(lead.last_contacted_at)}</Row>
              <Row label="Created">{fmtDate(lead.created_at)}</Row>
              {lead.lost_reason && <Row label="Lost reason">{lead.lost_reason}</Row>}
            </dl>
          </Card>

          <Card title="Activity timeline">
            {activities.length ? (
              <div className="timeline mt-2">
                {activities.map((a) => (
                  <div className="timeline-item" key={a.id}>
                    <div className="t-title">{a.title}</div>
                    <div className="t-meta">
                      {titleCase(a.type)} · {a.user?.name || 'System'} · {fmtRelative(a.occurred_at)}
                    </div>
                    {a.body && <div className="t-body">{a.body}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted">No activity yet.</p>
            )}
          </Card>
        </div>

        <div className="grid" style={{ gap: 16 }}>
          <Card title={`Tasks & follow-ups (${tasks.length})`}>
            {tasks.length ? (
              tasks.map((t) => (
                <div key={t.id} className="flex justify-between items-center" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div className="cell-strong">{t.title}</div>
                    <div className="cell-sub">
                      {t.due_date ? `Due ${fmtDateTime(t.due_date)}` : 'No due date'} · {t.priority}
                    </div>
                  </div>
                  <span className={`badge ${t.status === 'COMPLETED' ? 'green' : t.status === 'CANCELLED' ? 'gray' : 'blue'}`}>
                    {titleCase(t.status)}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-muted">No tasks yet.</p>
            )}
          </Card>

          <Card title={`Notes (${notes.length})`} actions={<button className="btn btn-sm" onClick={() => setModal({ type: 'note' })}>Add</button>}>
            {notes.length ? (
              <div className="timeline mt-2">
                {notes.map((n) => (
                  <div className="timeline-item" key={n.id}>
                    <div className="t-body" style={{ color: 'var(--text)' }}>
                      {n.body}
                    </div>
                    <div className="t-meta">
                      {n.user?.name || 'Unknown'} · {fmtRelative(n.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted">No notes yet.</p>
            )}
          </Card>

          <Card title="Status history">
            {lead.statusHistory?.length ? (
              <div className="timeline mt-2">
                {lead.statusHistory.map((h) => (
                  <div className="timeline-item" key={h.id}>
                    <div className="t-title">
                      {h.from_status ? `${h.from_status} → ` : ''}
                      {h.to_status}
                    </div>
                    <div className="t-meta">
                      {h.changedBy?.name || 'System'} · {fmtRelative(h.created_at)}
                    </div>
                    {h.note && <div className="t-body">{h.note}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted">No status changes yet.</p>
            )}
          </Card>
        </div>
      </div>

      <AddNoteModal open={modal?.type === 'note'} onClose={() => setModal(null)} leadId={lead.id} companyId={lead.company_id} onDone={reload} />
      <AddFollowUpModal open={modal?.type === 'follow'} onClose={() => setModal(null)} leadId={lead.id} companyId={lead.company_id} onDone={reload} />
      <AssignModal open={modal?.type === 'assign'} onClose={() => setModal(null)} lead={lead} onDone={reload} />
    </div>
  );
}
