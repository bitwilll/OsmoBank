/* Minimal, zero-dependency SMTP submission client (RFC 5321).
 * Supports the three relay styles every major provider offers:
 *   - implicit TLS   (secure:true, e.g. Gmail/Yahoo :465)
 *   - STARTTLS       (requireTLS:true, e.g. Outlook/Office365/SES/SendGrid :587)
 *   - plaintext      (internal relays / tests)
 * plus AUTH LOGIN. It submits one message per connection — enough for
 * transactional mail (password resets). Kept dependency-free on purpose: this is
 * a security-sensitive path in an app that vendors its own crypto. */
import net from 'node:net';
import tls from 'node:tls';

function waitEvent(sock, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`SMTP timeout waiting for ${event}`)); }, timeoutMs);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(e); };
    function cleanup() { clearTimeout(timer); sock.off(event, onOk); sock.off('error', onErr); }
    sock.once(event, onOk);
    sock.once('error', onErr);
  });
}

/** Wrap a socket in a request/reply SMTP reader (handles multiline replies). */
function conversation(sock, timeoutMs) {
  let buffer = '';
  let waiter = null;
  sock.setEncoding('utf8');
  const deliverError = (e) => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } };
  sock.on('error', deliverError);
  sock.on('close', () => deliverError(new Error('SMTP connection closed')));

  function tryResolve() {
    if (!waiter) return;
    const lines = buffer.split('\r\n');
    for (let i = 0; i < lines.length; i++) {
      // A reply is complete at the first line of form "DDD " (space after code).
      if (/^\d{3} /.test(lines[i])) {
        const replyLines = lines.slice(0, i + 1);
        buffer = lines.slice(i + 1).join('\r\n');
        const code = parseInt(replyLines[i].slice(0, 3), 10);
        const text = replyLines.map((l) => l.slice(4)).join('\n');
        const w = waiter; waiter = null;
        w.resolve({ code, text });
        return;
      }
    }
  }
  sock.on('data', () => { /* buffer updated below */ });
  sock.on('data', (chunk) => { buffer += chunk; tryResolve(); });

  return {
    read() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        const timer = setTimeout(() => deliverError(new Error('SMTP read timeout')), timeoutMs);
        const wrap = waiter;
        const clear = () => clearTimeout(timer);
        wrap.resolve = ((orig) => (v) => { clear(); orig(v); })(resolve);
        wrap.reject = ((orig) => (e) => { clear(); orig(e); })(reject);
        tryResolve();
      });
    },
    write(s) { sock.write(s); },
  };
}

async function cmd(conn, line, okCodes) {
  if (line != null) conn.write(line + '\r\n');
  const r = await conn.read();
  if (okCodes && !okCodes.includes(r.code)) {
    const label = line ? line.split(' ')[0] : 'greeting';
    throw new Error(`SMTP ${label} rejected: ${r.code} ${r.text.replace(/\s+/g, ' ').trim()}`);
  }
  return r;
}

/**
 * Submit a single already-serialised RFC 5322 message.
 * @param {object} o host, port, secure, requireTLS, auth:{user,pass}, from, to, raw, timeoutMs, tlsOptions
 */
export async function sendSmtp(o) {
  const { host, port, secure = false, requireTLS = false, auth = null, from, to, raw,
    timeoutMs = 20000, tlsOptions = {} } = o;
  const ehloName = 'osmobank.local';

  let sock = secure
    ? tls.connect({ host, port, servername: host, ...tlsOptions })
    : net.connect({ host, port });
  await waitEvent(sock, secure ? 'secureConnect' : 'connect', timeoutMs);

  let conn = conversation(sock, timeoutMs);
  try {
    await cmd(conn, null, [220]);                 // server greeting
    let ehlo = await cmd(conn, `EHLO ${ehloName}`, [250]);

    if (!secure && (requireTLS || /STARTTLS/i.test(ehlo.text))) {
      if (!/STARTTLS/i.test(ehlo.text) && requireTLS) throw new Error('SMTP server does not offer STARTTLS but TLS is required');
      await cmd(conn, 'STARTTLS', [220]);
      sock = tls.connect({ socket: sock, host, servername: host, ...tlsOptions });
      await waitEvent(sock, 'secureConnect', timeoutMs);
      conn = conversation(sock, timeoutMs);
      ehlo = await cmd(conn, `EHLO ${ehloName}`, [250]);  // re-EHLO over TLS
    }

    if (auth) {
      await cmd(conn, 'AUTH LOGIN', [334]);
      await cmd(conn, Buffer.from(String(auth.user)).toString('base64'), [334]);
      await cmd(conn, Buffer.from(String(auth.pass)).toString('base64'), [235]);
    }

    await cmd(conn, `MAIL FROM:<${from}>`, [250]);
    await cmd(conn, `RCPT TO:<${to}>`, [250, 251]);
    await cmd(conn, 'DATA', [354]);
    // CRLF line endings + dot-stuffing (a line starting with '.' is escaped).
    const body = String(raw).replace(/\r?\n/g, '\r\n').replace(/\r\n\./g, '\r\n..');
    conn.write(body + '\r\n.\r\n');
    await cmd(conn, null, [250]);                  // message accepted
    try { await cmd(conn, 'QUIT', [221]); } catch { /* server may just close */ }
    return true;
  } finally {
    try { sock.end(); } catch { /* already closed */ }
  }
}
