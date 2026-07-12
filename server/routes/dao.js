import { db, tx, balance, audit } from '../db.js';
import { ApiError, num, round2, requireAuth } from '../lib/util.js';

// Synthetic launch-day vote baseline, keyed by proposal code. Added as constants
// inside the aggregates (never materialized as vote rows) so the seeded OSM-042
// proposal starts near the design split of 68% FOR / 32% AGAINST with a
// plausible voter headcount. `power` participates in quorum; `voters` keeps the
// displayed headcount coherent with the tally instead of reporting 0.
const VOTE_BASELINE = {
  'OSM-042': { for: 10123, against: 4759, voters: 14882 },
};

// Static presentation data for the single open fundraiser (contract allows static).
const USE_OF_FUNDS = [
  { label: '3 new reef sites', amount: 1400000 },
  { label: 'Processing barge', amount: 700000 },
  { label: 'Working capital', amount: 300000 },
];
const UPDATES = [
  { date: '2026-07-08', title: 'Fieldstone diligence audit published', body: 'Independent audit of the Series B diligence report is complete — no exceptions noted.' },
  { date: '2026-07-03', title: 'Processing barge contract signed', body: 'Shipyard slot secured; keel laying scheduled within 30 days of close.' },
  { date: '2026-06-28', title: 'Raise opened to all members', body: 'Backed by proposal OSM-042. Dividends begin Q4 2026 at 11.1% target APY.' },
];

function osmSupply() {
  const row = db.prepare("SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE currency = 'OSM'").get();
  return row?.s ?? 0;
}

function voteTotals(proposal) {
  const agg = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN support = 1 THEN power END), 0) AS forPower,
            COALESCE(SUM(CASE WHEN support = 0 THEN power END), 0) AS againstPower,
            COUNT(*) AS voters
       FROM votes WHERE proposal_id = ?`).get(proposal.id);
  const base = VOTE_BASELINE[proposal.code] || { for: 0, against: 0, voters: 0 };
  return {
    forPower: agg.forPower + base.for,
    againstPower: agg.againstPower + base.against,
    voters: agg.voters + base.voters,
  };
}

function proposalView(proposal, userId) {
  const { forPower, againstPower, voters } = voteTotals(proposal);
  const total = forPower + againstPower;
  // Effective supply floors at the participating power so the synthetic baseline
  // (which is not part of the real OSM ledger) can never push the ratio above 100%.
  const supply = Math.max(osmSupply(), total);
  const mine = db.prepare('SELECT support FROM votes WHERE proposal_id = ? AND user_id = ?')
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

function openFundraiser() {
  return db.prepare("SELECT * FROM fundraisers WHERE status = 'open' ORDER BY id LIMIT 1").get();
}

function fundraiserView(f) {
  const venture = db.prepare('SELECT name FROM ventures WHERE id = ?').get(f.venture_id);
  // The backing proposal: the live proposal that names the venture, falling back
  // to the most recent live proposal (no FK exists in the schema).
  let proposal = venture
    ? db.prepare("SELECT * FROM proposals WHERE status = 'live' AND title LIKE '%' || ? || '%' ORDER BY id DESC LIMIT 1").get(venture.name)
    : null;
  if (!proposal) {
    proposal = db.prepare("SELECT * FROM proposals WHERE status = 'live' ORDER BY datetime(created_at) DESC, id DESC LIMIT 1").get();
  }
  let proposalForPct = null;
  if (proposal) {
    const { forPower, againstPower } = voteTotals(proposal);
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
    useOfFunds: USE_OF_FUNDS,
    updates: UPDATES,
    ventureName: venture?.name ?? null,
    proposalCode: proposal?.code ?? null,
    proposalForPct,
  };
}

export default function mount(app) {
  app.get('/api/proposals', requireAuth, (req, res, next) => {
    try {
      const rows = db.prepare(
        `SELECT * FROM proposals
          ORDER BY CASE WHEN status = 'live' THEN 0 ELSE 1 END,
                   datetime(COALESCE(ends_at, created_at)) DESC, id DESC`).all();
      res.json({ proposals: rows.map((p) => proposalView(p, req.user.id)) });
    } catch (e) { next(e); }
  });

  app.post('/api/proposals/:id/vote', requireAuth, (req, res, next) => {
    try {
      const id = num(req.params.id, { int: true, min: 1, name: 'id' });
      if (typeof req.body?.support !== 'boolean') throw new ApiError(400, 'support must be true or false');
      const support = req.body.support ? 1 : 0;

      const proposal = tx(() => {
        const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
        if (!p) throw new ApiError(404, 'Proposal not found');
        if (p.status !== 'live') throw new ApiError(400, 'Voting on this proposal has closed');
        const power = balance(req.user.id, 'OSM');
        if (power <= 0) throw new ApiError(400, 'You need OSM voting power to vote');
        db.prepare(
          `INSERT INTO votes (proposal_id, user_id, support, power) VALUES (?,?,?,?)
             ON CONFLICT (proposal_id, user_id)
             DO UPDATE SET support = excluded.support, power = excluded.power, created_at = datetime('now')`)
          .run(p.id, req.user.id, support, power);
        audit(req.user.id, 'proposal.vote', `proposal:${p.id}`, support ? 'for' : 'against');
        return p;
      });

      res.json({ proposal: proposalView(proposal, req.user.id) });
    } catch (e) { next(e); }
  });

  app.get('/api/fundraiser', requireAuth, (req, res, next) => {
    try {
      const f = openFundraiser();
      if (!f) throw new ApiError(404, 'No open fundraiser');
      res.json({ fundraiser: fundraiserView(f) });
    } catch (e) { next(e); }
  });

  app.post('/api/fundraiser/contribute', requireAuth, (req, res, next) => {
    try {
      const amount = round2(num(req.body?.amount, { min: 0.01, max: 1e9, name: 'amount' }));

      const fundraiser = tx(() => {
        const f = openFundraiser();
        if (!f) throw new ApiError(404, 'No open fundraiser');
        if (amount < f.min_amount) throw new ApiError(400, `Minimum contribution is ${f.min_amount} USDC`);
        if (balance(req.user.id, 'USDC') < amount) throw new ApiError(400, 'Insufficient USDC balance');

        const firstTime = !db.prepare(
          "SELECT 1 FROM ledger WHERE user_id = ? AND kind = 'contribution' AND ref_type = 'fundraiser' AND ref_id = ? LIMIT 1")
          .get(req.user.id, f.id);
        db.prepare(
          "INSERT INTO ledger (user_id, currency, delta, kind, ref_type, ref_id, memo) VALUES (?,'USDC',?,'contribution','fundraiser',?,?)")
          .run(req.user.id, -amount, f.id, f.title);
        db.prepare('UPDATE fundraisers SET raised = ?, backers = backers + ? WHERE id = ?')
          .run(round2(f.raised + amount), firstTime ? 1 : 0, f.id);
        audit(req.user.id, 'fundraiser.contribute', `fundraiser:${f.id}`, String(amount));
        return db.prepare('SELECT * FROM fundraisers WHERE id = ?').get(f.id);
      });

      res.json({ fundraiser: fundraiserView(fundraiser), balance: balance(req.user.id, 'USDC') });
    } catch (e) { next(e); }
  });
}
