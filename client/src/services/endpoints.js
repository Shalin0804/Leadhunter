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
