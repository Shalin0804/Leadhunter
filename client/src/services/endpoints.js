import api, { unwrap, downloadFile } from './api';

const qs = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

export { downloadFile };

export const authApi = {
  login: (email, password) => unwrap(api.post('/auth/login', { email, password })),
  me: () => unwrap(api.get('/auth/me')),
  logout: () => api.post('/auth/logout').catch(() => {}),
};

export const dashboardApi = {
  stats: () => unwrap(api.get('/dashboard/stats')),
  opportunities: (limit = 10) => unwrap(api.get(`/dashboard/opportunities${qs({ limit })}`)),
  activity: () => unwrap(api.get('/dashboard/activity')),
  automationStatus: () => unwrap(api.get('/dashboard/automation-status')),
};

export const companyApi = {
  discovery: (params) => unwrap(api.get(`/discovery/companies${qs(params)}`)),
  discoveryStats: (params) => unwrap(api.get(`/discovery/stats${qs(params)}`)),
  list: (params) => unwrap(api.get(`/companies${qs(params)}`)),
  get: (id) => unwrap(api.get(`/companies/${id}`)),
  create: (body) => unwrap(api.post('/companies', body)),
  update: (id, body) => unwrap(api.put(`/companies/${id}`, body)),
  remove: (id) => unwrap(api.delete(`/companies/${id}`)),
  rescore: (id) => unwrap(api.post(`/companies/${id}/rescore`)),
  enrichContact: (id) => unwrap(api.post(`/companies/${id}/enrich`)),
  addContact: (id, body) => unwrap(api.post(`/companies/${id}/contacts`, body)),
  addSocial: (id, body) => unwrap(api.post(`/companies/${id}/socials`, body)),
  exportCsv: (params) => downloadFile(`/companies/export${qs(params)}`, 'companies.csv'),
};

export const leadApi = {
  list: (params) => unwrap(api.get(`/leads${qs(params)}`)),
  get: (id) => unwrap(api.get(`/leads/${id}`)),
  createFromCompany: (body) => unwrap(api.post('/leads', body)),
  update: (id, body) => unwrap(api.put(`/leads/${id}`, body)),
  updateStatus: (id, status, note) => unwrap(api.patch(`/leads/${id}/status`, { status, note })),
  contact: (id, body) => unwrap(api.patch(`/leads/${id}/contact`, body)),
  updateContactStatus: (id, body) => unwrap(api.patch(`/leads/${id}/contact-status`, body)),
  updateLeadStatus: (id, body) => unwrap(api.patch(`/leads/${id}/lead-status`, body)),
  recontact: (id, body) => unwrap(api.post(`/leads/${id}/recontact`, body)),
  remove: (id) => unwrap(api.delete(`/leads/${id}`)),
  exportCsv: (params) => downloadFile(`/leads/export${qs(params)}`, 'leads.csv'),
};

export const pipelineApi = {
  board: (params) => unwrap(api.get(`/pipeline${qs(params)}`)),
};

export const taskApi = {
  list: (params) => unwrap(api.get(`/tasks${qs(params)}`)),
  create: (body) => unwrap(api.post('/tasks', body)),
  update: (id, body) => unwrap(api.put(`/tasks/${id}`, body)),
  remove: (id) => unwrap(api.delete(`/tasks/${id}`)),
};

export const noteApi = {
  list: (params) => unwrap(api.get(`/notes${qs(params)}`)),
  create: (body) => unwrap(api.post('/notes', body)),
  remove: (id) => unwrap(api.delete(`/notes/${id}`)),
};

export const importApi = {
  providers: () => unwrap(api.get('/imports/providers')),
  list: (params) => unwrap(api.get(`/imports${qs(params)}`)),
  get: (id) => unwrap(api.get(`/imports/${id}`)),
  preview: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return unwrap(api.post('/imports/companies/preview', fd));
  },
  run: (file, updateExisting = true) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('update_existing', String(updateExisting));
    return unwrap(api.post('/imports/companies', fd));
  },
  errorsCsv: (id) => downloadFile(`/imports/${id}/errors.csv`, `import-${id}-errors.csv`),
};

export const userApi = {
  list: () => unwrap(api.get('/users')),
};

export const automationApi = {
  getSettings: () => unwrap(api.get('/automation/settings')),
  updateSettings: (body) => unwrap(api.put('/automation/settings', body)),
  runNow: (body) => unwrap(api.post('/automation/run-now', body || {})),
  listRuns: (params) => unwrap(api.get(`/automation/runs${qs(params)}`)),
  getRun: (id) => unwrap(api.get(`/automation/runs/${id}`)),
  apiUsage: () => unwrap(api.get('/automation/api-usage')),
  status: () => unwrap(api.get('/automation/status')),
};

export const outreachApi = {
  list: (params) => unwrap(api.get(`/outreach${qs(params)}`)),
  generate: (body) => unwrap(api.post('/outreach/generate', body)),
  remove: (id) => unwrap(api.delete(`/outreach/${id}`)),
};

export const apolloApi = {
  status: () => unwrap(api.get('/apollo/status')),
  search: (body) => unwrap(api.post('/apollo/search', body)),
  import: (items) => unwrap(api.post('/apollo/import', { items })),
  enrich: (companyId) => unwrap(api.post(`/apollo/companies/${companyId}/enrich`)),
};

export const signalApi = {
  list: (params) => unwrap(api.get(`/signals${qs(params)}`)),
  meta: () => unwrap(api.get('/signals/meta')),
  stats: () => unwrap(api.get('/signals/stats')),
  get: (id) => unwrap(api.get(`/signals/${id}`)),
  create: (body) => unwrap(api.post('/signals', body)),
  update: (id, body) => unwrap(api.patch(`/signals/${id}`, body)),
  convert: (id, body) => unwrap(api.post(`/signals/${id}/convert`, body)),
  remove: (id) => unwrap(api.delete(`/signals/${id}`)),
  exportCsv: (params) => downloadFile(`/signals/export${qs(params)}`, 'signals.csv'),
  previewImport: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return unwrap(api.post('/imports/signals/preview', fd));
  },
  runImport: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return unwrap(api.post('/imports/signals', fd));
  },
};
