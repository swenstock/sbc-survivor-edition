const express = require("express");
const router = express.Router();
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const engine = require("../knockoutEngine");
const { listSymbols, getQuotes } = require("../dataProvider");

// Same minimal admin gate as routes/admin.js - a comma-separated allowlist
// via env var. Not shared/imported from admin.js since that file doesn't
// export it; kept self-contained, matching how other route files each own
// their small helpers rather than reaching into each other.
function requireAdmin(req, res, next) {
  const allowlist = (process.env.ADMIN_EMAILS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.length || !allowlist.includes((req.user.email || "").toLowerCase())) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ---- Browsing: no auth required, same as satellites' public listing ----

router.get("/seasons", (req, res) => {
  const seasons = db.prepare(`
    SELECT s.id, s.cadence, s.tier, s.entry_fee_stonk, s.status, s.current_round, s.total_regular_rounds,
           s.enrollment_opens_at, s.enrollment_closes_at, s.season_starts_at, s.pot_stonk, s.champion_ticker,
           (SELECT COUNT(*) FROM knockout_entries e WHERE e.season_id = s.id) AS entry_count,
           (SELECT COUNT(*) FROM knockout_entries e WHERE e.season_id = s.id AND e.alive = 1) AS alive_count
    FROM knockout_seasons s ORDER BY s.season_starts_at DESC LIMIT 50
  `).all();
  res.json({ seasons, tiers: engine.TIERS });
});

// The actual fix for "who's alive belongs inside the season being watched,
// not on the homepage" - a roster scoped to exactly one season. Display
// names only, never emails - same privacy posture as the main SBC's public
// leaderboards. Alive entries first, then eliminated ones ordered by how
// far they got (furthest first), same convention real survivor pools use.
router.get("/seasons/:id/entries", (req, res) => {
  const season = db.prepare("SELECT id FROM knockout_seasons WHERE id=?").get(req.params.id);
  if (!season) return res.status(404).json({ error: "Season not found" });
  const entries = db.prepare(`
    SELECT u.display_name AS displayName, e.alive, e.eliminated_round AS eliminatedRound
    FROM knockout_entries e
    JOIN accounts a ON a.id = e.account_id
    JOIN users u ON u.id = a.user_id
    WHERE e.season_id = ?
    ORDER BY e.alive DESC, e.eliminated_round DESC, e.joined_at ASC
  `).all(req.params.id);
  res.json({ entries });
});

router.get("/seasons/:id", (req, res) => {
  const season = db.prepare("SELECT * FROM knockout_seasons WHERE id=?").get(req.params.id);
  if (!season) return res.status(404).json({ error: "Season not found" });
  const roster = db.prepare("SELECT ticker, conference, division FROM knockout_stocks WHERE season_id=?").all(season.id);
  const schedule = db.prepare("SELECT round_number, phase, stock_a, stock_b, winner_ticker, stock_a_pct_move, stock_b_pct_move FROM knockout_schedule WHERE season_id=? ORDER BY round_number").all(season.id);

  const logoByTicker = Object.fromEntries(listSymbols().map(s => [s.symbol, s.logoUrl]));
  roster.forEach(r => { r.logoUrl = logoByTicker[r.ticker] || null; });

  res.json({ season, roster, schedule });
});

router.get("/seasons/:id/standings", (req, res) => {
  const season = db.prepare("SELECT id FROM knockout_seasons WHERE id=?").get(req.params.id);
  if (!season) return res.status(404).json({ error: "Season not found" });
  res.json({
    growth: engine.standingsFor(season.id, "growth"),
    value: engine.standingsFor(season.id, "value"),
  });
});

// ---- Player actions: require auth ----

router.post("/seasons/:id/enter", requireAuth, (req, res) => {
  const season = db.prepare("SELECT * FROM knockout_seasons WHERE id=?").get(req.params.id);
  if (!season) return res.status(404).json({ error: "Season not found" });
  if (season.status !== "enrolling") return res.status(400).json({ error: "This season is not open for entries" });
  if (req.account.stonk_balance < season.entry_fee_stonk) return res.status(400).json({ error: "Not enough STONK to enter" });
  const existing = db.prepare("SELECT id FROM knockout_entries WHERE season_id=? AND account_id=?").get(season.id, req.account.id);
  if (existing) return res.status(400).json({ error: "Already entered this season" });

  try {
    const { entryId } = engine.enterSeason({ seasonId: season.id, accountId: req.account.id });
    res.status(201).json({ entryId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get("/seasons/:id/my-entry", requireAuth, (req, res) => {
  const entry = db.prepare("SELECT * FROM knockout_entries WHERE season_id=? AND account_id=?").get(req.params.id, req.account.id);
  if (!entry) return res.status(404).json({ error: "You have not entered this season" });

  const season = db.prepare("SELECT * FROM knockout_seasons WHERE id=?").get(req.params.id);
  const picks = db.prepare("SELECT round_number, stock_ticker, result FROM knockout_picks WHERE entry_id=? ORDER BY round_number").all(entry.id);
  const usedTickers = new Set(picks.map(p => p.stock_ticker));

  const currentRoundGames = db.prepare(
    "SELECT stock_a, stock_b FROM knockout_schedule WHERE season_id=? AND round_number=?"
  ).all(season.id, season.current_round || 1);
  const availableThisRound = [...new Set(currentRoundGames.flatMap(g => [g.stock_a, g.stock_b]))]
    .filter(t => !usedTickers.has(t));
  const alreadyPickedThisRound = picks.find(p => p.round_number === season.current_round);

  res.json({
    entry: { id: entry.id, alive: !!entry.alive, eliminatedRound: entry.eliminated_round },
    picks,
    availableThisRound: alreadyPickedThisRound ? [] : availableThisRound,
    alreadyPickedThisRound: alreadyPickedThisRound || null,
  });
});

router.post("/seasons/:id/picks", requireAuth, (req, res) => {
  const entry = db.prepare("SELECT * FROM knockout_entries WHERE season_id=? AND account_id=?").get(req.params.id, req.account.id);
  if (!entry) return res.status(404).json({ error: "You have not entered this season" });
  const { roundNumber, stockTicker } = req.body || {};
  if (!roundNumber || !stockTicker) return res.status(400).json({ error: "roundNumber and stockTicker are required" });

  try {
    const pickId = engine.submitPick({ entryId: entry.id, roundNumber, stockTicker });
    res.status(201).json({ pickId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/seasons/:id/split-vote", requireAuth, (req, res) => {
  const entry = db.prepare("SELECT * FROM knockout_entries WHERE season_id=? AND account_id=?").get(req.params.id, req.account.id);
  if (!entry) return res.status(404).json({ error: "You have not entered this season" });
  const season = db.prepare("SELECT current_round FROM knockout_seasons WHERE id=?").get(req.params.id);

  try {
    const result = engine.voteSplit({ entryId: entry.id, roundNumber: season.current_round });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Admin: season creation and manual round resolution ----
// Manual resolution stays available for ops even after a scheduler exists
// (matches admin.js's philosophy of trusted override access), not gated to
// TEST_MODE-only like routes/dev.js, since this may legitimately be needed
// in production if the scheduler misses a beat.

router.post("/seasons", requireAuth, requireAdmin, (req, res) => {
  const { cadence, entryFeeStonk, enrollmentOpensAt, enrollmentClosesAt, seasonStartsAt } = req.body || {};
  if (!cadence || !entryFeeStonk || !enrollmentOpensAt || !enrollmentClosesAt || !seasonStartsAt) {
    return res.status(400).json({ error: "cadence, entryFeeStonk, enrollmentOpensAt, enrollmentClosesAt, seasonStartsAt are all required" });
  }
  try {
    const result = engine.createSeason({ cadence, entryFeeStonk, enrollmentOpensAt, enrollmentClosesAt, seasonStartsAt });
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/seasons/:id/open-round", requireAuth, requireAdmin, (req, res) => {
  const { roundNumber } = req.body || {};
  if (!roundNumber) return res.status(400).json({ error: "roundNumber is required" });
  try {
    const result = engine.openRound({ seasonId: req.params.id, roundNumber });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/seasons/:id/resolve-round", requireAuth, requireAdmin, (req, res) => {
  // priceMoves is an optional override for testing/manual correction - by
  // default the engine computes real moves from actual quotes since the
  // round was opened, which is what the scheduler will rely on.
  const { roundNumber, phase, priceMoves } = req.body || {};
  try {
    const result = phase
      ? engine.resolvePlayoffRound({ seasonId: req.params.id, phase, priceMoves })
      : engine.resolveRound({ seasonId: req.params.id, roundNumber, priceMoves });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
