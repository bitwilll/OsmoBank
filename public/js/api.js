/* Thin JSON API client. Throws ApiClientError with the server's message. */
export class ApiClientError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiClientError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  patch: (p, b = {}) => call('PATCH', p, b),
  del: (p) => call('DELETE', p),
};

export const fmt = {
  usd: (n, dp = 0) => '$' + Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }),
  usd2: (n) => fmt.usd(n, 2),
  num: (n) => Number(n ?? 0).toLocaleString('en-US'),
  pct: (n, dp = 1) => `${Number(n ?? 0).toFixed(dp)}%`,
  signedUsd: (n) => (n >= 0 ? '+' : '−') + fmt.usd(Math.abs(n)),
  date: (iso) => {
    if (!iso) return '—';
    const d = new Date(iso.includes('T') || iso.includes('Z') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  },
  monthYear: (iso) => new Date(iso.replace(' ', 'T') + 'Z')
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  ago: (iso) => {
    const then = new Date(iso.replace(' ', 'T') + 'Z').getTime();
    const h = Math.max(0, Math.floor((Date.now() - then) / 3600000));
    if (h < 1) return 'JUST NOW';
    if (h < 24) return `${h}H AGO`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d}D AGO` : `${Math.floor(d / 30)}MO AGO`;
  },
};
