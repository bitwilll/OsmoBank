// Pure unit tests for the dependency-free libraries: RFC 6238 TOTP, the
// validation / password / cookie / rate-limit / lockout helpers, and the PDF
// writer. These import the modules directly (no server, no DB queries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';
import * as totp from '../server/lib/totp.js';
import * as util from '../server/lib/util.js';
import { Pdf } from '../server/lib/pdf.js';

test('totp (RFC 6238)', async (t) => {
  await t.test('base32 round-trips arbitrary bytes', () => {
    for (const s of ['', 'A', 'hello world', 'osmo-bank-secret']) {
      const buf = Buffer.from(s);
      assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
    }
  });

  await t.test('generateSecret is a 32-char base32 string (160 bits)', () => {
    const s = totp.generateSecret();
    assert.equal(s.length, 32);
    assert.match(s, /^[A-Z2-7]+$/);
  });

  await t.test('a freshly generated code verifies; a wrong one does not', () => {
    const secret = totp.generateSecret();
    const now = Date.now();
    const code = totp.totpNow(secret, now);
    assert.match(code, /^\d{6}$/);
    assert.equal(totp.verifyTotp(secret, code, now), true);
    assert.equal(totp.verifyTotp(secret, '000000', now), false);
    assert.equal(totp.verifyTotp(secret, '12345', now), false);   // wrong length
    assert.equal(totp.verifyTotp(secret, 'abcdef', now), false);  // non-numeric
  });

  await t.test('±1 step of clock skew is tolerated, ±2 is not', () => {
    const secret = totp.generateSecret();
    const t0 = 1_700_000_000_000;
    const code = totp.totpNow(secret, t0);
    assert.equal(totp.verifyTotp(secret, code, t0 + 30_000), true);   // +1 step
    assert.equal(totp.verifyTotp(secret, code, t0 - 30_000), true);   // -1 step
    assert.equal(totp.verifyTotp(secret, code, t0 + 90_000), false);  // +3 steps
  });

  await t.test('otpauth URI carries the standard fields', () => {
    const uri = totp.otpauthUri('JBSWY3DPEHPK3PXP', 'amara@osmo.money');
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
    assert.match(uri, /issuer=OsmoBank/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });
});

test('util: validation', async (t) => {
  await t.test('str enforces type, trim, length, and pattern', () => {
    assert.equal(util.str('  hi  ', { min: 1, max: 5 }), 'hi');
    assert.throws(() => util.str(42), /must be a string/);
    assert.throws(() => util.str('', { min: 1 }), /characters/);
    assert.throws(() => util.str('toolong', { max: 3 }), /characters/);
    assert.throws(() => util.str('abc', { pattern: /^\d+$/ }), /invalid format/);
  });

  await t.test('num coerces numeric strings and enforces range/int', () => {
    assert.equal(util.num('12.5'), 12.5);
    assert.equal(util.num(7, { int: true }), 7);
    assert.throws(() => util.num('abc'), /must be a number/);
    assert.throws(() => util.num(NaN), /must be a number/);
    assert.throws(() => util.num(3.5, { int: true }), /integer/);
    assert.throws(() => util.num(5, { min: 10 }), /between/);
    assert.throws(() => util.num(50, { max: 10 }), /between/);
  });

  await t.test('oneOf and round2', () => {
    assert.equal(util.oneOf('a', ['a', 'b']), 'a');
    assert.throws(() => util.oneOf('z', ['a', 'b']), /one of/);
    assert.equal(util.round2(1.005 + 0), 1.0);
    assert.equal(util.round2(2.345), 2.35);
    assert.equal(util.round2(10 / 3), 3.33);
  });

  await t.test('sha256hex is deterministic and hex', () => {
    assert.equal(util.sha256hex('x'), util.sha256hex('x'));
    assert.notEqual(util.sha256hex('x'), util.sha256hex('y'));
    assert.match(util.sha256hex('x'), /^[0-9a-f]{64}$/);
  });
});

test('util: passwords', async (t) => {
  // Reproduce the stored format hashPass() writes: scrypt:<salt>:<hashHex>.
  const makeHash = (pass) => {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(String(pass), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
    return `scrypt:${salt}:${hash}`;
  };

  await t.test('verifyPass accepts the right passphrase, rejects wrong', () => {
    const stored = makeHash('correct-horse-battery');
    assert.equal(util.verifyPass('correct-horse-battery', stored), true);
    assert.equal(util.verifyPass('wrong', stored), false);
  });

  await t.test('malformed stored hashes never verify', () => {
    assert.equal(util.verifyPass('x', 'not-a-hash'), false);
    assert.equal(util.verifyPass('x', 'bcrypt:salt:hash'), false);
    assert.equal(util.verifyPass('x', ''), false);
    assert.equal(util.verifyPass('x', 'scrypt::'), false);
  });
});

test('util: cookies', async (t) => {
  await t.test('cookieString carries the hardening flags', () => {
    const s = util.cookieString('ob_sess', 'tok', { maxAge: 100 });
    assert.match(s, /^ob_sess=tok/);
    assert.match(s, /HttpOnly/);
    assert.match(s, /SameSite=Strict/);
    assert.match(s, /Path=\//);
    assert.match(s, /Max-Age=100/);
    const cleared = util.cookieString('ob_sess', 'tok', { clear: true });
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /^ob_sess=;/);
  });

  await t.test('readCookie parses a named cookie from the header', () => {
    const req = { headers: { cookie: 'a=1; ob_sess=abc123; b=2' } };
    assert.equal(util.readCookie(req, 'ob_sess'), 'abc123');
    assert.equal(util.readCookie(req, 'a'), '1');
    assert.equal(util.readCookie(req, 'missing'), null);
    assert.equal(util.readCookie({ headers: {} }, 'ob_sess'), null);
  });

  await t.test('publicUser exposes only whitelisted fields', () => {
    const row = { id: 1, name: 'A', handle: 'a', email: 'a@x.y', role: 'member', status: 'active', created_at: 't', pass: 'scrypt:secret', totp_secret: 'S' };
    const pub = util.publicUser(row);
    assert.deepEqual(Object.keys(pub).sort(), ['createdAt', 'email', 'handle', 'id', 'name', 'role', 'status']);
    assert.equal(pub.pass, undefined);
    assert.equal(pub.totp_secret, undefined);
  });
});

test('util: rate limiting + lockout', async (t) => {
  await t.test('rateLimit allows up to max, then 429s', () => {
    const mw = util.rateLimit({ windowMs: 60_000, max: 3, key: () => 'fixed-key' });
    const run = () => { let err; mw({ ip: 'x' }, {}, (e) => { err = e; }); return err; };
    assert.equal(run(), undefined);
    assert.equal(run(), undefined);
    assert.equal(run(), undefined);
    const blocked = run();
    assert.equal(blocked?.status, 429);
  });

  await t.test('lockout trips after the threshold and clears on success', () => {
    const key = 'lock-test-' + randomBytes(4).toString('hex');
    for (let i = 0; i < 5; i++) { assert.doesNotThrow(() => util.assertNotLocked(key)); util.recordFail(key); }
    util.recordFail(key); // 6th failure trips the lock
    assert.throws(() => util.assertNotLocked(key), /locked/);
    util.clearFails(key);
    assert.doesNotThrow(() => util.assertNotLocked(key));
  });
});

test('pdf writer', async (t) => {
  await t.test('builds a valid single-page PDF buffer', () => {
    const pdf = new Pdf({ title: 'OsmoBank — Statement' });
    pdf.text('Member #48195').heading('YEAR TO DATE').row('Net worth', '$12,450');
    const buf = pdf.build();
    assert.ok(Buffer.isBuffer(buf));
    const s = buf.toString('latin1');
    assert.ok(s.startsWith('%PDF-1.4'));
    assert.ok(s.includes('/Type /Catalog'));
    assert.ok(s.includes('xref'));
    assert.ok(s.trimEnd().endsWith('%%EOF'));
  });

  await t.test('escapes parentheses and paginates long content', () => {
    const pdf = new Pdf({ title: 'Report (test)' });
    for (let i = 0; i < 120; i++) pdf.text(`row ${i} (with parens) \\ backslash`);
    const buf = pdf.build();
    const s = buf.toString('latin1');
    assert.ok(s.includes('/Count '));
    // More than one page object once content overflows a single page.
    const pageCount = (s.match(/\/Type \/Page[^s]/g) || []).length;
    assert.ok(pageCount >= 2, `expected multiple pages, got ${pageCount}`);
  });

  await t.test('table renders header + rows without throwing', () => {
    const pdf = new Pdf();
    pdf.table(
      [{ label: 'A', width: 0.5 }, { label: 'B', width: 0.5, align: 'right' }],
      [['one', '1'], ['two', '2']]);
    assert.ok(pdf.build().length > 100);
  });
});
