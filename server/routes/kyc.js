/* Osmo Assure — identity verification.
 *
 * Members submit their details once; the identifying fields are sealed with
 * AES-256-GCM before they touch the database (lib/vault.js). Reviewers see a
 * triage list built only from non-identifying columns, and opening a
 * submission is an explicit, audited action rather than a side effect of
 * listing the queue.
 */
import { db, tx, audit } from '../db.js';
import { ApiError, str, num, oneOf, requireAuth, requireRole } from '../lib/util.js';
import { seal, open, keyIsExternal } from '../lib/vault.js';

const DOC_TYPES = ['passport', 'national_id', 'drivers_licence', 'residence_permit'];
const DOC_LABEL = {
  passport: 'Passport',
  national_id: 'National ID',
  drivers_licence: "Driver's licence",
  residence_permit: 'Residence permit',
};
// Terminal states a member may replace by submitting again.
const RESUBMITTABLE = ['rejected', 'withdrawn'];

const initialsOf = (fullName) => String(fullName).trim().split(/\s+/)
  .map((w) => w[0]).join('').slice(0, 3).toUpperCase();

/** Last four characters of a document number, the rest masked. */
const maskDoc = (docNumber) => {
  const v = String(docNumber).replace(/\s+/g, '');
  return v.length <= 4 ? '••••' : '•'.repeat(Math.min(8, v.length - 4)) + v.slice(-4);
};

/** ISO date in the past, and old enough to hold a document. */
function birthDate(value) {
  const v = str(value, { min: 10, max: 10, name: 'dateOfBirth', pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const t = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new ApiError(400, 'dateOfBirth is not a real date');
  const years = (Date.now() - t) / (365.25 * 86400000);
  if (years < 0) throw new ApiError(400, 'dateOfBirth cannot be in the future');
  if (years < 16) throw new ApiError(400, 'You must be at least 16 to verify an account');
  if (years > 120) throw new ApiError(400, 'dateOfBirth looks incorrect');
  return v;
}

/** What the owner of a submission may see about it — never the sealed fields. */
const mineView = (row) => ({
  id: row.id,
  status: row.status,
  docType: row.doc_type,
  docLabel: DOC_LABEL[row.doc_type] ?? row.doc_type,
  country: row.country,
  submittedAt: row.created_at,
  reviewedAt: row.reviewed_at ?? null,
  decisionNote: row.decision_note ?? null,
});

/** Triage row for reviewers: enough to work a queue, not enough to identify. */
const queueView = (row) => ({
  id: row.id,
  userId: row.user_id,
  handle: row.handle ?? null,
  status: row.status,
  docType: row.doc_type,
  docLabel: DOC_LABEL[row.doc_type] ?? row.doc_type,
  country: row.country,
  initials: row.initials,
  submittedAt: row.created_at,
  reviewedAt: row.reviewed_at ?? null,
  reviewerHandle: row.reviewer_handle ?? null,
  decisionNote: row.decision_note ?? null,
});

export default function mount(app) {
  // ---- member portal ---------------------------------------------------------

  /** Current verification state, plus what the service actually guarantees. */
  app.get('/api/kyc', requireAuth, async (req, res, next) => {
    try {
      const rows = await db.prepare(
        'SELECT * FROM kyc_submissions WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
      const latest = rows[0] ?? null;
      res.json({
        submission: latest ? mineView(latest) : null,
        history: rows.slice(1).map(mineView),
        verified: latest?.status === 'approved',
        canSubmit: !latest || RESUBMITTABLE.includes(latest.status),
        docTypes: DOC_TYPES.map((v) => ({ value: v, label: DOC_LABEL[v] })),
        protection: {
          algorithm: 'AES-256-GCM',
          keyOutsideDatabase: await keyIsExternal(),
          auditedAccess: true,
        },
      });
    } catch (e) { next(e); }
  });

  /** Submit for verification. Identifying fields are sealed before storage. */
  app.post('/api/kyc', requireAuth, async (req, res, next) => {
    try {
      const fullName = str(req.body?.fullName, { min: 2, max: 120, name: 'fullName' });
      const dateOfBirth = birthDate(req.body?.dateOfBirth);
      const country = str(req.body?.country, { min: 2, max: 2, name: 'country', pattern: /^[A-Za-z]{2}$/ }).toUpperCase();
      const docType = oneOf(String(req.body?.docType || ''), DOC_TYPES, 'docType');
      const docNumber = str(req.body?.docNumber, { min: 4, max: 40, name: 'docNumber' });
      const address = req.body?.address ? str(req.body.address, { min: 4, max: 200, name: 'address' }) : null;
      if (req.body?.consent !== true) {
        throw new ApiError(400, 'You must consent to Osmo Assure processing these details');
      }

      const submission = await tx(async () => {
        const latest = await db.prepare(
          'SELECT status FROM kyc_submissions WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id);
        if (latest && !RESUBMITTABLE.includes(latest.status)) {
          throw new ApiError(409, latest.status === 'approved'
            ? 'Your identity is already verified'
            : 'You already have a submission under review');
        }
        const sealed = await seal({
          fullName, dateOfBirth, country, docType, docNumber, address,
          submittedIp: req.ip ?? null,
        });
        const id = Number((await db.prepare(
          `INSERT INTO kyc_submissions (user_id, status, sealed, doc_type, country, initials)
           VALUES (?,'pending',?,?,?,?)`)
          .run(req.user.id, sealed, docType, country, initialsOf(fullName))).lastInsertRowid);
        await audit(req.user.id, 'kyc.submit', `kyc:${id}`, `${DOC_LABEL[docType]} · ${country}`);
        return await db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id);
      });
      res.status(201).json({ submission: mineView(submission) });
    } catch (e) { next(e); }
  });

  /** Withdraw a submission that has not been decided yet. */
  app.delete('/api/kyc/:id', requireAuth, async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const out = await tx(async () => {
        const row = await db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id);
        if (!row) throw new ApiError(404, 'Submission not found');
        if (row.user_id !== req.user.id) throw new ApiError(403, 'Not your submission');
        if (row.status !== 'pending') throw new ApiError(400, 'Only a pending submission can be withdrawn');
        // The sealed record is destroyed on withdrawal — nothing to retain.
        await db.prepare(
          "UPDATE kyc_submissions SET status = 'withdrawn', sealed = '', updated_at = datetime('now') WHERE id = ?")
          .run(id);
        await audit(req.user.id, 'kyc.withdraw', `kyc:${id}`, 'sealed record erased');
        return await db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id);
      });
      res.json({ submission: mineView(out) });
    } catch (e) { next(e); }
  });

  // ---- reviewer console ------------------------------------------------------

  /** Queue. Built from non-identifying columns only — no decryption happens here. */
  app.get('/api/admin/kyc', requireRole('admin'), async (req, res, next) => {
    try {
      const status = req.query.status ? oneOf(String(req.query.status),
        ['pending', 'approved', 'rejected', 'withdrawn', 'all'], 'status') : 'pending';
      const rows = await db.prepare(
        `SELECT k.*, u.handle AS handle, r.handle AS reviewer_handle
           FROM kyc_submissions k
           JOIN users u ON u.id = k.user_id
           LEFT JOIN users r ON r.id = k.reviewer_id
          WHERE (? = 'all' OR k.status = ?)
          ORDER BY CASE WHEN k.status = 'pending' THEN 0 ELSE 1 END, k.id DESC
          LIMIT 200`).all(status, status);
      const counts = await db.prepare(
        'SELECT status, COUNT(*) AS n FROM kyc_submissions GROUP BY status').all();
      res.json({
        submissions: rows.map(queueView),
        counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
        keyOutsideDatabase: await keyIsExternal(),
      });
    } catch (e) { next(e); }
  });

  /** Open one submission. This is the only path that decrypts, and it is audited. */
  app.get('/api/admin/kyc/:id', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const row = await db.prepare(
        `SELECT k.*, u.handle AS handle, u.email AS email, r.handle AS reviewer_handle
           FROM kyc_submissions k JOIN users u ON u.id = k.user_id
           LEFT JOIN users r ON r.id = k.reviewer_id WHERE k.id = ?`).get(id);
      if (!row) throw new ApiError(404, 'Submission not found');
      if (!row.sealed) throw new ApiError(410, 'This submission was withdrawn and its details erased');

      let details;
      try { details = await open(row.sealed); }
      catch { throw new ApiError(500, 'This record could not be opened — it may have been tampered with'); }
      await audit(req.user.id, 'kyc.open', `kyc:${id}`, `reviewed the sealed details of @${row.handle}`);

      res.json({
        submission: queueView(row),
        account: { handle: row.handle, email: row.email },
        details: {
          fullName: details.fullName,
          dateOfBirth: details.dateOfBirth,
          country: details.country,
          docType: details.docType,
          docLabel: DOC_LABEL[details.docType] ?? details.docType,
          docNumber: details.docNumber,
          docNumberMasked: maskDoc(details.docNumber),
          address: details.address ?? null,
          submittedIp: details.submittedIp ?? null,
        },
      });
    } catch (e) { next(e); }
  });

  /** Decide a submission. Approving marks the account verified. */
  app.patch('/api/admin/kyc/:id', requireRole('admin'), async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      const status = oneOf(String(req.body?.status || ''), ['approved', 'rejected'], 'status');
      const note = req.body?.note ? str(req.body.note, { min: 1, max: 300, name: 'note' }) : null;
      if (status === 'rejected' && !note) {
        throw new ApiError(400, 'A rejection must say why, so the member can correct it');
      }

      const out = await tx(async () => {
        const row = await db.prepare('SELECT * FROM kyc_submissions WHERE id = ?').get(id);
        if (!row) throw new ApiError(404, 'Submission not found');
        if (row.status !== 'pending') throw new ApiError(400, `This submission is already ${row.status}`);
        await db.prepare(
          `UPDATE kyc_submissions SET status = ?, reviewer_id = ?, reviewed_at = datetime('now'),
                  decision_note = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(status, req.user.id, note, id);
        // An account held for review becomes active once verified.
        if (status === 'approved') {
          await db.prepare("UPDATE users SET status = 'active' WHERE id = ? AND status = 'review'").run(row.user_id);
        }
        await audit(req.user.id, `kyc.${status}`, `kyc:${id}`, note || 'no note');
        return await db.prepare(
          `SELECT k.*, u.handle AS handle, r.handle AS reviewer_handle FROM kyc_submissions k
             JOIN users u ON u.id = k.user_id LEFT JOIN users r ON r.id = k.reviewer_id
            WHERE k.id = ?`).get(id);
      });
      res.json({ submission: queueView(out) });
    } catch (e) { next(e); }
  });
}
