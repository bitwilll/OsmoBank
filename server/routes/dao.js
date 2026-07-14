import { db, tx, balance, audit } from '../db.js';
import { ApiError, num, round2, requireAuth } from '../lib/util.js';

async function osmSupply() {
  const row = await db.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE currency = 'OSM'").get();
  return row?.s ?? 0;
}

// Tallies come from real vote rows only — no synthetic baseline. A young DAO
// honestly shows small numbers.
async function voteTotals(proposal) {
  return await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN support = 1 THEN power END), 0) AS forPower,
            COALESCE(SUM(CASE WHEN support = 0 THEN power END), 0) AS againstPower,
            COUNT(*) AS voters
       FROM votes WHERE proposal_id = ?`).get(proposal.id);
}

async function proposalView(proposal, userId) {
  const { forPower, againstPower, voters } = await voteTotals(proposal);
  const total = forPower + againstPower;
  // Effective supply floors at the participating power so the ratio can never
  // exceed 100% even if ledger rows lag behind recorded votes.
  const supply = Math.max(await osmSupply(), total);
  const mine = await db.prepare('SELECT support FROM votes WHERE proposal_id = ? AND user_id = ?')
    .get(proposal.id, userId);
  return {
    id: proposal.id,
    code: proposal.code,
    title: proposal.title,
    blurb: proposal.blurb,
    status: proposal.status,
    forPct: total > 0 ? round2((forPower / total) * 100) : 0,
    againstPct: total > 0 ? round2((againstPower / total) * 100) : 0,
    voters,
    quorumPct: proposal.quorum_pct,
    quorumReached: supply > 0 && (total / supply) * 100 >= proposal.quorum_pct,
    endsAt: proposal.ends_at,
    yourVote: mine ? Boolean(mine.support) : null,
  };
}

function timeLeft(endsAt) {
  if (!endsAt) return { daysLeft: 0, hoursLeft: 0 };
  const ends = new Date(String(endsAt).replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(ends)) return { daysLeft: 0, hoursLeft: 0 };
  const ms = Math.max(0, ends - Date.now());
  return {
    daysLeft: Math.floor(ms / 86400000),
    hoursLeft: Math.floor((ms % 86400000) / 3600000),
  };
}

async function openFundraiser() {
  return await db.prepare("SELECT * FROM fundraisers WHERE status = 'open' ORDER BY id LIMIT 1").get();
}

async function fundraiserView(f) {
  const venture = await db.prepare('SELECT name, sector FROM ventures WHERE id = ?').get(f.venture_id);
  // The backing proposal: the live proposal that names the venture, falling back
  // to the most recent live proposal (no FK exists in the schema).
  let proposal = venture
    ? await db.prepare("SELECT * FROM proposals WHERE status = 'live' AND title LIKE '%' || ? || '%' ORDER BY id DESC LIMIT 1").get(venture.name)
    : null;
  if (!proposal) {
    proposal = await db.prepare("SELECT * FROM proposals WHERE status = 'live' ORDER BY datetime(created_at) DESC, id DESC LIMIT 1").get();
  }
  let proposalForPct = null;
  if (proposal) {
    const { forPower, againstPower } = await voteTotals(proposal);
    const total = forPower + againstPower;
    proposalForPct = total > 0 ? round2((forPower / total) * 100) : 0;
  }
  const { daysLeft, hoursLeft } = timeLeft(f.ends_at);
  return {
    id: f.id,
    title: f.title,
    blurb: f.blurb,
    target: f.target,
    raised: round2(f.raised),
    backers: f.backers,
    pct: f.target > 0 ? round2((f.raised / f.target) * 100) : 0,
    apy: f.apy,
    minAmount: f.min_amount,
    daysLeft,
    hoursLeft,
    // No fabricated budget lines or progress announcements: these stay empty
    // until real per-fundraiser records exist. The client hides the sections.
    useOfFunds: [],
    updates: [],
    ventureName: venture?.name ?? null,
    sector: venture?.sector ?? null,
    proposalCode: proposal?.code ?? null,
    proposalForPct,
  };
}

export default function mount(app) {
  // Public, real aggregates for the home page — every number is computed from
  // actual rows so the marketing surface can never overstate the DAO.
  app.get('/api/stats', async (_req, res, next) => {
    try {
      const members = (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE status != 'frozen'").get())?.n ?? 0;
      const usdcHeld = (await db.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE currency = 'USDC'").get())?.s ?? 0;
      const dividendsPaid = (await db.prepare(
        "SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE kind = 'dividend' AND delta > 0").get())?.s ?? 0;
      const liveVotes = (await db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'live'").get())?.n ?? 0;
      const proposalsPassed = (await db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'passed'").get())?.n ?? 0;
      const live = await db.prepare("SELECT code FROM proposals WHERE status = 'live' ORDER BY id DESC LIMIT 1").get();
      const topApy = (await db.prepare("SELECT MAX(apy) AS a FROM ventures WHERE status = 'active'").get())?.a ?? null;
      const activeVentures = (await db.prepare("SELECT COUNT(*) AS n FROM ventures WHERE status = 'active'").get())?.n ?? 0;
      res.json({
        members,
        treasuryUsd: round2(usdcHeld),
        dividendsPaid: round2(dividendsPaid),
        liveVotes,
        liveProposalCode: live?.code ?? null,
        proposalsPassed,
        topApy,
        activeVentures,
      });
    } catch (e) { next(e); }
  });

  app.get('/api/proposals', requireAuth, async (req, res, next) => {
    try {
      const rows = await db.prepare(
        `SELECT * FROM proposals
          ORDER BY CASE WHEN status = 'live' THEN 0 ELSE 1 END,
                   datetime(COALESCE(ends_at, created_at)) DESC, id DESC`).all();
      res.json({ proposals: await Promise.all(rows.map((p) => proposalView(p, req.user.id))) });
    } catch (e) { next(e); }
  });

  app.post('/api/proposals/:id/vote', requireAuth, async (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      if (typeof req.body?.support !== 'boolean') throw new ApiError(400, 'support must be true or false');
      const support = req.body.support ? 1 : 0;

      const proposal = await tx(async () => {
        const p = await db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
        if (!p) throw new ApiError(404, 'Proposal not found');
        if (p.status !== 'live') throw new ApiError(400, 'Voting on this proposal has closed');
        const power = await balance(req.user.id, 'OSM');
        if (power <= 0) throw new ApiError(400, 'You need OSM voting power to vote');
        await db.prepare(
          `INSERT INTO votes (proposal_id, user_id, support, power) VALUES (?,?,?,?)
             ON CONFLICT (proposal_id, user_id)
             DO UPDATE SET support = excluded.support, power = excluded.power, created_at = datetime('now')`)
          .run(p.id, req.user.id, support, power);
        await audit(req.user.id, 'proposal.vote', `proposal:${p.id}`, support ? 'for' : 'against');
        return p;
      });

      res.json({ proposal: await proposalView(proposal, req.user.id) });
    } catch (e) { next(e); }
  });

  // Public read: the open raise is marketing-surface content with no member
  // data — anonymous visitors on the home page and fundraiser screen see the
  // same real numbers members do. Contributing still requires auth below.
  app.get('/api/fundraiser', async (_req, res, next) => {
    try {
      const f = await openFundraiser();
      if (!f) throw new ApiError(404, 'No open fundraiser');
      res.json({ fundraiser: await fundraiserView(f) });
    } catch (e) { next(e); }
  });

  app.post('/api/fundraiser/contribute', requireAuth, async (req, res, next) => {
    try {
      const amount = round2(num(req.body?.amount, { min: 0.01, max: 1e9, name: 'amount' }));

      const fundraiser = await tx(async () => {
        const f = await openFundraiser();
        if (!f) throw new ApiError(404, 'No open fundraiser');
        if (amount < f.min_amount) throw new ApiError(400, `Minimum contribution is ${f.min_amount} USDC`);
        if (await balance(req.user.id, 'USDC') < amount) throw new ApiError(400, 'Insufficient USDC balance');

        const firstTime = !(await db.prepare(
          "SELECT 1 FROM ledger WHERE user_id = ? AND kind = 'contribution' AND ref_type = 'fundraiser' AND ref_id = ? LIMIT 1")
          .get(req.user.id, f.id));
        await db.prepare(
          "INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,'USDC',?,'contribution','fundraiser',?,?)")
          .run(req.user.id, -amount, f.id, f.title);
        await db.prepare('UPDATE fundraisers SET raised = ?, backers = backers + ? WHERE id = ?')
          .run(round2(f.raised + amount), firstTime ? 1 : 0, f.id);
        await audit(req.user.id, 'fundraiser.contribute', `fundraiser:${f.id}`, String(amount));
        return await db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(f.id);
      });

      res.json({ fundraiser: await fundraiserView(fundraiser), balance: await balance(req.user.id, 'USDC') });
    } catch (e) { next(e); }
  });
}
