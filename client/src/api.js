// ============================================================================
// api.js — thin fetch wrapper. All requests send credentials (the auth cookie)
// and parse JSON, throwing on non-2xx so callers can try/catch.
// ============================================================================
const BASE = '/api';

async function request(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p) => request('DELETE', p),
};

// ---- money helper (mirrors server/src/lib/money.js formatMinor) -----------
export function formatMinor(minor, currency = 'INR') {
  const symbol = { INR: '₹', USD: '$' }[currency] ?? '';
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100).toLocaleString('en-IN');
  const cents = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol}${major}.${cents}`;
}

// Accounting notation: negatives are wrapped in parentheses, the way a ledger
// shows money owed — e.g. (₹2,490.00). Positives are shown plain.
export function formatAccounting(minor, currency = 'INR') {
  const plain = formatMinor(Math.abs(minor), currency);
  return minor < 0 ? `(${plain})` : plain;
}
