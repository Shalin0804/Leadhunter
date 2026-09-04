import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { pipelineApi, leadApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Loader, ErrorBox, ScoreBadge } from '../components/ui';
import { fmtMoney, STATUS_LABELS } from '../utils/format';

export default function Pipeline() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi(() => pipelineApi.board(), []);
  const [dragId, setDragId] = useState(null);
  const [overStage, setOverStage] = useState(null);

  if (loading) return <Loader label="Loading pipeline…" />;
  if (error)
    return (
      <div className="page">
        <ErrorBox message={error} onRetry={reload} />
      </div>
    );

  const move = async (leadId, toStage) => {
    const cols = data.columns.map((c) => ({ ...c, leads: [...c.leads] }));
    let moved;
    for (const c of cols) {
      const idx = c.leads.findIndex((l) => l.id === leadId);
      if (idx >= 0) {
        [moved] = c.leads.splice(idx, 1);
        c.count = c.leads.length;
      }
    }
    if (!moved || moved.status === toStage) return;
    moved.status = toStage;
    const target = cols.find((c) => c.stage === toStage);
    target.leads.unshift(moved);
    target.count = target.leads.length;
    setData({ ...data, columns: cols });

    try {
      await leadApi.updateStatus(leadId, toStage);
      toast.success(`Moved to ${STATUS_LABELS[toStage]}`);
      reload();
    } catch (e) {
      toast.error(e.message);
      reload();
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Pipeline</h1>
          <p>Drag leads between stages. Every change is saved to status history.</p>
        </div>
      </div>

      <div className="pipeline-board">
        {data.columns.map((col) => (
          <div
            key={col.stage}
            className={`pipeline-col ${overStage === col.stage ? 'drop-target' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStage(col.stage);
            }}
            onDragLeave={() => setOverStage((s) => (s === col.stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault();
              setOverStage(null);
              if (dragId) move(dragId, col.stage);
            }}
          >
            <div className="pipeline-col-head">
              <strong>{STATUS_LABELS[col.stage]}</strong>
              <span className="badge gray">{col.count}</span>
            </div>
            <div className="pipeline-col-body">
              {col.value > 0 && <div className="cell-sub">Pipeline value: {fmtMoney(col.value)}</div>}
              {col.leads.map((l) => (
                <div
                  key={l.id}
                  className="pipeline-card"
                  draggable
                  onDragStart={() => setDragId(l.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => navigate(`/leads/${l.id}`)}
                >
                  <div className="flex justify-between items-center">
                    <strong className="text-sm">{l.company?.company_name}</strong>
                    <ScoreBadge value={l.lead_score} />
                  </div>
                  <div className="cell-sub mt-2">
                    {[l.company?.industry, l.company?.city].filter(Boolean).join(' · ') || '—'}
                  </div>
                  <div className="cell-sub">
                    {l.assignedUser?.name || 'Unassigned'} · {fmtMoney(l.estimated_value)}
                  </div>
                </div>
              ))}
              {!col.leads.length && <div className="cell-sub" style={{ padding: 8 }}>Drop leads here</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
