/* Osmo Assure hydrator — the member side of identity verification.
 *
 * The page is public: the explanation of how submissions are protected is
 * readable by anyone. The portal (GET/POST/DELETE /api/kyc) only appears for a
 * signed-in member, and the server is the real gate — this just avoids showing
 * a form that could not submit.
 *
 * Nothing identifying is ever echoed back: the API deliberately does not return
 * the sealed fields, so there is nothing here to render even by accident. */

const show = (elm, on) => { if (elm) elm.style.display = on ? '' : 'none'; };

const GRN = 'var(--grn,#17a562)';
const AMBER = 'var(--red,#c47b10)';
const MUT = 'var(--mut,#757575)';

const STATUS = {
  pending: { label: 'UNDER REVIEW', color: AMBER, big: 'IN REVIEW',
    sub: 'A reviewer will open your case and decide. You can withdraw it until then.' },
  approved: { label: 'VERIFIED', color: GRN, big: 'VERIFIED',
    sub: 'Your identity is verified. Nothing further is needed.' },
  rejected: { label: 'NOT ACCEPTED', color: AMBER, big: 'NOT ACCEPTED',
    sub: 'Your submission was not accepted — the reason is below. You can correct it and submit again.' },
  withdrawn: { label: 'WITHDRAWN', color: MUT, big: 'WITHDRAWN',
    sub: 'You withdrew this submission and its sealed record was erased.' },
};

const chip = (elm, status) => {
  if (!elm) return;
  const s = STATUS[status] || { label: String(status || '').toUpperCase(), color: MUT };
  elm.textContent = s.label;
  elm.style.color = s.color;
  elm.style.borderColor = s.color === MUT ? 'var(--dt,#d9d9d9)' : `color-mix(in srgb,${s.color} 40%,transparent)`;
};

export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    ctx.setAction('assureSubmit', () => submit(root, ctx));
    ctx.setAction('assureWithdraw', () => withdraw(root, ctx));
    ctx.setAction('assureScrollPortal', () => {
      const p = ctx.slot(root, 'assure.portal');
      if (p && p.style.display !== 'none') p.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else ctx.nav('login');
    });
    root.dataset.hydrated = '1';
  }
  await fill(root, ctx);
}

async function fill(root, ctx) {
  const seq = (root.__assureSeq = (root.__assureSeq || 0) + 1);
  const authed = !!ctx.me();

  show(ctx.slot(root, 'assure.loginBtn'), !authed);
  show(ctx.slot(root, 'assure.dashBtn'), authed);
  show(ctx.slot(root, 'assure.signedOut'), !authed);

  if (!authed) {
    show(ctx.slot(root, 'assure.portal'), false);
    // Key custody is reported by /api/kyc, which needs a session — say so rather
    // than leaving the paragraph above pointing at a line that never appears.
    const note = ctx.slot(root, 'assure.keyNote');
    if (note) {
      note.style.display = '';
      note.style.color = 'var(--mut,#757575)';
      note.textContent = 'SIGN IN TO SEE HOW THIS DEPLOYMENT STORES ITS ENCRYPTION KEY.';
    }
    const big = ctx.slot(root, 'assure.statusBig');
    if (big) { big.textContent = 'NOT SIGNED IN'; big.style.color = ''; }
    const sub = ctx.slot(root, 'assure.statusSub');
    if (sub) sub.textContent = 'Sign in to start or check a verification.';
    const act = ctx.slot(root, 'assure.statusAction');
    if (act) { act.style.display = ''; act.textContent = 'Log in'; }
    return;
  }

  let d;
  try { d = await ctx.api.get('/api/kyc'); }
  catch (e) { ctx.errToast(e); return; }
  if (root.__assureSeq !== seq) return;

  show(ctx.slot(root, 'assure.portal'), true);

  // ---- key-custody note: state the weaker configuration rather than hide it.
  const keyNote = ctx.slot(root, 'assure.keyNote');
  if (keyNote) {
    const outside = d.protection?.keyOutsideDatabase;
    keyNote.style.display = outside === undefined ? 'none' : '';
    if (outside === false) {
      keyNote.style.color = 'var(--red,#c47b10)';
      keyNote.textContent = 'THIS DEPLOYMENT KEEPS THE ENCRYPTION KEY IN THE DATABASE ITSELF. '
        + 'ACCESS IS STILL AUDITED, BUT A DATABASE DUMP WOULD INCLUDE THE KEY.';
    } else if (outside === true) {
      keyNote.style.color = 'var(--grn,#17a562)';
      keyNote.textContent = 'THIS DEPLOYMENT KEEPS THE ENCRYPTION KEY OUTSIDE THE DATABASE, '
        + 'SO A DATABASE DUMP ALONE CANNOT OPEN ANY SUBMISSION.';
    }
  }

  const cur = d.submission;

  // ---- status card ----------------------------------------------------------
  const big = ctx.slot(root, 'assure.statusBig');
  const sub = ctx.slot(root, 'assure.statusSub');
  const act = ctx.slot(root, 'assure.statusAction');
  const meta = cur ? STATUS[cur.status] : null;
  if (big) {
    big.textContent = meta ? meta.big : 'NOT STARTED';
    big.style.color = cur && cur.status === 'approved' ? GRN : '';
  }
  if (sub) sub.textContent = meta ? meta.sub : 'You have not submitted anything yet.';
  if (act) {
    act.style.display = d.canSubmit ? '' : 'none';
    act.textContent = cur ? 'Submit again' : 'Start verification';
  }

  // ---- current submission ---------------------------------------------------
  const curBox = ctx.slot(root, 'assure.current');
  if (cur) {
    show(curBox, true);
    chip(ctx.slot(root, 'assure.curChip'), cur.status);
    ctx.slot(root, 'assure.curDoc').textContent = `${cur.docLabel} · ${cur.country}`;
    const bits = [`SUBMITTED ${ctx.fmt.date(cur.submittedAt)}`];
    if (cur.reviewedAt) bits.push(`REVIEWED ${ctx.fmt.date(cur.reviewedAt)}`);
    ctx.slot(root, 'assure.curMeta').textContent = bits.join(' · ');
    const note = ctx.slot(root, 'assure.curNote');
    if (note) {
      note.style.display = cur.decisionNote ? '' : 'none';
      note.textContent = cur.decisionNote || '';
    }
    const wd = ctx.slot(root, 'assure.curWithdraw');
    if (wd) {
      wd.style.display = cur.status === 'pending' ? '' : 'none';
      wd.dataset.id = String(cur.id);
    }
  } else {
    show(curBox, false);
  }

  // ---- form -----------------------------------------------------------------
  const form = ctx.slot(root, 'assure.form');
  show(form, !!d.canSubmit);
  if (d.canSubmit) {
    const sel = ctx.slot(root, 'assure.docType');
    if (sel && !sel.options.length) {
      for (const t of d.docTypes || []) {
        const o = document.createElement('option');
        o.value = t.value;
        o.textContent = t.label;
        sel.appendChild(o);
      }
    }
  }

  // ---- history --------------------------------------------------------------
  const wrap = ctx.slot(root, 'assure.historyWrap');
  const hist = d.history || [];
  show(wrap, hist.length > 0);
  const L = ctx.list(root, 'assure.history');
  if (L && hist.length) {
    L.clear();
    for (const h of hist) {
      const row = L.add();
      chip(ctx.slot(row, 'hChip'), h.status);
      ctx.slot(row, 'hDoc').textContent = `${h.docLabel} · ${h.country}`;
      ctx.slot(row, 'hDate').textContent = ctx.fmt.date(h.submittedAt);
    }
  }
}

async function submit(root, ctx) {
  const val = (name) => String(ctx.slot(root, name)?.value ?? '').trim();
  const body = {
    fullName: val('assure.fullName'),
    dateOfBirth: val('assure.dob'),
    country: val('assure.country').toUpperCase(),
    docType: val('assure.docType'),
    docNumber: val('assure.docNumber'),
    address: val('assure.address') || undefined,
    consent: !!ctx.slot(root, 'assure.consent')?.checked,
  };
  if (!body.consent) return ctx.toast('PLEASE CONSENT BEFORE SUBMITTING', 'err');
  if (!body.fullName || !body.dateOfBirth || !body.country || !body.docNumber) {
    return ctx.toast('FILL IN EVERY REQUIRED FIELD', 'err');
  }
  try {
    await ctx.api.post('/api/kyc', body);
    // Clear the fields so the identifying values do not linger in the DOM.
    for (const n of ['assure.fullName', 'assure.dob', 'assure.country', 'assure.docNumber', 'assure.address']) {
      const elm = ctx.slot(root, n);
      if (elm) elm.value = '';
    }
    const c = ctx.slot(root, 'assure.consent');
    if (c) c.checked = false;
    ctx.toast('SUBMITTED · SEALED AND QUEUED FOR REVIEW');
    await fill(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

async function withdraw(root, ctx) {
  const id = Number(ctx.slot(root, 'assure.curWithdraw')?.dataset?.id);
  if (!id) return;
  try {
    await ctx.api.del(`/api/kyc/${id}`);
    ctx.toast('WITHDRAWN · SEALED RECORD ERASED');
    await fill(root, ctx);
  } catch (e) { ctx.errToast(e); }
}
