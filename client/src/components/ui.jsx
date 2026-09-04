import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { FiX, FiInbox, FiAlertTriangle, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { TEMP_LABELS, STATUS_LABELS } from '../utils/format';

export const Loader = ({ label }) => (
  <div className="loading-center">
    <div style={{ textAlign: 'center' }}>
      <div className="spinner" style={{ margin: '0 auto' }} />
      {label && <p className="text-muted text-sm mt-2">{label}</p>}
    </div>
  </div>
);

export const ErrorBox = ({ message, onRetry }) => (
  <div className="error-box flex items-center justify-between gap-3">
    <span>
      <FiAlertTriangle style={{ verticalAlign: '-2px', marginRight: 6 }} />
      {message || 'Failed to load data.'}
    </span>
    {onRetry && (
      <button className="btn btn-sm" onClick={onRetry}>
        Retry
      </button>
    )}
  </div>
);

export const EmptyState = ({ icon, title, message, action }) => (
  <div className="empty-state">
    <div className="icon">{icon || <FiInbox />}</div>
    <h3>{title || 'Nothing here yet'}</h3>
    {message && <p>{message}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const Card = ({ title, actions, children, bodyClass = 'card-pad', className = '' }) => (
  <div className={`card ${className}`}>
    {(title || actions) && (
      <div className="card-header">
        <h3>{title}</h3>
        {actions}
      </div>
    )}
    <div className={bodyClass}>{children}</div>
  </div>
);

export const TemperatureBadge = ({ value }) => (
  <span className={`badge ${String(value || 'not_qualified').toLowerCase()}`}>
    <span className="badge-dot" />
    {TEMP_LABELS[value] || value || '—'}
  </span>
);

const STATUS_TONE = {
  NEW: 'gray',
  QUALIFIED: 'blue',
  CONTACTED: 'blue',
  REPLIED: 'blue',
  MEETING: 'warm',
  PROPOSAL: 'warm',
  NEGOTIATION: 'high',
  WON: 'green',
  LOST: 'not_qualified',
};

export const StatusBadge = ({ value }) => (
  <span className={`badge ${STATUS_TONE[value] || 'gray'}`}>{STATUS_LABELS[value] || value}</span>
);

export const ScoreBadge = ({ value }) => {
  const v = Number(value) || 0;
  const tone = v >= 90 ? 'hot' : v >= 75 ? 'high' : v >= 50 ? 'warm' : v >= 30 ? 'low' : 'not_qualified';
  return <span className={`badge ${tone} score-pill`}>{v}</span>;
};

export const Modal = ({ open, onClose, title, children, footer, size }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <motion.div
        className={`modal ${size === 'lg' ? 'lg' : ''}`}
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.16 }}
      >
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <FiX />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </motion.div>
    </div>,
    document.body
  );
};

export const Pagination = ({ pagination, onChange }) => {
  if (!pagination) return null;
  const { page, totalPages, total, limit } = pagination;
  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  return (
    <div className="pagination">
      <span>
        Showing <strong>{start}</strong>–<strong>{end}</strong> of <strong>{total}</strong>
      </span>
      <div className="pages">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <FiChevronLeft />
        </button>
        <span className="btn btn-sm" style={{ pointerEvents: 'none' }}>
          {page} / {totalPages}
        </span>
        <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          <FiChevronRight />
        </button>
      </div>
    </div>
  );
};

export const DemoBadge = () => <span className="badge demo">DEMO</span>;
