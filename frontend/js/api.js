import { toast } from './ui.js';

async function request(method, path, { params, body } = {}) {
  const url = params ? `${path}?${params}` : path;
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* non-JSON error */ }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path, params) => request('DELETE', path, { params }),
};

export async function guard(promise, message) {
  try {
    return await promise;
  } catch (err) {
    toast(`${message || 'Request failed'}: ${err.message}`, true);
    throw err;
  }
}

export const thumbUrl = (id, size = 256) => `/api/photos/${id}/thumb?s=${size}`;
export const previewUrl = (id) => `/api/photos/${id}/preview`;
