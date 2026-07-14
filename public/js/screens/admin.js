/* Admin (DAO operator) console.
 * Data: GET /api/admin/overview. Mutations: venture approve, payout batch sign,
 * user role/status PATCH, and a member search modal (GET /api/admin/users?q=).
 * Screen is admin-only; the core router guards the route before this runs. */

const GRN = 'var(--grn,#17a562)';
const AMBER = 'var(--red,#c47b10)';
const MUT = 'var(--mut,#757575)';

// Sector → Material Symbol, matched against the venture name/blurb text.
const SECTOR_ICONS = [
  [/solar|energy|power|grid|helios/i, 'solar_power'],
  [/robot|manufactur|industr|ferry/i, 'precision_manufacturing'],
  [/logist|ship|port|transport|freight|atlas/i, 'local_shipping'],
  [/ocean|marine|aqua|water|reef|kelp|nova/i, 'waves'],
  [/mesh|network|telecom|connect|internet|kite/i, 'hub'],
  [/agri|farm|food/i, 'agriculture'],
  [/health|med|bio/i, 'medical_services'],
  [/estate|housing|property/i, 'apartment'],
  [/fin|credit|bank/i, 'account_balance'],
];
const iconFor = (text) =>
  (SECTOR_ICONS.find(([re]) => re.test(String(text || ''))) || [null, 'workspaces'])[1];

const stripAt = (h) => String(h || '').replace(/^@+/, '');

function initialsOf(handle) {
  const h = stripAt(handle).trim();
  const parts = h.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : h.slice(0, 2);
  return (s || '?').toUpperCase();
}

function shortBlurb(b) {
  const s = String(b || '').trim();
  return s.length > 46 ? s.slice(0, 46).replace(/\s+\S*$/, '').trim() + '…' : s;
}

// Quarter label (Q1..Q4) from the payout due date (server sends the UTC
// last-day-of-quarter, e.g. "2026-09-30"). Empty string if unparseable.
function quarterOf(due) {
  if (!due) return '';
  const s = String(due);
  const d = new Date(s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? '' : `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

// ---- data fetch + fill ------------------------------------------------------
async function load(root, ctx) {
  const { fmt } = ctx;
  const seq = (root.__adminSeq = (root.__adminSeq || 0) + 1);

  let d;
  try {
    d = await ctx.api.get('/api/admin/overview');
  } catch (e) {
    ctx.errToast(e);
    return;
  }
  if (root.__adminSeq !== seq) return;

  const put = (name, text) => {
    const el = ctx.slot(root, name);
    if (el) el.textContent = text;
  };

  // ---- stat cards ----------------------------------------------------------
  put('admin.members', fmt.num(d.members));
  put('admin.membersWeek', `+${fmt.num(d.membersThisWeek)} THIS WEEK`);
  put('admin.treasury', fmt.usd(d.treasury));
  // We don't receive a treasury month-to-date series, so we can't compute the
  // change truthfully — show a dash rather than a fabricated percentage.
  const mtd = ctx.slot(root, 'admin.treasuryMtd');
  if (mtd) {
    mtd.textContent = '— MTD';
    mtd.style.color = 'var(--fnt,#a3a3a3)';
  }
  put('admin.volume24h', fmt.usd(d.volume24h));
  put('admin.transfers24h', `${fmt.num(d.transfers24h)} TRANSFERS`);

  const na = d.needsAction || {};
  const listings = Number(na.listings) || 0;
  const payoutsDue = Number(na.payoutsDue) || 0;
  const kyc = Number(na.kyc) || 0;
  put('admin.needsAction', fmt.num(listings + payoutsDue + kyc));
  put('admin.needsBreakdown', `${listings} LISTINGS · ${payoutsDue} PAYOUT · ${kyc} KYC`);

  // ---- network -------------------------------------------------------------
  const net = d.network || {};
  put('admin.block', fmt.num(net.block));
  put('admin.latency', `${net.latencyMs}MS`);
  put('admin.uptime', `${net.uptimePct}%`);
  put('admin.signers', String(net.signers ?? '—'));

  // ---- listing queue -------------------------------------------------------
  const L = ctx.list(root, 'admin.listings');
  if (L) {
    L.clear();
    const queue = d.listingQueue || [];
    if (queue.length) {
      for (const v of queue) {
        const row = L.add();
        const icon = ctx.slot(row, 'icon');
        if (icon) icon.textContent = iconFor(`${v.name} ${v.blurb}`);
        ctx.slot(row, 'title').textContent = `${v.name} — ${shortBlurb(v.blurb)}`;
        const sub = ctx.slot(row, 'sub');
        if (sub) sub.textContent = `STATUS · ${String(v.status || 'pending').toUpperCase()}`;
        const approve = row.querySelector('[data-action="demoApprove"]');
        if (approve) approve.dataset.vid = String(v.ventureId);
      }
    } else {
      const row = L.add();
      const icon = ctx.slot(row, 'icon');
      if (icon) icon.textContent = 'inbox';
      ctx.slot(row, 'title').textContent = 'No ventures awaiting review';
      const sub = ctx.slot(row, 'sub');
      if (sub) sub.textContent = '';
      row.querySelectorAll('[data-action]').forEach((b) => { b.style.display = 'none'; });
    }
  }

  // ---- payout queue --------------------------------------------------------
  const P = ctx.list(root, 'admin.payouts');
  if (P) {
    P.clear();
    const queue = d.payoutQueue || [];
    if (queue.length) {
      for (const q of queue) {
        const row = P.add();
        const icon = ctx.slot(row, 'icon');
        if (icon) icon.textContent = iconFor(q.name);
        const qLabel = quarterOf(q.due);
        ctx.slot(row, 'title').textContent =
          `${q.name}${qLabel ? ` ${qLabel}` : ''} · ${fmt.usd(q.estTotal)} to ${fmt.num(q.holders)} holders`;
        ctx.slot(row, 'sub').textContent = `DUE ${fmt.date(q.due)}`;
        const btn = row.querySelector('[data-action="demoPayout"]');
        if (btn) {
          btn.dataset.vid = String(q.ventureId);
          btn.dataset.est = String(q.estTotal);
        }
      }
    } else {
      const row = P.add();
      const icon = ctx.slot(row, 'icon');
      if (icon) icon.textContent = 'inbox';
      ctx.slot(row, 'title').textContent = 'No payouts due';
      ctx.slot(row, 'sub').textContent = '';
      row.querySelectorAll('[data-action]').forEach((b) => { b.style.display = 'none'; });
    }
  }

  // ---- newest members ------------------------------------------------------
  const M = ctx.list(root, 'admin.newMembers');
  if (M) {
    M.clear();
    const members = d.newestMembers || [];
    if (members.length) {
      for (const u of members) {
        const row = M.add();
        const av = ctx.slot(row, 'avatar');
        if (av) av.textContent = initialsOf(u.handle);
        ctx.slot(row, 'who').textContent = `@${stripAt(u.handle)} · Member #${fmt.num(u.memberNo)}`;
        ctx.slot(row, 'joined').textContent =
          `JOINED ${String(u.joinedAgo || '').toUpperCase()} · KYC ${u.kyc === 'verified' ? '✓' : 'PENDING'}`;
        applyChip(ctx.slot(row, 'chip'), u.status);
        wireRole(ctx.slot(row, 'role'), root, ctx, u);
        wireFreeze(ctx.slot(row, 'freeze'), u);
      }
    } else {
      const row = M.add();
      const av = ctx.slot(row, 'avatar');
      if (av) av.textContent = '—';
      ctx.slot(row, 'who').textContent = 'No members yet';
      ctx.slot(row, 'joined').textContent = '';
      const chip = ctx.slot(row, 'chip');
      if (chip) chip.style.display = 'none';
      const sel = ctx.slot(row, 'role');
      if (sel) sel.style.display = 'none';
      const fz = ctx.slot(row, 'freeze');
      if (fz) fz.style.display = 'none';
    }
  }
}

function applyChip(chip, status) {
  if (!chip) return;
  const s = String(status || 'active');
  const active = s === 'active';
  chip.style.display = 'inline-block';
  chip.textContent = active ? 'ACTIVE' : s.toUpperCase();
  chip.style.color = active ? GRN : AMBER;
  chip.style.borderColor = active
    ? 'color-mix(in srgb,var(--grn,#17a562) 35%,transparent)'
    : 'var(--reds,#f0b9b5)';
}

// ---- per-row role select ----------------------------------------------------
function wireRole(sel, root, ctx, u) {
  if (!sel) return;
  sel.style.display = '';
  sel.value = String(u.role || 'member').toUpperCase();
  let prev = sel.value;
  sel.onchange = async () => {
    const roleUpper = sel.value;
    try {
      await ctx.api.patch(`/api/admin/users/${u.id}`, { role: roleUpper.toLowerCase() });
      ctx.toast(`ROLE ASSIGNED · @${stripAt(u.handle).toUpperCase()} → ${roleUpper}`);
      prev = roleUpper;
      await load(root, ctx);
    } catch (e) {
      ctx.errToast(e);
      sel.value = prev; // revert (e.g. last-admin guard)
    }
  };
}

// ---- per-row freeze toggle --------------------------------------------------
function wireFreeze(fz, u) {
  if (!fz) return;
  fz.style.display = '';
  fz.dataset.uid = String(u.id);
  fz.dataset.status = String(u.status || 'active');
  fz.dataset.handle = stripAt(u.handle);
  const frozen = u.status === 'frozen';
  fz.style.color = frozen ? AMBER : MUT;
  fz.title = frozen ? 'Reactivate account' : 'Freeze account';
}

// ---- mutations --------------------------------------------------------------
async function approve(root, ctx, el) {
  const id = Number(el?.dataset?.vid);
  if (!id) return;
  try {
    await ctx.api.post(`/api/admin/ventures/${id}/approve`, {});
    ctx.toast('VENTURE APPROVED FOR LISTING');
    await load(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

async function signBatch(root, ctx, el) {
  const id = Number(el?.dataset?.vid);
  const est = Number(el?.dataset?.est);
  if (!id) return;
  try {
    const r = await ctx.api.post(`/api/ventures/${id}/payouts`, {
      kind: 'dividend', total: est, memo: 'Quarterly dividend batch',
    });
    const total = Number(r?.payout?.total ?? est);
    const n = (r?.items || []).length;
    ctx.toast(`DIVIDEND BATCH SIGNED · ${ctx.fmt.usd(total)} TO ${n} HOLDERS`);
    await load(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

async function toggleFreeze(root, ctx, el) {
  const id = Number(el?.dataset?.uid);
  if (!id) return;
  const next = el?.dataset?.status === 'frozen' ? 'active' : 'frozen';
  const handle = String(el?.dataset?.handle || '').toUpperCase();
  try {
    await ctx.api.patch(`/api/admin/users/${id}`, { status: next });
    ctx.toast(next === 'frozen' ? `ACCOUNT FROZEN · @${handle}` : `ACCOUNT REACTIVATED · @${handle}`);
    await load(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

// ---- tabs -------------------------------------------------------------------
function scrollPanel(root, name) {
  const p = root.querySelector(`[data-panel="${name}"]`);
  if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- member search modal ----------------------------------------------------
function openSearch(root, ctx) {
  const m = ctx.buildModal('SEARCH MEMBERS', 'search');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'handle, name, or email';
  input.style.cssText = "width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dt,#d9d9d9);border-radius:12px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
  m.body.appendChild(input);

  const results = document.createElement('div');
  results.style.cssText = 'margin-top:12px;display:flex;flex-direction:column';
  m.body.appendChild(results);

  let seq = 0;
  const run = async () => {
    const my = ++seq;
    let data;
    try {
      data = await ctx.api.get(`/api/admin/users?q=${encodeURIComponent(input.value.trim())}`);
    } catch (e) { ctx.errToast(e); return; }
    if (my !== seq) return;
    renderResults(results, data?.users || [], ctx, root, run);
  };

  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 220); });
  run();
  setTimeout(() => input.focus(), 30);
}

function renderResults(container, users, ctx, root, rerun) {
  container.textContent = '';
  if (!users.length) {
    const empty = document.createElement('div');
    empty.style.cssText = "padding:16px 0;font-family:'IBM Plex Mono',monospace;font-size:12px;letter-spacing:.06em;color:var(--mut,#757575)";
    empty.textContent = 'NO MEMBERS MATCH';
    container.appendChild(empty);
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 0;border-top:1px dotted var(--dt,#d9d9d9)';

    const av = document.createElement('div');
    av.style.cssText = 'width:30px;height:30px;border-radius:50%;background:var(--ink,#0a0a0a);color:var(--inv,#fff);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex:0 0 auto';
    av.textContent = initialsOf(u.handle);

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0';
    const who = document.createElement('div');
    who.style.cssText = 'font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    who.textContent = `@${stripAt(u.handle)} · ${String(u.role || 'member').toUpperCase()}`;
    const email = document.createElement('div');
    email.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--fnt,#a3a3a3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    email.textContent = String(u.email || '');
    info.append(who, email);

    const sel = document.createElement('select');
    sel.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.06em;color:var(--mut,#757575);background:var(--sf,#fff);border:1px solid var(--dt,#d9d9d9);border-radius:100px;padding:4px 8px;cursor:pointer;flex:0 0 auto";
    for (const r of ['MEMBER', 'MANAGER', 'ADMIN']) {
      const o = document.createElement('option');
      o.textContent = r;
      sel.appendChild(o);
    }
    sel.value = String(u.role || 'member').toUpperCase();
    let prev = sel.value;
    sel.onchange = async () => {
      try {
        await ctx.api.patch(`/api/admin/users/${u.id}`, { role: sel.value.toLowerCase() });
        ctx.toast(`ROLE ASSIGNED · @${stripAt(u.handle).toUpperCase()} → ${sel.value}`);
        prev = sel.value;
        await load(root, ctx);
        rerun();
      } catch (e) { ctx.errToast(e); sel.value = prev; }
    };

    const fz = document.createElement('span');
    const frozen = u.status === 'frozen';
    fz.style.cssText = `font-family:'Material Symbols Sharp';font-size:17px;line-height:1;cursor:pointer;flex:0 0 auto;color:${frozen ? AMBER : MUT}`;
    fz.textContent = 'ac_unit';
    fz.title = frozen ? 'Reactivate account' : 'Freeze account';
    fz.onclick = async () => {
      const next = frozen ? 'active' : 'frozen';
      try {
        await ctx.api.patch(`/api/admin/users/${u.id}`, { status: next });
        ctx.toast(next === 'frozen'
          ? `ACCOUNT FROZEN · @${stripAt(u.handle).toUpperCase()}`
          : `ACCOUNT REACTIVATED · @${stripAt(u.handle).toUpperCase()}`);
        await load(root, ctx);
        rerun();
      } catch (e) { ctx.errToast(e); }
    };

    row.append(av, info, sel, fz);
    container.appendChild(row);
  }
}

// ---- support inbox (injected panel) -----------------------------------------
const CAT_LABEL = {
  password_reset: 'PASSWORD RESET', troubleshooting: 'TROUBLESHOOTING', account: 'ACCOUNT',
  payments: 'PAYMENTS', security: 'SECURITY', other: 'OTHER',
};

async function renderSupport(root, ctx) {
  let panel = root.querySelector('[data-support-inbox]');
  if (!panel) {
    panel = document.createElement('div');
    panel.setAttribute('data-support-inbox', '1');
    panel.style.cssText = 'max-width:1180px;margin:8px auto 48px;padding:0 clamp(16px,4vw,40px);box-sizing:border-box';
    root.appendChild(panel);
  }
  let data;
  try { data = await ctx.api.get('/api/admin/support'); } catch { return; }
  panel.textContent = '';

  const card = document.createElement('div');
  card.style.cssText = 'background:var(--sf,#fff);border:1px solid var(--hr,#e4e4e4);border-radius:18px;padding:20px 22px';
  const head = document.createElement('div');
  head.style.cssText = "display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575);margin-bottom:6px";
  const ic = document.createElement('span');
  ic.style.cssText = "font-family:'Material Symbols Sharp';font-size:16px;line-height:1";
  ic.textContent = 'support_agent';
  head.append(ic, document.createTextNode(`SUPPORT INBOX · ${data.openCount || 0} OPEN`));
  card.appendChild(head);

  const tickets = data.tickets || [];
  if (!tickets.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--mut,#757575);padding:10px 0';
    empty.textContent = 'No open tickets.';
    card.appendChild(empty);
  }
  for (const tk of tickets) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px dotted var(--dt2,#c6c6c6)';
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0';
    const meta = document.createElement('div');
    meta.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;color:var(--fnt,#a3a3a3);margin-bottom:4px";
    const who = tk.userHandle ? `@${stripAt(tk.userHandle)}` : (tk.email || 'anonymous');
    meta.textContent = `#${tk.id} · ${CAT_LABEL[tk.category] || String(tk.category).toUpperCase()} · ${tk.source === 'system' ? 'SYSTEM' : 'USER'} · ${who}`;
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13.5px;line-height:1.5;color:var(--ink,#0a0a0a);word-break:break-word';
    msg.textContent = tk.message; // textContent → server text can't inject markup
    body.append(meta, msg);
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button'); btn.tabIndex = 0;
    btn.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.08em;font-weight:600;cursor:pointer;border:1px solid var(--dt,#d9d9d9);border-radius:100px;padding:6px 12px;flex:0 0 auto;color:var(--mut,#757575)";
    btn.textContent = 'CLOSE';
    btn.addEventListener('click', async () => {
      try { await ctx.api.patch(`/api/admin/support/${tk.id}`, { status: 'closed' }); ctx.toast(`TICKET #${tk.id} CLOSED`); await renderSupport(root, ctx); }
      catch (e) { ctx.errToast(e); }
    });
    row.append(body, btn);
    card.appendChild(row);
  }
  panel.appendChild(card);
}

// ---- entry ------------------------------------------------------------------
export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    ctx.setAction('demoApprove', (el) => approve(root, ctx, el));
    ctx.setAction('adminHold', () => ctx.toast('HELD FOR NEXT REVIEW CYCLE'));
    ctx.setAction('demoPayout', (el) => signBatch(root, ctx, el));
    ctx.setAction('adminFreeze', (el) => toggleFreeze(root, ctx, el));
    ctx.setAction('adminSearch', () => openSearch(root, ctx));
    ctx.setAction('adminTabConsole', () => root.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    ctx.setAction('adminTabMembers', () => scrollPanel(root, 'members'));
    ctx.setAction('adminTabVentures', () => scrollPanel(root, 'ventures'));
    ctx.setAction('adminTabPayouts', () => scrollPanel(root, 'payouts'));
    ctx.setAction('adminTabProposals', () => ctx.toast('PROPOSALS · DEMO'));
    ctx.setAction('adminTabRisk', () => ctx.toast('RISK · DEMO'));
    root.dataset.hydrated = '1';
  }

  await load(root, ctx);
  await renderSupport(root, ctx);
}
