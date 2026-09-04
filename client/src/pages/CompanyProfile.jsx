import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  FiArrowLeft,
  FiUserPlus,
  FiFileText,
  FiClock,
  FiRefreshCw,
  FiCheck,
  FiX,
  FiExternalLink,
  FiGlobe,
  FiMail,
  FiPhone,
  FiZap,
} from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { companyApi, apolloApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, ScoreBadge, TemperatureBadge, StatusBadge, DemoBadge } from '../components/ui';
import { ConvertToLeadModal, AddNoteModal, AddFollowUpModal } from '../components/actionModals';
import {
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtRelative,
  titleCase,
  SIGNAL_SERVICE_LABELS,
  SIGNAL_SOURCE_LABELS,
} from '../utils/format';

const Row = ({ label, children }) => (
  <>
    <dt>{label}</dt>
    <dd>{children ?? '—'}</dd>
  </>
);

export default function CompanyProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [modal, setModal] = useState(null);
  const [tab, setTab] = useState('overview');
  const [enriching, setEnriching] = useState(false);
  const { data, loading, error, reload } = useApi(() => companyApi.get(id), [id]);
  const { data: apolloStatus } = useApi(() => apolloApi.status(), []);

  if (loading) return <Loader label="Loading company…" />;
  if (error)
    return (
      <div className="page">
        <ErrorBox message={error} onRetry={reload} />
      </div>
    );

  const { company, analysis, activities, notes } = data;
  const lead = company.leads?.[0];
  const signals = company.signals || [];
  const activeSignals = signals.filter((s) => ['NEW', 'REVIEWED'].includes(s.status));
  const website = company.websites?.[0];
  const emails = (company.contacts || []).filter((c) => c.type === 'email');
  const phones = (company.contacts || []).filter((c) => c.type === 'phone');

  const rescore = async () => {
    try {
      await companyApi.rescore(id);
      toast.success('Lead score recalculated');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const enrichFromApollo = async () => {
    if (!company.website) {
      toast.error('Add a website first — Apollo enrichment matches by domain.');
      return;
    }
    setEnriching(true);
    try {
      await apolloApi.enrich(id);
      toast.success('Enriched from Apollo (1 credit)');
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setEnriching(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm mb-3" onClick={() => navigate(-1)}>
            <FiArrowLeft /> Back
          </button>
          <h1>
            {company.company_name} {company.is_demo && <DemoBadge />}
          </h1>
          <p>
            {[company.industry, company.city, company.state].filter(Boolean).join(' · ')} · Incorporated{' '}
            {fmtDate(company.date_of_incorporation)}
          </p>
        </div>
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className="btn" onClick={rescore}>
            <FiRefreshCw /> Rescore
          </button>
          {apolloStatus?.configured && (
            <button className="btn" onClick={enrichFromApollo} disabled={enriching} title="Fill phone/industry/size from Apollo.io (1 credit)">
              <FiZap /> {enriching ? 'Enriching…' : 'Enrich from Apollo'}
            </button>
          )}
          <button className="btn" onClick={() => setModal({ type: 'note' })}>
            <FiFileText /> Add note
          </button>
          <button className="btn" onClick={() => setModal({ type: 'follow' })}>
            <FiClock /> Follow-up
          </button>
          {lead ? (
            <Link className="btn btn-primary" to={`/leads/${lead.id}`}>
              Open lead
            </Link>
          ) : (
            <button className="btn btn-primary" onClick={() => setModal({ type: 'convert' })}>
              <FiUserPlus /> Convert to lead
            </button>
          )}
        </div>
      </div>

      <div className="tabs">
        {['overview', 'timeline', `notes (${notes.length})`].map((t) => {
          const key = t.split(' ')[0];
          return (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {titleCase(t)}
            </button>
          );
        })}
      </div>

      {tab === 'overview' && (
        <div className="profile-grid">
          <div className="grid" style={{ gap: 16 }}>
            <Card title="Company Information">
              <dl className="def-list">
                <Row label="Company name">{company.company_name}</Row>
                <Row label="CIN">{company.cin}</Row>
                <Row label="Registration no.">{company.registration_number}</Row>
                <Row label="Date of incorporation">{fmtDate(company.date_of_incorporation)}</Row>
                <Row label="Status">{company.company_status}</Row>
                <Row label="Type">{company.company_type}</Row>
                <Row label="Category">{company.company_category}</Row>
                <Row label="Industry">{company.industry}</Row>
                <Row label="ROC">{company.roc}</Row>
                <Row label="State">{company.state}</Row>
                <Row label="City">{company.city}</Row>
                <Row label="Registered address">{company.registered_address}</Row>
                <Row label="Authorized capital">{fmtMoney(company.authorized_capital)}</Row>
                <Row label="Paid-up capital">{fmtMoney(company.paid_up_capital)}</Row>
                {company.employee_count && <Row label="Employees">{company.employee_count.toLocaleString()}</Row>}
                {company.annual_revenue && <Row label="Annual revenue">{fmtMoney(company.annual_revenue)}</Row>}
                {company.enrichment_source && (
                  <Row label="Data source">
                    <span className="badge blue">{company.enrichment_source === 'apollo' ? 'Apollo.io' : company.enrichment_source}</span>
                  </Row>
                )}
              </dl>
            </Card>

            <Card title="Online Presence">
              <dl className="def-list">
                <Row label="Website">
                  {website || company.website ? (
                    <a href={website?.url || company.website} target="_blank" rel="noreferrer">
                      {website?.url || company.website} <FiExternalLink style={{ verticalAlign: '-2px' }} />
                    </a>
                  ) : (
                    <span className="badge warm">No website found</span>
                  )}
                </Row>
                <Row label="Website status">
                  {website ? <span className="badge gray">{titleCase(website.status)}</span> : '—'}
                </Row>
                <Row label="HTTPS">
                  {website ? (website.is_https ? <span className="badge green">Secure</span> : <span className="badge warm">No HTTPS</span>) : '—'}
                </Row>
                <Row label="Website health">
                  {website ? <span className="badge gray">{titleCase(website.health)}</span> : '—'}
                </Row>
                <Row label="Business email">
                  {emails.length ? emails.map((e) => <div key={e.id}><FiMail style={{ verticalAlign: '-2px' }} /> {e.value}</div>) : <span className="badge warm">None</span>}
                </Row>
                <Row label="Phone">
                  {phones.length ? phones.map((p) => <div key={p.id}><FiPhone style={{ verticalAlign: '-2px' }} /> {p.value}</div>) : <span className="badge warm">None</span>}
                </Row>
                <Row label="Social profiles">
                  {company.linkedin_url && (
                    <a href={company.linkedin_url} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                      LinkedIn
                    </a>
                  )}
                  {company.socials?.length
                    ? company.socials.map((s) => (
                        <a key={s.id} href={s.url} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                          {titleCase(s.platform)}
                        </a>
                      ))
                    : !company.linkedin_url && <span className="badge warm">None</span>}
                </Row>
              </dl>
            </Card>
          </div>

          <div className="grid" style={{ gap: 16 }}>
            <Card title="Opportunity Analysis">
              <div className="flex items-center gap-3 mb-3">
                <div style={{ fontSize: 34, fontWeight: 700 }}>{analysis.score}</div>
                <div>
                  <TemperatureBadge value={analysis.temperature} />
                  <div className="text-sm text-muted mt-2">Opportunity: {analysis.opportunityLevel}</div>
                </div>
              </div>
              <div className="score-bar mb-3">
                <span style={{ width: `${analysis.score}%` }} />
              </div>
              <div className="section-title">Recommended service</div>
              <p style={{ marginTop: 0 }}>
                <span className="badge blue">{analysis.recommendedService}</span>
              </p>
              <div className="section-title mt-4">Reasons for score</div>
              <ul className="reason-list">
                {analysis.reasons.length ? (
                  analysis.reasons.map((r, i) => (
                    <li key={i}>
                      <FiCheck color="var(--success)" /> {r}
                    </li>
                  ))
                ) : (
                  <li className="text-muted">No positive scoring signals yet.</li>
                )}
              </ul>
              <div className="section-title mt-4">Missing online assets</div>
              <ul className="reason-list">
                {analysis.missingAssets.length ? (
                  analysis.missingAssets.map((m, i) => (
                    <li key={i}>
                      <FiX color="var(--warning)" /> {m}
                    </li>
                  ))
                ) : (
                  <li className="text-muted">None — strong digital presence.</li>
                )}
              </ul>
            </Card>

            {signals.length > 0 && (
              <Card title={`Buying Signals (${signals.length})`}>
                {activeSignals.length > 0 && (
                  <div className="badge blue mb-3" style={{ display: 'inline-flex' }}>
                    {activeSignals.length} active — boosting the lead score
                  </div>
                )}
                <div className="timeline mt-2">
                  {signals.map((s) => (
                    <div className="timeline-item" key={s.id}>
                      <div className="t-title">
                        {SIGNAL_SERVICE_LABELS[s.service] || s.service}{' '}
                        <span className={`badge ${['NEW', 'REVIEWED'].includes(s.status) ? 'blue' : 'gray'}`}>
                          {titleCase(s.status)}
                        </span>
                      </div>
                      <div className="t-meta">
                        via {SIGNAL_SOURCE_LABELS[s.source] || s.source} · {fmtRelative(s.captured_at)}
                        {s.source_url && (
                          <>
                            {' · '}
                            <a href={s.source_url} target="_blank" rel="noreferrer">source</a>
                          </>
                        )}
                      </div>
                      {(s.headline || s.detail) && <div className="t-body">{s.headline || s.detail}</div>}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <Card title="CRM Information">
              {lead ? (
                <dl className="def-list">
                  <Row label="Lead status">
                    <StatusBadge value={lead.status} />
                  </Row>
                  <Row label="Assigned user">{lead.assignedUser?.name || 'Unassigned'}</Row>
                  <Row label="Priority">{lead.priority}</Row>
                  <Row label="Estimated value">{fmtMoney(lead.estimated_value)}</Row>
                  <Row label="Next follow-up">{fmtDateTime(lead.next_follow_up_at)}</Row>
                  <Row label="Last contacted">{fmtDateTime(lead.last_contacted_at)}</Row>
                </dl>
              ) : (
                <div className="empty-state" style={{ padding: 20 }}>
                  <p>Not yet a lead.</p>
                  <button className="btn btn-primary btn-sm" onClick={() => setModal({ type: 'convert' })}>
                    <FiUserPlus /> Convert to lead
                  </button>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'timeline' && (
        <Card title="Activity Timeline">
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
            <p className="text-muted">No activity recorded yet.</p>
          )}
        </Card>
      )}

      {tab === 'notes' && (
        <Card
          title="Notes"
          actions={
            <button className="btn btn-sm btn-primary" onClick={() => setModal({ type: 'note' })}>
              Add note
            </button>
          }
        >
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
      )}

      <ConvertToLeadModal open={modal?.type === 'convert'} onClose={() => setModal(null)} company={company} onDone={() => reload()} />
      <AddNoteModal open={modal?.type === 'note'} onClose={() => setModal(null)} companyId={company.id} leadId={lead?.id} onDone={reload} />
      <AddFollowUpModal open={modal?.type === 'follow'} onClose={() => setModal(null)} companyId={company.id} leadId={lead?.id} onDone={reload} />
    </div>
  );
}
