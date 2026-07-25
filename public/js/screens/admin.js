/* Admin (DAO operator) console.
 *
 * The static partial covers the overview: stat cards, listing and payout
 * queues, newest members, network. Everything below it is an injected panel,
 * one per tab in the header, each backed by a real endpoint:
 *
 *   ventures-manage  GET/PATCH /api/admin/ventures  — full lifecycle + edit
 *   kyc              GET/PATCH /api/admin/kyc       — Osmo Assure review queue
 *   proposals        /api/proposals + /api/admin/proposals — open and settle votes
 *   risk             GET /api/admin/risk            — nine counted signals
 *   stats            GET/PUT /api/admin/stats       — curated homepage figures
 *   support          GET/PATCH /api/admin/support   — member tickets
 *
 * Screen is admin-only; the core router guards the route before this runs, and
 * every endpoint re-checks the role server-side. */

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

// Verification state of a member's latest Osmo Assure submission. "none" is a
// real answer — most members have never submitted one.
const KYC_LABEL = {
  verified: '✓', pending: 'IN REVIEW', rejected: 'REJECTED',
  withdrawn: 'WITHDRAWN', none: 'NOT SUBMITTED',
};

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
          `JOINED ${String(u.joinedAgo || '').toUpperCase()} · KYC ${KYC_LABEL[u.kyc] ?? 'NOT SUBMITTED'}`;
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
      await refreshAll(root, ctx);
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
    await refreshAll(root, ctx);
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
    await refreshAll(root, ctx);
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
    await refreshAll(root, ctx);
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
        await refreshAll(root, ctx);
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
        await refreshAll(root, ctx);
        rerun();
      } catch (e) { ctx.errToast(e); }
    };

    row.append(av, info, sel, fz);
    container.appendChild(row);
  }
}

// ---- shared chrome for the injected operator panels --------------------------
// Every tab below builds the same card so the console reads as one surface:
// a mono header with an icon, an optional hint line, then the rows.

const el = (tag, css, text) => {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
};
const PANEL_WRAP = 'max-width:1180px;margin:8px auto 0;padding:0 clamp(16px,4vw,40px);box-sizing:border-box';
const CARD = 'background:var(--sf,#fff);border:1px solid var(--hr,#e4e4e4);border-radius:18px;padding:20px 22px';
const HEAD = "display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.14em;color:var(--mut,#757575)";
const HINT = 'font-size:12.5px;line-height:1.55;color:var(--mut,#757575);margin:6px 0 14px';
const ROW = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 0;border-top:1px dotted var(--dt2,#c6c6c6)';
const MONO_SM = "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.08em;color:var(--fnt,#a3a3a3)";
const BTN_SOLID = "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.08em;font-weight:600;cursor:pointer;border-radius:100px;padding:7px 14px;background:var(--ink,#0a0a0a);color:var(--inv,#fff);flex:0 0 auto";
const BTN_GHOST = "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.08em;font-weight:600;cursor:pointer;border:1px solid var(--dt,#d9d9d9);border-radius:100px;padding:6px 12px;color:var(--mut,#757575);flex:0 0 auto";
const INPUT = "width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dt,#d9d9d9);border-radius:10px;background:var(--bg,#f4f4f4);color:var(--ink,#0a0a0a);font-family:'IBM Plex Mono',monospace;font-size:13px";
const FIELD_LABEL = "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.12em;color:var(--mut,#757575);margin-bottom:6px";

// Panels are rendered concurrently, so their containers are created up front in
// a fixed order — otherwise whichever fetch returned first would decide where
// its panel sits on the page.
const PANEL_ORDER = ['ventures-manage', 'kyc', 'proposals', 'risk', 'stats', 'support'];

function ensurePanels(root) {
  for (const name of PANEL_ORDER) {
    if (root.querySelector(`[data-panel="${name}"]`)) continue;
    const p = el('div', PANEL_WRAP);
    p.setAttribute('data-panel', name);
    root.appendChild(p);
  }
  if (!root.querySelector('[data-panel-tail]')) {
    const tail = el('div', 'height:48px');
    tail.setAttribute('data-panel-tail', '1');
    root.appendChild(tail);
  }
}

/** Find-or-create an injected panel, and return its emptied card body. */
function panelCard(root, name, icon, title, hint) {
  let panel = root.querySelector(`[data-panel="${name}"]`);
  if (!panel) {
    panel = el('div', PANEL_WRAP);
    panel.setAttribute('data-panel', name);
    root.appendChild(panel);
  }
  panel.textContent = '';
  const card = el('div', CARD);
  const head = el('div', HEAD);
  head.append(el('span', "font-family:'Material Symbols Sharp';font-size:16px;line-height:1", icon),
    document.createTextNode(title));
  card.appendChild(head);
  if (hint) card.appendChild(el('div', HINT, hint));
  panel.appendChild(card);
  return card;
}

const btn = (label, style, onClick) => {
  const b = el('div', style, label);
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.addEventListener('click', onClick);
  return b;
};

const field = (label, node) => {
  const cell = el('div');
  cell.append(el('div', FIELD_LABEL, label), node);
  return cell;
};

const input = (value, type = 'text') => {
  const i = el('input', INPUT);
  i.type = type;
  if (value != null) i.value = String(value);
  return i;
};

const emptyRow = (card, text) => card.appendChild(
  el('div', 'font-size:13px;color:var(--mut,#757575);padding:10px 0', text));

// ---- ventures management (injected panel) -----------------------------------
// The full lifecycle in one place: every venture regardless of status, an edit
// form per row, approve/reject for pending ones, and a guarded close.
const PHASE_CHIP = {
  live: ['LIVE', GRN], upcoming: ['UPCOMING', AMBER], closed: ['CLOSED', MUT],
  pending: ['PENDING REVIEW', AMBER], rejected: ['REJECTED', MUT],
};

async function renderVentures(root, ctx) {
  let data;
  try { data = await ctx.api.get('/api/admin/ventures'); } catch { return; }
  const ventures = data.ventures || [];
  const counts = ventures.reduce((m, v) => ({ ...m, [v.phase]: (m[v.phase] || 0) + 1 }), {});
  const summary = ['live', 'upcoming', 'pending', 'closed']
    .filter((p) => counts[p]).map((p) => `${counts[p]} ${p}`).join(' · ');
  const card = panelCard(root, 'ventures-manage', 'inventory_2',
    `VENTURES · ${ventures.length} TOTAL${summary ? ` (${summary})` : ''}`,
    'Every venture, whatever its status. Opening and closing dates decide the phase — a venture with a future opening date is announced publicly but cannot be staked in yet.');

  if (!ventures.length) return emptyRow(card, 'No ventures yet.');

  for (const v of ventures) {
    const row = el('div', ROW);

    const [chipText, chipColor] = PHASE_CHIP[v.phase] || [String(v.phase || '').toUpperCase(), MUT];
    const chip = el('div', `font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;border-radius:100px;padding:4px 11px;flex:0 0 auto;color:${chipColor};border:1px solid ${chipColor === MUT ? 'var(--dt,#d9d9d9)' : `color-mix(in srgb,${chipColor} 40%,transparent)`}`, chipText);

    const body = el('div', 'flex:1;min-width:200px');
    body.appendChild(el('div', 'font-size:14px;font-weight:600', `${v.name} · ${v.sector}`));
    // Full ISO dates here rather than the compact "AUG 4" used on member
    // screens — an operator scheduling a raise needs the year to be unambiguous.
    const dates = [];
    if (v.opensAt) dates.push(`OPENS ${String(v.opensAt).slice(0, 10)}`);
    if (v.closesAt) dates.push(`CLOSES ${String(v.closesAt).slice(0, 10)}`);
    body.appendChild(el('div', MONO_SM + ';margin-top:3px',
      [`${Number(v.apy).toFixed(1)}% APY`, `${ctx.fmt.usd(v.raised)} OF ${ctx.fmt.usd(v.targetAmount)}`,
        `${v.holders} HOLDER${v.holders === 1 ? '' : 'S'}`, ...dates].join(' · ')));

    row.append(chip, body);

    // Inline editor, collapsed by default so the list stays scannable.
    const editor = el('div', 'display:none;width:100%;border-top:1px dotted var(--dt,#d9d9d9);padding-top:12px;margin-top:4px');
    row.appendChild(btn('EDIT', BTN_GHOST, () => {
      const open = editor.style.display !== 'none';
      editor.style.display = open ? 'none' : '';
      if (!open && !editor.dataset.built) { buildVentureEditor(editor, v, root, ctx); editor.dataset.built = '1'; }
    }));

    if (v.status === 'pending') {
      row.appendChild(btn('APPROVE', BTN_SOLID, () => ventureAction(root, ctx,
        () => ctx.api.post(`/api/admin/ventures/${v.id}/approve`, {}), `${v.name.toUpperCase()} APPROVED`)));
      row.appendChild(btn('REJECT', BTN_GHOST, () => ventureAction(root, ctx,
        () => ctx.api.post(`/api/admin/ventures/${v.id}/reject`, {}), `${v.name.toUpperCase()} REJECTED`)));
    } else if (v.status === 'active') {
      row.appendChild(btn('CLOSE', BTN_GHOST, async () => {
        try {
          await ctx.api.patch(`/api/admin/ventures/${v.id}`, { status: 'closed' });
          ctx.toast(`${v.name.toUpperCase()} CLOSED`);
          await refreshAll(root, ctx);
        } catch (e) {
          // 409 means real money is still staked; make the operator opt in.
          if (e?.status === 409 && window.confirm(`${e.message}\n\nClose anyway?`)) {
            try {
              await ctx.api.patch(`/api/admin/ventures/${v.id}`, { status: 'closed', force: true });
              ctx.toast(`${v.name.toUpperCase()} CLOSED WITH STAKES OPEN`);
              await refreshAll(root, ctx);
            } catch (e2) { ctx.errToast(e2); }
          } else if (e?.status !== 409) ctx.errToast(e);
        }
      }));
    }

    row.appendChild(editor);
    card.appendChild(row);
  }
}

function buildVentureEditor(box, v, root, ctx) {
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px');
  const f = {
    name: input(v.name), sector: input(v.sector), apy: input(v.apy, 'number'),
    minAmount: input(v.minAmount, 'number'), targetAmount: input(v.targetAmount, 'number'),
    opensAt: input(v.opensAt ? String(v.opensAt).slice(0, 10) : '', 'date'),
    closesAt: input(v.closesAt ? String(v.closesAt).slice(0, 10) : '', 'date'),
    badge: input(v.badge || ''),
  };
  f.badge.placeholder = 'e.g. NEW LISTING';
  grid.append(
    field('NAME', f.name), field('SECTOR', f.sector), field('APY (%)', f.apy),
    field('MINIMUM (USDC)', f.minAmount), field('TARGET (USDC)', f.targetAmount),
    field('OPENS', f.opensAt), field('CLOSES', f.closesAt), field('BADGE', f.badge));
  box.appendChild(grid);

  const blurb = el('textarea', INPUT + ';min-height:60px;resize:vertical;margin-top:12px');
  blurb.value = v.blurb || '';
  box.append(el('div', FIELD_LABEL + ';margin-top:12px', 'BLURB'), blurb);

  const bar = el('div', 'display:flex;gap:9px;margin-top:14px;flex-wrap:wrap');
  bar.appendChild(btn('SAVE CHANGES', BTN_SOLID, async () => {
    const body = {
      name: f.name.value.trim(),
      sector: f.sector.value.trim(),
      blurb: blurb.value.trim(),
      apy: Number(f.apy.value),
      minAmount: Number(f.minAmount.value),
      targetAmount: Number(f.targetAmount.value),
      // Empty clears the date; the server treats null as "no scheduled date".
      opensAt: f.opensAt.value || null,
      closesAt: f.closesAt.value || null,
      badge: f.badge.value.trim() || null,
    };
    try {
      await ctx.api.patch(`/api/admin/ventures/${v.id}`, body);
      ctx.toast(`${String(body.name).toUpperCase()} UPDATED`);
      await refreshAll(root, ctx);
    } catch (e) { ctx.errToast(e); }
  }));
  bar.appendChild(btn('CANCEL', BTN_GHOST, () => { box.style.display = 'none'; }));
  box.appendChild(bar);
}

async function ventureAction(root, ctx, run, message) {
  try { await run(); ctx.toast(message); await refreshAll(root, ctx); }
  catch (e) { ctx.errToast(e); }
}

// ---- Osmo Assure inbox (injected panel) -------------------------------------
// The queue is built from non-identifying columns. Opening one case is the only
// action that decrypts anything, and the server audits it — so this panel never
// bulk-reveals identities just because an operator loaded the page.
const KYC_CHIP = {
  pending: ['PENDING', AMBER], approved: ['APPROVED', GRN],
  rejected: ['REJECTED', MUT], withdrawn: ['WITHDRAWN', MUT],
};

async function renderKyc(root, ctx) {
  const filter = root.__kycFilter || 'pending';
  let data;
  try { data = await ctx.api.get(`/api/admin/kyc?status=${encodeURIComponent(filter)}`); } catch { return; }
  const counts = data.counts || {};
  const pending = Number(counts.pending || 0);

  const tab = ctx.slot(root, 'admin.kycTabCount');
  if (tab) {
    tab.style.display = pending ? '' : 'none';
    tab.textContent = String(pending);
  }

  const card = panelCard(root, 'kyc', 'encrypted',
    `OSMO ASSURE · ${pending} AWAITING REVIEW`,
    'Identifying details are sealed with AES-256-GCM. This list is built from initials, country and document type only — nothing is decrypted until you open a case, and opening one is written to the audit log under your name.');

  if (data.keyOutsideDatabase === false) {
    card.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.06em;line-height:1.6;color:var(--red,#c47b10);border:1px dotted var(--reds,#f0b9b5);border-radius:12px;padding:10px 12px;margin-bottom:12px",
      'NO OSMO_KYC_KEY SET · THE ENCRYPTION KEY IS STORED IN THE DATABASE, SO A DATABASE DUMP WOULD CONTAIN IT. SET OSMO_KYC_KEY TO KEEP IT OUTSIDE.'));
  }

  const tabs = el('div', 'display:flex;gap:7px;flex-wrap:wrap;margin-bottom:6px');
  for (const s of ['pending', 'approved', 'rejected', 'withdrawn', 'all']) {
    const n = s === 'all' ? Object.values(counts).reduce((a, b) => a + Number(b), 0) : Number(counts[s] || 0);
    const on = s === filter;
    tabs.appendChild(btn(`${s.toUpperCase()} ${n}`, on ? BTN_SOLID : BTN_GHOST, async () => {
      root.__kycFilter = s;
      await renderKyc(root, ctx);
    }));
  }
  card.appendChild(tabs);

  const rows = data.submissions || [];
  if (!rows.length) return emptyRow(card, `No ${filter === 'all' ? '' : filter + ' '}submissions.`);

  for (const s of rows) {
    const row = el('div', ROW);
    const [chipText, chipColor] = KYC_CHIP[s.status] || [String(s.status).toUpperCase(), MUT];
    row.appendChild(el('div', `font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;border-radius:100px;padding:4px 11px;flex:0 0 auto;color:${chipColor};border:1px solid ${chipColor === MUT ? 'var(--dt,#d9d9d9)' : `color-mix(in srgb,${chipColor} 40%,transparent)`}`, chipText));

    const body = el('div', 'flex:1;min-width:200px');
    body.appendChild(el('div', 'font-size:14px;font-weight:600',
      `#${s.id} · @${stripAt(s.handle)} · ${s.initials || '—'}`));
    const meta = [`${s.docLabel} · ${s.country}`, `SUBMITTED ${ctx.fmt.date(s.submittedAt)}`];
    if (s.reviewerHandle) meta.push(`BY @${stripAt(s.reviewerHandle)}`);
    body.appendChild(el('div', MONO_SM + ';margin-top:3px', meta.join(' · ')));
    if (s.decisionNote) body.appendChild(el('div', 'font-size:12.5px;color:var(--mut,#757575);margin-top:4px', s.decisionNote));
    row.append(body);

    if (s.status === 'withdrawn') {
      row.appendChild(el('div', MONO_SM, 'RECORD ERASED'));
    } else {
      row.appendChild(btn('OPEN CASE', s.status === 'pending' ? BTN_SOLID : BTN_GHOST,
        () => openKycCase(s, root, ctx)));
    }
    card.appendChild(row);
  }
}

/** Decrypt-and-decide modal. Reaching this is what the audit entry records. */
async function openKycCase(s, root, ctx) {
  let d;
  try { d = await ctx.api.get(`/api/admin/kyc/${s.id}`); } catch (e) { return ctx.errToast(e); }
  const m = ctx.buildModal(`CASE #${s.id} · @${stripAt(s.handle)}`, 'encrypted');

  m.body.appendChild(el('div', "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;color:var(--red,#c47b10);line-height:1.6",
    'THIS RECORD IS NOW DECRYPTED AND THE ACCESS IS LOGGED AGAINST YOUR ACCOUNT.'));

  const rowsOut = [
    ['FULL NAME', d.details.fullName],
    ['DATE OF BIRTH', d.details.dateOfBirth],
    ['COUNTRY', d.details.country],
    ['DOCUMENT', `${d.details.docLabel} · ${d.details.docNumber}`],
    ['ADDRESS', d.details.address || '—'],
    ['ACCOUNT', `@${stripAt(d.account.handle)} · ${d.account.email}`],
    ['SUBMITTED FROM', d.details.submittedIp || '—'],
  ];
  const table = el('div', 'margin-top:14px');
  for (const [k, v] of rowsOut) {
    const r = el('div', 'display:flex;gap:12px;padding:9px 0;border-bottom:1px dotted var(--dt2,#c6c6c6)');
    r.append(el('div', "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;color:var(--mut,#757575);width:130px;flex:0 0 auto", k),
      el('div', 'font-size:13.5px;word-break:break-word;flex:1', String(v)));
    table.appendChild(r);
  }
  m.body.appendChild(table);

  if (s.status !== 'pending') {
    m.body.appendChild(el('div', 'font-size:13px;color:var(--mut,#757575);margin-top:14px',
      `Already ${s.status}${s.reviewerHandle ? ` by @${stripAt(s.reviewerHandle)}` : ''}.`));
    return;
  }

  m.body.appendChild(el('div', FIELD_LABEL + ';margin-top:16px', 'NOTE (REQUIRED TO REJECT)'));
  const note = el('textarea', INPUT + ';min-height:64px;resize:vertical');
  note.placeholder = 'What the member needs to correct…';
  m.body.appendChild(note);

  const bar = el('div', 'display:flex;gap:9px;margin-top:14px;flex-wrap:wrap');
  const decide = async (status) => {
    if (status === 'rejected' && !note.value.trim()) {
      return ctx.toast('A REJECTION MUST SAY WHY', 'err');
    }
    try {
      await ctx.api.patch(`/api/admin/kyc/${s.id}`,
        { status, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
      m.close();
      ctx.toast(status === 'approved' ? `#${s.id} APPROVED · ACCOUNT VERIFIED` : `#${s.id} REJECTED`);
      await refreshAll(root, ctx);
    } catch (e) { ctx.errToast(e); }
  };
  bar.append(
    btn('APPROVE', BTN_SOLID + ';padding:11px 22px;font-size:12px', () => decide('approved')),
    btn('REJECT', BTN_GHOST + ';padding:10px 20px;font-size:12px', () => decide('rejected')));
  m.body.appendChild(bar);
}

// ---- proposals (injected panel) ---------------------------------------------
// Operators open votes and record outcomes. Every tally shown here is the real
// vote count from /api/proposals — nothing on this panel can manufacture support.
const PROP_CHIP = { live: ['LIVE', AMBER], passed: ['PASSED', GRN], rejected: ['REJECTED', MUT] };

async function renderProposals(root, ctx) {
  let data;
  try { data = await ctx.api.get('/api/proposals'); } catch { return; }
  const proposals = data.proposals || [];
  const liveCount = proposals.filter((p) => p.status === 'live').length;

  const card = panelCard(root, 'proposals', 'how_to_vote',
    `GOVERNANCE · ${liveCount} LIVE VOTE${liveCount === 1 ? '' : 'S'}`,
    'Open a vote, amend it while it runs, and record the outcome when it ends. Support percentages are counted from real member votes and cannot be set here.');

  // ---- new proposal form ----------------------------------------------------
  const form = el('div', 'border:1px dotted var(--dt2,#c6c6c6);border-radius:14px;padding:16px;margin-bottom:8px');
  form.appendChild(el('div', FIELD_LABEL, 'OPEN A NEW VOTE'));
  const title = input('');
  title.placeholder = 'e.g. Fund the Meridian Water expansion';
  form.appendChild(title);
  const blurb = el('textarea', INPUT + ';min-height:56px;resize:vertical;margin-top:10px');
  blurb.placeholder = 'What members are voting on (optional)';
  form.appendChild(blurb);
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:12px');
  const days = input(7, 'number');
  const quorum = input(30, 'number');
  const code = input('');
  code.placeholder = 'auto (OSM-0xx)';
  grid.append(field('OPEN FOR (DAYS)', days), field('QUORUM (%)', quorum), field('CODE', code));
  form.appendChild(grid);
  form.appendChild(btn('OPEN THE VOTE', BTN_SOLID + ';display:inline-block;margin-top:14px;padding:10px 20px;font-size:12px', async () => {
    if (title.value.trim().length < 4) return ctx.toast('GIVE THE PROPOSAL A TITLE', 'err');
    try {
      const r = await ctx.api.post('/api/admin/proposals', {
        title: title.value.trim(),
        blurb: blurb.value.trim(),
        days: Number(days.value) || 7,
        quorumPct: Number(quorum.value) || 30,
        ...(code.value.trim() ? { code: code.value.trim() } : {}),
      });
      ctx.toast(`${r.proposal.code} OPENED FOR VOTING`);
      await refreshAll(root, ctx);
    } catch (e) { ctx.errToast(e); }
  }));
  card.appendChild(form);

  if (!proposals.length) return emptyRow(card, 'No proposals yet.');

  for (const p of proposals) {
    const row = el('div', ROW);
    const [chipText, chipColor] = PROP_CHIP[p.status] || [String(p.status).toUpperCase(), MUT];
    row.appendChild(el('div', `font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;border-radius:100px;padding:4px 11px;flex:0 0 auto;color:${chipColor};border:1px solid ${chipColor === MUT ? 'var(--dt,#d9d9d9)' : `color-mix(in srgb,${chipColor} 40%,transparent)`}`, chipText));

    const body = el('div', 'flex:1;min-width:220px');
    body.appendChild(el('div', 'font-size:14px;font-weight:600', `${p.code} · ${p.title}`));
    const tally = p.voters > 0
      ? `${p.forPct}% FOR · ${p.againstPct}% AGAINST · ${p.voters} VOTER${p.voters === 1 ? '' : 'S'}`
      : 'NO VOTES CAST YET';
    const meta = [tally, `QUORUM ${p.quorumPct}% ${p.quorumReached ? 'REACHED' : 'NOT REACHED'}`];
    if (p.endsAt) meta.push(`ENDS ${ctx.fmt.date(p.endsAt).toUpperCase()}`);
    body.appendChild(el('div', MONO_SM + ';margin-top:3px', meta.join(' · ')));
    row.appendChild(body);

    const editor = el('div', 'display:none;width:100%;border-top:1px dotted var(--dt,#d9d9d9);padding-top:12px;margin-top:4px');
    row.appendChild(btn('EDIT', BTN_GHOST, () => {
      const open = editor.style.display !== 'none';
      editor.style.display = open ? 'none' : '';
      if (!open && !editor.dataset.built) { buildProposalEditor(editor, p, root, ctx); editor.dataset.built = '1'; }
    }));
    if (p.status === 'live') {
      row.appendChild(btn('RECORD PASSED', BTN_SOLID, () => setProposal(root, ctx, p, { status: 'passed' }, `${p.code} RECORDED AS PASSED`)));
      row.appendChild(btn('RECORD REJECTED', BTN_GHOST, () => setProposal(root, ctx, p, { status: 'rejected' }, `${p.code} RECORDED AS REJECTED`)));
    }
    row.appendChild(editor);
    card.appendChild(row);
  }
}

function buildProposalEditor(box, p, root, ctx) {
  const title = input(p.title);
  box.append(el('div', FIELD_LABEL, 'TITLE'), title);
  const blurb = el('textarea', INPUT + ';min-height:56px;resize:vertical');
  blurb.value = p.blurb || '';
  box.append(el('div', FIELD_LABEL + ';margin-top:12px', 'DESCRIPTION'), blurb);
  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:12px');
  const quorum = input(p.quorumPct, 'number');
  const days = input('', 'number');
  days.placeholder = 'unchanged';
  grid.append(field('QUORUM (%)', quorum), field('EXTEND TO (DAYS FROM NOW)', days));
  box.appendChild(grid);
  box.appendChild(btn('SAVE', BTN_SOLID + ';display:inline-block;margin-top:14px;padding:10px 20px;font-size:12px', () => {
    const body = { title: title.value.trim(), blurb: blurb.value.trim(), quorumPct: Number(quorum.value) };
    if (days.value !== '') body.days = Number(days.value);
    return setProposal(root, ctx, p, body, `${p.code} UPDATED`);
  }));
}

async function setProposal(root, ctx, p, body, message) {
  try {
    await ctx.api.patch(`/api/admin/proposals/${p.id}`, body);
    ctx.toast(message);
    await refreshAll(root, ctx);
  } catch (e) { ctx.errToast(e); }
}

// ---- risk (injected panel) ---------------------------------------------------
// Nine signals, each counted from real rows. A clear board says so plainly
// rather than inventing an alert to look busy.
const SEV = {
  high: ['HIGH', 'var(--red,#c47b10)'], medium: ['MEDIUM', 'var(--red,#c47b10)'],
  low: ['LOW', MUT], ok: ['CLEAR', GRN],
};
const RISK_TARGET = {
  kyc: 'kyc', members: 'members', ventures: 'ventures-manage',
  proposals: 'proposals', support: 'support',
};

async function renderRisk(root, ctx) {
  let data;
  try { data = await ctx.api.get('/api/admin/risk'); } catch { return; }
  const signals = data.signals || [];
  const needs = Number(data.needsAction || 0);

  // The header indicator is this same number — one source, no second opinion.
  const health = ctx.slot(root, 'admin.health');
  const dot = ctx.slot(root, 'admin.healthDot');
  const healthColor = needs === 0 ? GRN : AMBER;
  if (health) {
    health.textContent = needs === 0 ? 'NO OPEN RISK SIGNALS' : `${needs} SIGNAL${needs === 1 ? '' : 'S'} NEED ACTION`;
    health.parentElement.style.color = healthColor;
  }
  if (dot) dot.style.background = healthColor;
  const tab = ctx.slot(root, 'admin.riskTabCount');
  if (tab) {
    tab.style.display = needs ? '' : 'none';
    tab.textContent = String(needs);
  }

  const card = panelCard(root, 'risk', 'crisis',
    `RISK · ${needs} NEED${needs === 1 ? 'S' : ''} ACTION`,
    `Every signal below is a count of real rows, refreshed when this console loads (last checked ${ctx.fmt.date(data.checkedAt)}). Signals at zero are shown too, so a clear board is visibly clear rather than merely empty.`);

  for (const s of signals) {
    const [sevText, sevColor] = SEV[s.severity] || [String(s.severity).toUpperCase(), MUT];
    const row = el('div', ROW);
    row.appendChild(el('div', `font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;border-radius:100px;padding:4px 11px;flex:0 0 auto;color:${sevColor};border:1px solid ${sevColor === MUT ? 'var(--dt,#d9d9d9)' : `color-mix(in srgb,${sevColor} 40%,transparent)`}`, sevText));
    row.appendChild(el('div', `font-family:'Doto',monospace;font-weight:900;font-size:22px;min-width:44px;color:${s.count ? 'var(--ink,#0a0a0a)' : 'var(--fnt,#a3a3a3)'}`, String(s.count)));
    const body = el('div', 'flex:1;min-width:200px');
    body.appendChild(el('div', 'font-size:14px;font-weight:600', s.label));
    body.appendChild(el('div', MONO_SM + ';margin-top:3px', String(s.detail || '').toUpperCase()));
    row.appendChild(body);
    if (s.action && s.count > 0) {
      row.appendChild(btn('REVIEW', BTN_GHOST, () => scrollPanel(root, RISK_TARGET[s.action] || s.action)));
    }
    card.appendChild(row);
  }
}

// ---- support inbox (injected panel) -----------------------------------------
const CAT_LABEL = {
  password_reset: 'PASSWORD RESET', troubleshooting: 'TROUBLESHOOTING', account: 'ACCOUNT',
  payments: 'PAYMENTS', security: 'SECURITY', other: 'OTHER',
};

async function renderSupport(root, ctx) {
  let data;
  try { data = await ctx.api.get('/api/admin/support'); } catch { return; }
  const card = panelCard(root, 'support', 'support_agent',
    `SUPPORT INBOX · ${data.openCount || 0} OPEN`);

  const tickets = data.tickets || [];
  if (!tickets.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--mut,#757575);padding:10px 0';
    empty.textContent = 'No open tickets.';
    card.appendChild(empty);
  }
  for (const tk of tickets) {
    const row = el('div', 'display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px dotted var(--dt2,#c6c6c6)');
    const body = el('div', 'flex:1;min-width:0');
    const who = tk.userHandle ? `@${stripAt(tk.userHandle)}` : (tk.email || 'anonymous');
    body.append(
      el('div', "font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.1em;color:var(--fnt,#a3a3a3);margin-bottom:4px",
        `#${tk.id} · ${CAT_LABEL[tk.category] || String(tk.category).toUpperCase()} · ${tk.source === 'system' ? 'SYSTEM' : 'USER'} · ${who}`),
      // textContent throughout → member-supplied text can never inject markup
      el('div', 'font-size:13.5px;line-height:1.5;color:var(--ink,#0a0a0a);word-break:break-word', tk.message));
    row.append(body, btn('CLOSE', BTN_GHOST, async () => {
      try {
        await ctx.api.patch(`/api/admin/support/${tk.id}`, { status: 'closed' });
        ctx.toast(`TICKET #${tk.id} CLOSED`);
        await refreshAll(root, ctx);
      } catch (e) { ctx.errToast(e); }
    }));
    card.appendChild(row);
  }
}

// ---- homepage numbers editor (injected panel) -------------------------------
// The operator can publish curated figures for the public "THE BANK, IN
// NUMBERS" section. Blank fields always show the live ledger value, and the
// homepage labels curated figures as operator-published.
const STAT_FIELDS = [
  ['treasuryUsd', 'DAO TREASURY (USDC)'], ['members', 'MEMBER-OWNERS'],
  ['dividendsPaid', 'DIVIDENDS PAID (USDC)'], ['activeVentures', 'ACTIVE VENTURES'],
  ['proposalsPassed', 'PROPOSALS PASSED'], ['liveVotes', 'LIVE VOTES'], ['topApy', 'TOP APY (%)'],
];

async function renderStatsEditor(root, ctx) {
  let data;
  try { data = await ctx.api.get('/api/admin/stats'); } catch { return; }
  const card = panelCard(root, 'stats', 'tune',
    'HOMEPAGE NUMBERS · THE BANK, IN NUMBERS',
    'Blank fields show the live ledger value (shown as the placeholder). When any figure is set here, the homepage labels the section "Published by the DAO operator" instead of "Computed live from the ledger".');

  const grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px');
  const inputs = {};
  for (const [key, label] of STAT_FIELDS) {
    const inp = input('', 'text');
    inp.inputMode = 'decimal';
    inp.placeholder = data.live[key] == null ? '—' : String(data.live[key]);
    if (data.overrides[key] !== undefined) inp.value = String(data.overrides[key]);
    inputs[key] = inp;
    grid.appendChild(field(label, inp));
  }
  card.appendChild(grid);

  const bar = el('div', 'display:flex;gap:9px;margin-top:16px;flex-wrap:wrap');
  bar.append(
    btn('PUBLISH NUMBERS', BTN_SOLID + ';padding:10px 22px;font-size:12px', async () => {
      const body = {};
      for (const [key] of STAT_FIELDS) {
        const raw = inputs[key].value.trim().replace(/[$,%\s]/g, '');
        if (raw === '') continue;
        if (!Number.isFinite(Number(raw))) { ctx.toast(`${key.toUpperCase()} MUST BE A NUMBER`, 'err'); return; }
        body[key] = Number(raw);
      }
      try {
        await ctx.api.put('/api/admin/stats', body);
        ctx.toast(Object.keys(body).length ? 'HOMEPAGE NUMBERS PUBLISHED' : 'ALL FIGURES BACK TO LIVE VALUES');
        await renderStatsEditor(root, ctx);
      } catch (e) { ctx.errToast(e); }
    }),
    btn('USE LIVE VALUES', BTN_GHOST + ';padding:9px 18px;font-size:12px', async () => {
      try {
        await ctx.api.put('/api/admin/stats', {});
        ctx.toast('ALL FIGURES BACK TO LIVE VALUES');
        await renderStatsEditor(root, ctx);
      } catch (e) { ctx.errToast(e); }
    }));
  card.appendChild(bar);
}

// ---- entry ------------------------------------------------------------------
/**
 * Redraw the whole console. Every mutation calls this rather than patching one
 * panel, so a change that moves two counters (approving a KYC case clears a
 * risk signal, closing a venture changes the overview) can never leave the
 * screen half-stale.
 */
async function refreshAll(root, ctx) {
  ensurePanels(root);
  await load(root, ctx);
  await Promise.all([
    renderVentures(root, ctx),
    renderKyc(root, ctx),
    renderProposals(root, ctx),
    renderRisk(root, ctx),
    renderStatsEditor(root, ctx),
    renderSupport(root, ctx),
  ]);
}

export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    ctx.setAction('demoApprove', (el) => approve(root, ctx, el));
    ctx.setAction('adminHold', () => ctx.toast('HELD FOR NEXT REVIEW CYCLE'));
    ctx.setAction('demoPayout', (el) => signBatch(root, ctx, el));
    ctx.setAction('adminFreeze', (el) => toggleFreeze(root, ctx, el));
    ctx.setAction('adminSearch', () => openSearch(root, ctx));
    ctx.setAction('adminTabConsole', () => root.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    ctx.setAction('adminTabMembers', () => scrollPanel(root, 'members'));
    ctx.setAction('adminTabVentures', () => scrollPanel(root, 'ventures-manage'));
    ctx.setAction('adminTabPayouts', () => scrollPanel(root, 'payouts'));
    ctx.setAction('adminTabKyc', () => scrollPanel(root, 'kyc'));
    ctx.setAction('adminTabProposals', () => scrollPanel(root, 'proposals'));
    ctx.setAction('adminTabRisk', () => scrollPanel(root, 'risk'));
    root.dataset.hydrated = '1';
  }
  await refreshAll(root, ctx);
}
