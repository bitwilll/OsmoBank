// Verifies the zero-dependency SMTP client + mailer speak correct SMTP by running
// them against a local in-process sink. No network and no real email is sent — the
// sink stands in for any provider's relay (they all speak this same protocol).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendResetEmail, sendMail, mailerConfigured, mailConfig } from '../server/lib/mailer.js';

/** Minimal SMTP sink: plays the submission conversation and captures the message. */
function startSink() {
  const received = { messages: [], auth: null, mailFrom: null, rcptTo: [] };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    let inData = false;
    let dataLines = [];
    let expectAuth = 0; // 1 = expect username, 2 = expect password
    const send = (s) => sock.write(s + '\r\n');
    send('220 sink ESMTP ready');
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') { inData = false; received.messages.push(dataLines.join('\r\n')); dataLines = []; send('250 2.0.0 OK queued'); }
          else dataLines.push(line.startsWith('..') ? line.slice(1) : line); // undo dot-stuffing
          continue;
        }
        if (expectAuth === 1) { received.auth = { user: Buffer.from(line, 'base64').toString() }; expectAuth = 2; send('334 UGFzc3dvcmQ6'); continue; }
        if (expectAuth === 2) { received.auth.pass = Buffer.from(line, 'base64').toString(); expectAuth = 0; send('235 2.7.0 authenticated'); continue; }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) send('250-sink\r\n250 AUTH LOGIN PLAIN'); // note: no STARTTLS advertised
        else if (up === 'AUTH LOGIN') { expectAuth = 1; send('334 VXNlcm5hbWU6'); }
        else if (up.startsWith('MAIL FROM')) { received.mailFrom = line; send('250 2.1.0 OK'); }
        else if (up.startsWith('RCPT TO')) { received.rcptTo.push(line); send('250 2.1.5 OK'); }
        else if (up === 'DATA') { inData = true; send('354 end with <CRLF>.<CRLF>'); }
        else if (up === 'QUIT') { send('221 2.0.0 bye'); sock.end(); }
        else send('250 OK');
      }
    });
  });
  return { server, received };
}

test('mailer: config resolution + real SMTP delivery', async (t) => {
  const sink = startSink();
  await new Promise((res) => sink.server.listen(0, '127.0.0.1', res));
  const port = sink.server.address().port;
  t.after(() => sink.server.close());

  await t.test('unconfigured environment is a safe no-op', async () => {
    assert.equal(mailerConfigured({}), false);
    assert.equal(mailConfig({}), null);
    const r = await sendMail({ to: 'x@y.z', subject: 's', text: 't', html: '<p>t</p>' }, {});
    assert.deepEqual(r, { delivered: false, reason: 'smtp-not-configured' });
  });

  await t.test('provider presets resolve host/port/secure', () => {
    const g = mailConfig({ SMTP_SERVICE: 'gmail', SMTP_USER: 'u', SMTP_PASS: 'p' });
    assert.equal(g.host, 'smtp.gmail.com'); assert.equal(g.port, 465); assert.equal(g.secure, true);
    const o = mailConfig({ SMTP_SERVICE: 'hotmail', SMTP_USER: 'u', SMTP_PASS: 'p' });
    assert.equal(o.host, 'smtp-mail.outlook.com'); assert.equal(o.port, 587); assert.equal(o.requireTLS, true);
    const y = mailConfig({ SMTP_SERVICE: 'yahoo', SMTP_USER: 'u', SMTP_PASS: 'p' });
    assert.equal(y.host, 'smtp.mail.yahoo.com'); assert.equal(y.secure, true);
    // explicit host/port override a preset
    const custom = mailConfig({ SMTP_SERVICE: 'gmail', SMTP_HOST: 'mail.acme.test', SMTP_PORT: '2525', SMTP_SECURE: 'false' });
    assert.equal(custom.host, 'mail.acme.test'); assert.equal(custom.port, 2525); assert.equal(custom.secure, false);
  });

  await t.test('delivers a reset email to any recipient over SMTP + AUTH LOGIN', async () => {
    const env = {
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false',
      SMTP_USER: 'osmo@relay', SMTP_PASS: 's3cret-app-pw', MAIL_FROM: 'OsmoBank <no-reply@osmo.money>',
    };
    const link = 'http://localhost:8471/#/reset?token=ABC123_xyz-TOKEN';
    const r = await sendResetEmail('rosa@gmail.com', link, env);
    assert.equal(r.delivered, true);
    assert.equal(sink.received.messages.length, 1);
    const msg = sink.received.messages[0];
    assert.match(sink.received.rcptTo[0], /rosa@gmail\.com/);
    assert.match(sink.received.mailFrom, /no-reply@osmo\.money/);
    assert.deepEqual(sink.received.auth, { user: 'osmo@relay', pass: 's3cret-app-pw' });
    assert.match(msg, /^Subject: Reset your OsmoBank passphrase$/m);
    assert.match(msg, /^To: rosa@gmail\.com$/m);
    assert.match(msg, /multipart\/alternative/);
    assert.ok(msg.includes(link), 'message body carries the reset link');
  });

  await t.test('header-injection attempt in the recipient is neutralised', async () => {
    const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', MAIL_FROM: 'no-reply@osmo.money' };
    await sendMail({ to: 'evil@x.test\r\nBcc: victim@y.test', subject: 'hi', text: 'x', html: '<p>x</p>' }, env);
    const msg = sink.received.messages[sink.received.messages.length - 1];
    assert.ok(!/^Bcc:/mi.test(msg), 'no injected Bcc header survives');
  });
});
