import axios from 'axios';

const baseURL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({ baseURL, timeout: 30000 });

const TOKEN_KEY = 'lh_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

api.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Normalize responses/errors to the { success, data, message } envelope.
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && !error.config?.url?.includes('/auth/login')) {
      tokenStore.clear();
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
    const message =
      error.response?.data?.message ||
      error.message ||
      'Something went wrong. Please try again.';
    return Promise.reject({ ...error, message, details: error.response?.data?.details });
  }
);

// Helper: unwrap `data` from the success envelope.
export const unwrap = (promise) => promise.then((r) => r.data.data);

/** Download an authenticated file endpoint as a browser file save. */
export const downloadFile = async (path, fallbackName = 'download.csv') => {
  saveBlob(await api.get(path, { responseType: 'blob' }), fallbackName);
};

/** POST a JSON body and save the file it returns. Large exports get a long timeout. */
export const downloadPost = async (path, body, fallbackName) => {
  let res;
  try {
    res = await api.post(path, body, { responseType: 'blob', timeout: 600000 });
  } catch (e) {
    // With responseType 'blob' the server's JSON error arrives as a Blob — read its message.
    const blob = e.response?.data;
    if (blob instanceof Blob) {
      try {
        e.message = JSON.parse(await blob.text()).message || e.message;
      } catch {
        /* not JSON — keep the generic message */
      }
    }
    throw e;
  }
  saveBlob(res, fallbackName);
};

function saveBlob(res, fallbackName) {
  const disposition = res.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const name = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default api;
