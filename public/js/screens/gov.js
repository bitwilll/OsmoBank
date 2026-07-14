/* Governance screen: live proposal voting, recent proposals, treasury export.
 * Data: GET /api/proposals + ctx.me(); votes via POST /api/proposals/:id/vote. */

// NOTE: tallies from /api/proposals are real votes only (no synthetic
// baseline) — a live proposal can honestly show 0 voters / 0%.

let liveProposal = null; // latest live proposal seen by fill(); used by vote action

function parseDbDate(s) {
  if (!s) return NaN;
  const iso = s.includes('T') || s.includes('Z') ? s : s.replace(' ', 'T') + 'Z';
  return new Date(iso).getTime();
}

function endsIn(endsAt) {
  const t = parseDbDate(endsAt);
  if (!Number.isFinite(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return ' · ENDS SOON';
  const h = Math.floor(ms / 3600000);
  return ` · ENDS ${Math.floor(h / 24)}D ${h % 24}H`;
}

const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));

async function fill(root, ctx) {
  const { fmt } = ctx;
  const put = (name, text) => {
    const el = ctx.slot(root, name);
    if (el) el.textContent = text;
  };

  // YOUR POWER chip — from session, independent of the proposals fetch.
  const power = ctx.me()?.balances?.OSM ?? 0;
  put('gov.power', `${fmt.num(power)} OSM`);

  // Treasury total/allocation are platform-level figures with no member-facing
  // endpoint, so we show a dash rather than a fabricated number (see sharedNeeds).
  put('gov.treasury', '—');

  const { proposals } = await ctx.api.get('/api/proposals');

  // ---- live proposal card ----
  liveProposal = proposals.find((p) => p.status === 'live') || null;
  const p = liveProposal;
  const actions = ctx.slot(root, 'gov.voteActions');
  if (p) {
    put('gov.liveMeta', `${p.code} · LIVE${endsIn(p.endsAt)}`);
    put('gov.quorum', `QUORUM ${fmt.pct(p.quorumPct, 0)} · ${p.quorumReached ? 'REACHED ✓' : 'NOT REACHED'}`);
    put('gov.title', p.title);
    put('gov.blurb', p.blurb);
    const meter = ctx.slot(root, 'gov.meterFor');
    if (meter) meter.style.width = `${clampPct(p.forPct)}%`;
    put('gov.forPct', `FOR ${fmt.pct(p.forPct, 0)}`);
    put('gov.tally', `· AGAINST ${fmt.pct(p.againstPct, 0)} · ${fmt.num(p.voters ?? 0)} VOTERS`);
    if (actions) actions.style.display = 'flex';
  } else {
    // No proposal is open — show an honest empty state instead of the seeded demo.
    put('gov.liveMeta', 'NO LIVE PROPOSAL');
    put('gov.quorum', '');
    put('gov.title', 'No proposals are live right now');
    put('gov.blurb', 'When a member proposal opens for a vote it will appear here — check back soon.');
    const meter = ctx.slot(root, 'gov.meterFor');
    if (meter) meter.style.width = '0%';
    put('gov.forPct', '');
    put('gov.tally', '');
    if (actions) actions.style.display = 'none';
  }
  const chip = ctx.slot(root, 'gov.yourVote');
  if (chip) {
    const yv = p?.yourVote;
    if (yv === null || yv === undefined) {
      chip.style.display = 'none';
    } else {
      chip.textContent = `YOU VOTED ${(yv === true || yv === 1) ? 'FOR' : 'AGAINST'}`;
      chip.style.display = 'inline-flex';
    }
  }

  // ---- recent proposals ----
  const rows = ctx.list(root, 'gov.recent');
  const recentEmpty = ctx.slot(root, 'gov.recentEmpty');
  if (rows) {
    rows.clear();
    const recent = proposals.filter((x) => x.status !== 'live').slice(0, 5);
    rows.el.style.display = recent.length ? '' : 'none';
    if (recentEmpty) recentEmpty.style.display = recent.length ? 'none' : '';
    for (const r of recent) {
      const row = rows.add();
      const status = String(r.status || '').toUpperCase();
      const putRow = (name, text) => {
        const el = ctx.slot(row, name);
        if (el) el.textContent = text;
      };
      putRow('row.title', `${r.code} · ${r.title}`);
      putRow('row.meta', `${fmt.date(r.createdAt || r.endsAt)} · ${status}`);
      const badge = ctx.slot(row, 'row.chip');
      if (badge) {
        badge.textContent = `${status} ${fmt.pct(r.forPct, 0)}`;
        const passed = r.status === 'passed';
        badge.style.color = passed ? 'var(--grn,#17a562)' : 'var(--red,#c47b10)';
        badge.style.borderColor = passed
          ? 'color-mix(in srgb,var(--grn,#17a562) 35%,transparent)'
          : 'var(--reds,#f0b9b5)';
      }
    }
  }
}

async function castVote(root, ctx, support) {
  const p = liveProposal;
  if (!p) return ctx.toast('NO LIVE PROPOSAL OPEN', 'err');
  const revote = p.yourVote !== null && p.yourVote !== undefined;
  try {
    await ctx.api.post(`/api/proposals/${p.id}/vote`, { support });
    await fill(root, ctx);
    const power = ctx.me()?.balances?.OSM ?? 0;
    ctx.toast(revote ? 'VOTE REPLACED' : `VOTE CAST WITH ${ctx.fmt.num(power)} OSM`);
  } catch (e) { ctx.errToast(e); }
}

export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    root.dataset.hydrated = '1';
    ctx.setAction('demoVote', (el) => castVote(root, ctx, el?.dataset?.support !== 'false'));
    ctx.setAction('govReadFull', () => ctx.toast('FULL PROPOSAL TEXT NOT AVAILABLE YET', 'err'));
  }
  try {
    await fill(root, ctx);
  } catch (e) { ctx.errToast(e); }
}
