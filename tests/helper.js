// Shared test harness: boots the real server on a random port with a temp DB,
// gives each test file an isolated cookie-jar fetch client.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function bootServer(envOverrides = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dbPath = envOverrides.OSMO_DB || join(mkdtempSync(join(tmpdir(), 'osmo-')), 'test.db');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), OSMO_DB: dbPath, OSMO_SEED_DEMO: '1',
      OSMO_ADMIN_PASS: 'admin-test-pass-123', OSMO_MANAGER_PASS: 'manager-test-pass-123',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.status === 401) break; // server is up
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    child,
    dbPath,
    logs: () => logs,
    stop: () => child.kill('SIGKILL'),
  };
}

/** Cookie-jar fetch client bound to a server base URL. */
export function client(base) {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON (e.g. CSV) */ }
    return { status: res.status, json, res };
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    patch: (p, b = {}) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
    cookieValue: () => cookie,
  };
}

let seq = 0;
export async function registerMember(base, overrides = {}) {
  const c = client(base);
  const n = ++seq + Math.floor(Math.random() * 100000);
  const r = await c.post('/api/auth/register', {
    name: `Test User ${n}`,
    handle: `tester${n}`,
    email: `tester${n}@example.com`,
    passphrase: 'correct-horse-battery',
    disclaimerAccepted: true,
    ...overrides,
  });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`);
  // Accounts now start empty (no demo "founding balance"). Tests assume a
  // starting balance, so fund it via the real Add-Funds deposit endpoint —
  // this reproduces the former seed (12450 USDC + 10 OSM) and exercises deposits.
  // Pass overrides.fund = false to keep the account at a true zero balance.
  if (overrides.fund !== false) {
    await c.post('/api/deposits', { currency: 'USDC', amount: 12450 });
    await c.post('/api/deposits', { currency: 'OSM', amount: 10 });
  }
  return { c, user: r.json.user };
}

export async function loginAdmin(base) {
  const c = client(base);
  const r = await c.post('/api/auth/login', { identifier: 'admin@osmo.money', passphrase: 'admin-test-pass-123' });
  if (r.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(r.json)}`);
  return { c, user: r.json.user };
}

export async function loginManager(base) {
  const c = client(base);
  const r = await c.post('/api/auth/login', { identifier: 'marisol@osmo.money', passphrase: 'manager-test-pass-123' });
  if (r.status !== 200) throw new Error(`manager login failed: ${JSON.stringify(r.json)}`);
  return { c, user: r.json.user };
}
