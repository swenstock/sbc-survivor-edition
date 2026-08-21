// Knockout season lifecycle engine. Pure functions over the real schema and
// the real custodian - no HTTP here (routes will be a thin layer on top of
// this, same split as satelliteSettlementPlanV45.js vs satelliteScheduler.js
// elsewhere in this codebase). Schedule-generation algorithm here is the
// same backtracking approach already verified separately - ported in rather
// than re-derived, since that correctness work is done.

const db = require("./db");
const custodian = require("./custodian");
const { computeLadder } = require("./prizeLadder");
const { getQuotes } = require("./dataProvider");

const CONFERENCES = {
  growth: { tech:['NVDA','AAPL','AMD','CRM'], consumer:['AMZN','TSLA','SBUX','NKE'],
            healthcare:['LLY','UNH','PFE','MRNA'], industrials:['CAT','BA','GE','UPS'] },
  value: { financials:['JPM','BAC','GS','WFC'], energy:['XOM','CVX','SLB','OXY'],
           materials:['LIN','NEM','DOW','FCX'], utilities:['NEE','DUK','SO','AEP'] },
};
const ACTIVATED_STONKBROKER_BACKING = 733332; // matches prizeLadder.js's documented Main Event unit

const RIVAL_SAME = { tech:'consumer', consumer:'tech', healthcare:'industrials', industrials:'healthcare',
                      financials:'energy', energy:'financials', materials:'utilities', utilities:'materials' };
const RIVAL_CROSS = { tech:'financials', consumer:'energy', healthcare:'materials', industrials:'utilities',
                       financials:'tech', energy:'consumer', materials:'healthcare', utilities:'industrials' };

function divisionsOf(conf) { return Object.keys(CONFERENCES[conf]); }
function stocksIn(conf, div) { return CONFERENCES[conf][div]; }
function allStocks() { return Object.values(CONFERENCES).flatMap(c => Object.values(c)).flat(); }

function buildGameList() {
  const pairCount = {};
  const key = (x,y) => [x,y].sort().join('|');
  const add = (x,y,n=1) => { const k=key(x,y); pairCount[k]=(pairCount[k]||0)+n; };
  const degree = {}; for (const s of allStocks()) degree[s]=0;
  const bump = (x,y,n) => { degree[x]+=n; degree[y]+=n; };
  const processed = new Set();
  for (const conf of Object.keys(CONFERENCES)) {
    for (const div of divisionsOf(conf)) {
      const team = stocksIn(conf, div);
      for (let i=0;i<team.length;i++) for (let j=i+1;j<team.length;j++) { add(team[i],team[j],2); bump(team[i],team[j],2); }
      const sameKey = [conf+':'+div, conf+':'+RIVAL_SAME[div]].sort().join('~');
      if (!processed.has(sameKey)) { processed.add(sameKey);
        for (const s of team) for (const r of stocksIn(conf, RIVAL_SAME[div])) { add(s,r,1); bump(s,r,1); } }
      const otherConf = conf==='growth'?'value':'growth';
      const crossKey = [conf+':'+div, otherConf+':'+RIVAL_CROSS[div]].sort().join('~');
      if (!processed.has(crossKey)) { processed.add(crossKey);
        for (const s of team) for (const r of stocksIn(otherConf, RIVAL_CROSS[div])) { add(s,r,1); bump(s,r,1); } }
    }
  }
  let guard = 0;
  while (Object.values(degree).some(d => d < 17)) {
    if (guard++ > 500) throw new Error('Schedule +3 pass did not converge');
    const needy = allStocks().filter(s => degree[s] < 17).sort((a,b)=>degree[a]-degree[b]);
    const s = needy[0];
    const candidate = needy.slice(1).find(o => !(key(s,o) in pairCount));
    if (!candidate) throw new Error(`No valid opponent left for ${s}`);
    add(s, candidate, 1); bump(s, candidate, 1);
  }
  const games = [];
  for (const k in pairCount) { const [a,b]=k.split('|'); for (let n=0;n<pairCount[k];n++) games.push({a,b}); }
  return games;
}

function assignRounds(games, rounds=18) {
  const roundOf = new Array(games.length).fill(-1);
  const busy = Array.from({length: rounds}, () => new Set());
  function candidateRounds(g) {
    const out = [];
    for (let r=0;r<rounds;r++) if (!busy[r].has(g.a) && !busy[r].has(g.b)) out.push(r);
    return out;
  }
  function place(i) {
    if (i === games.length) return true;
    let bestIdx=-1, bestCands=null;
    for (let j=i;j<games.length;j++) {
      const cands = candidateRounds(games[j]);
      if (cands.length === 0) return false;
      if (!bestCands || cands.length < bestCands.length) { bestCands=cands; bestIdx=j; }
    }
    [games[i], games[bestIdx]] = [games[bestIdx], games[i]];
    for (const r of bestCands) {
      busy[r].add(games[i].a); busy[r].add(games[i].b);
      roundOf[i] = r;
      if (place(i+1)) return true;
      busy[r].delete(games[i].a); busy[r].delete(games[i].b);
    }
    return false;
  }
  if (!place(0)) throw new Error('Backtracking search failed to find a valid schedule - should be impossible by Vizing\'s theorem for this graph');
  const schedule = Array.from({length: rounds}, () => []);
  games.forEach((g,i) => schedule[roundOf[i]].push(g));
  return schedule;
}

// Snapshots the real current price for every stock playing in this round -
// the reference point that round's move gets measured from. Must be called
// when a round opens, before resolveRound/resolvePlayoffRound is called for
// it, or there's nothing to measure the move against.
function openRound({ seasonId, roundNumber }) {
  const games = db.prepare('SELECT * FROM knockout_schedule WHERE season_id=? AND round_number=?').all(seasonId, roundNumber);
  if (games.length === 0) throw new Error(`No games scheduled for season ${seasonId} round ${roundNumber}`);
  const tickers = [...new Set(games.flatMap(g => [g.stock_a, g.stock_b]))];
  const quotes = getQuotes(tickers);
  const priceByTicker = Object.fromEntries(quotes.map(q => [q.symbol, q.price]));
  const missing = tickers.filter(t => priceByTicker[t] === undefined);
  if (missing.length) throw new Error(`No quote available for: ${missing.join(', ')}`);

  db.exec('BEGIN');
  try {
    for (const g of games) {
      db.prepare('UPDATE knockout_schedule SET stock_a_open_price=?, stock_b_open_price=?, opened_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(priceByTicker[g.stock_a], priceByTicker[g.stock_b], g.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { seasonId, roundNumber, opened: games.length };
}

// Real % move since the round opened, not since each stock's fixed base
// price - that distinction matters starting with round 2, since a stock can
// have drifted a long way from its base by then and that drift has nothing
// to do with who's winning THIS round.
function computeRealPriceMoves({ seasonId, roundNumber }) {
  const games = db.prepare('SELECT * FROM knockout_schedule WHERE season_id=? AND round_number=?').all(seasonId, roundNumber);
  const missingOpen = games.filter(g => g.stock_a_open_price == null || g.stock_b_open_price == null);
  if (missingOpen.length) throw new Error(`Round ${roundNumber} was never opened (openRound() must run first) - ${missingOpen.length} game(s) missing an open price`);
  const tickers = [...new Set(games.flatMap(g => [g.stock_a, g.stock_b]))];
  const quotes = getQuotes(tickers);
  const currentPriceByTicker = Object.fromEntries(quotes.map(q => [q.symbol, q.price]));

  const openPriceByTicker = {};
  for (const g of games) { openPriceByTicker[g.stock_a] = g.stock_a_open_price; openPriceByTicker[g.stock_b] = g.stock_b_open_price; }

  const priceMoves = {};
  for (const t of tickers) {
    const open = openPriceByTicker[t], current = currentPriceByTicker[t];
    if (current === undefined) throw new Error(`No current quote for ${t}`);
    priceMoves[t] = ((current - open) / open) * 100;
  }
  return priceMoves;
}

// ---- Season lifecycle ----

function createSeason({ cadence, entryFeeStonk, enrollmentOpensAt, enrollmentClosesAt, seasonStartsAt }) {
  const seasonId = db.prepare(`
    INSERT INTO knockout_seasons (cadence, entry_fee_stonk, enrollment_opens_at, enrollment_closes_at, season_starts_at)
    VALUES (?,?,?,?,?) RETURNING id
  `).get(cadence, entryFeeStonk, enrollmentOpensAt, enrollmentClosesAt, seasonStartsAt).id;

  const insertStock = db.prepare('INSERT INTO knockout_stocks (season_id, ticker, conference, division) VALUES (?,?,?,?)');
  for (const conf of Object.keys(CONFERENCES)) {
    for (const div of divisionsOf(conf)) {
      for (const ticker of stocksIn(conf, div)) insertStock.run(seasonId, ticker, conf, div);
    }
  }

  const schedule = assignRounds(buildGameList());
  const insertGame = db.prepare('INSERT INTO knockout_schedule (season_id, round_number, phase, stock_a, stock_b) VALUES (?,?,?,?,?)');
  schedule.forEach((round, i) => { for (const g of round) insertGame.run(seasonId, i+1, 'regular', g.a, g.b); });

  return { seasonId, totalGames: schedule.flat().length };
}

function enterSeason({ seasonId, accountId }) {
  const season = db.prepare('SELECT * FROM knockout_seasons WHERE id=?').get(seasonId);
  if (!season) throw new Error(`No season ${seasonId}`);
  if (season.status !== 'enrolling') throw new Error(`Season ${seasonId} is not accepting entries (status: ${season.status})`);

  db.exec('BEGIN');
  try {
    custodian.debit(accountId, season.entry_fee_stonk, 'knockout_entry', { referenceType: 'knockout_season', referenceId: seasonId });
    const entryId = db.prepare('INSERT INTO knockout_entries (season_id, account_id, entry_fee_paid) VALUES (?,?,?) RETURNING id')
      .get(seasonId, accountId, season.entry_fee_stonk).id;
    db.prepare('UPDATE knockout_seasons SET pot_stonk = pot_stonk + ? WHERE id=?').run(season.entry_fee_stonk, seasonId);
    db.exec('COMMIT');
    return { entryId };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function submitPick({ entryId, roundNumber, stockTicker }) {
  const entry = db.prepare('SELECT * FROM knockout_entries WHERE id=?').get(entryId);
  if (!entry) throw new Error(`No entry ${entryId}`);
  if (!entry.alive) throw new Error(`Entry ${entryId} is eliminated, cannot pick`);
  const inSchedule = db.prepare(`
    SELECT 1 FROM knockout_schedule WHERE season_id=? AND round_number=? AND (stock_a=? OR stock_b=?)
  `).get(entry.season_id, roundNumber, stockTicker, stockTicker);
  if (!inSchedule) throw new Error(`${stockTicker} is not playing in round ${roundNumber}`);
  const alreadyUsed = db.prepare('SELECT 1 FROM knockout_picks WHERE entry_id=? AND stock_ticker=?').get(entryId, stockTicker);
  if (alreadyUsed) throw new Error(`Entry ${entryId} has already used ${stockTicker} this season`);
  const alreadyPickedRound = db.prepare('SELECT 1 FROM knockout_picks WHERE entry_id=? AND round_number=?').get(entryId, roundNumber);
  if (alreadyPickedRound) throw new Error(`Entry ${entryId} already picked for round ${roundNumber}`);
  return db.prepare('INSERT INTO knockout_picks (entry_id, round_number, stock_ticker) VALUES (?,?,?) RETURNING id')
    .get(entryId, roundNumber, stockTicker).id;
}

function resolveRound({ seasonId, roundNumber, priceMoves }) {
  const moves = priceMoves || computeRealPriceMoves({ seasonId, roundNumber });
  db.exec('BEGIN');
  try {
    const games = db.prepare('SELECT * FROM knockout_schedule WHERE season_id=? AND round_number=?').all(seasonId, roundNumber);
    for (const g of games) {
      const pa = moves[g.stock_a], pb = moves[g.stock_b];
      if (pa === undefined || pb === undefined) throw new Error(`Missing price move for ${g.stock_a} or ${g.stock_b}`);
      const winner = pa >= pb ? g.stock_a : g.stock_b;
      db.prepare('UPDATE knockout_schedule SET stock_a_pct_move=?, stock_b_pct_move=?, winner_ticker=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(pa, pb, winner, g.id);
    }

    const picks = db.prepare(`
      SELECT p.*, e.season_id FROM knockout_picks p
      JOIN knockout_entries e ON e.id = p.entry_id
      WHERE e.season_id=? AND p.round_number=?
    `).all(seasonId, roundNumber);
    for (const pick of picks) {
      const game = games.find(g => g.stock_a === pick.stock_ticker || g.stock_b === pick.stock_ticker);
      const won = db.prepare('SELECT winner_ticker FROM knockout_schedule WHERE id=?').get(game.id).winner_ticker === pick.stock_ticker;
      db.prepare("UPDATE knockout_picks SET result=? WHERE id=?").run(won ? 'win' : 'loss', pick.id);
      if (!won) db.prepare('UPDATE knockout_entries SET alive=0, eliminated_round=? WHERE id=?').run(roundNumber, pick.entry_id);
    }

    db.prepare('UPDATE knockout_seasons SET current_round=? WHERE id=?').run(roundNumber + 1, seasonId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const season = db.prepare('SELECT * FROM knockout_seasons WHERE id=?').get(seasonId);
  if (roundNumber === season.total_regular_rounds) return seedPlayoffs({ seasonId });
  return { seasonId, roundNumber, status: 'regular' };
}

function standingsFor(seasonId, conf) {
  const stocks = db.prepare('SELECT ticker, division FROM knockout_stocks WHERE season_id=? AND conference=?').all(seasonId, conf);
  return stocks.map(({ ticker, division }) => {
    const wins = db.prepare('SELECT COUNT(*) n FROM knockout_schedule WHERE season_id=? AND phase=\'regular\' AND winner_ticker=?').get(seasonId, ticker).n;
    const played = db.prepare(`SELECT COUNT(*) n FROM knockout_schedule WHERE season_id=? AND phase='regular' AND (stock_a=? OR stock_b=?) AND winner_ticker IS NOT NULL`).get(seasonId, ticker, ticker).n;
    return { ticker, division, wins, losses: played - wins, pct: played ? wins/played : 0 };
  });
}

function seedPlayoffs({ seasonId }) {
  db.exec('BEGIN');
  try {
    const insertSeed = db.prepare('INSERT INTO knockout_playoff_seeds (season_id, conference, seed, ticker, wins, losses) VALUES (?,?,?,?,?,?)');
    const seeds = {};
    for (const conf of Object.keys(CONFERENCES)) {
      const standings = standingsFor(seasonId, conf);
      const winners = divisionsOf(conf)
        .map(div => standings.filter(s=>s.division===div).sort((a,b)=>b.pct-a.pct)[0])
        .sort((a,b)=>b.pct-a.pct);
      const winnerTickers = new Set(winners.map(w=>w.ticker));
      const wildcards = standings.filter(s=>!winnerTickers.has(s.ticker)).sort((a,b)=>b.pct-a.pct).slice(0,3);
      seeds[conf] = [...winners, ...wildcards];
      seeds[conf].forEach((s,i) => insertSeed.run(seasonId, conf, i+1, s.ticker, s.wins, s.losses));
    }
    // Wild card round: 1-seed byes, 2v7 3v6 4v5, for both conferences.
    const insertGame = db.prepare('INSERT INTO knockout_schedule (season_id, round_number, phase, stock_a, stock_b) VALUES (?,?,?,?,?)');
    const wcRound = 19;
    for (const conf of Object.keys(CONFERENCES)) {
      const s = seeds[conf].map(x=>x.ticker);
      insertGame.run(seasonId, wcRound, 'wildcard', s[1], s[6]);
      insertGame.run(seasonId, wcRound, 'wildcard', s[2], s[5]);
      insertGame.run(seasonId, wcRound, 'wildcard', s[3], s[4]);
    }
    db.prepare("UPDATE knockout_seasons SET status='playoffs', current_round=? WHERE id=?").run(wcRound, seasonId);
    db.exec('COMMIT');
    return { seasonId, status: 'playoffs', seeds };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const NEXT_PHASE = { wildcard: 'divisional', divisional: 'conference', conference: 'superbowl' };
const PHASE_ROUND = { wildcard: 19, divisional: 20, conference: 21, superbowl: 22 };

function resolvePlayoffRound({ seasonId, phase, priceMoves }) {
  const roundNumber = PHASE_ROUND[phase];
  const moves = priceMoves || computeRealPriceMoves({ seasonId, roundNumber });
  db.exec('BEGIN');
  try {
    const games = db.prepare('SELECT * FROM knockout_schedule WHERE season_id=? AND round_number=?').all(seasonId, roundNumber);
    const winners = {};
    for (const g of games) {
      const pa = moves[g.stock_a], pb = moves[g.stock_b];
      if (pa === undefined || pb === undefined) throw new Error(`Missing price move for ${g.stock_a} or ${g.stock_b}`);
      const winner = pa >= pb ? g.stock_a : g.stock_b;
      db.prepare('UPDATE knockout_schedule SET stock_a_pct_move=?, stock_b_pct_move=?, winner_ticker=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(pa, pb, winner, g.id);
      winners[g.stock_a+'|'+g.stock_b] = winner;
    }
    const picks = db.prepare(`
      SELECT p.*, e.season_id FROM knockout_picks p JOIN knockout_entries e ON e.id=p.entry_id
      WHERE e.season_id=? AND p.round_number=?
    `).all(seasonId, roundNumber);
    for (const pick of picks) {
      const game = games.find(g => g.stock_a === pick.stock_ticker || g.stock_b === pick.stock_ticker);
      const won = db.prepare('SELECT winner_ticker FROM knockout_schedule WHERE id=?').get(game.id).winner_ticker === pick.stock_ticker;
      db.prepare('UPDATE knockout_picks SET result=? WHERE id=?').run(won?'win':'loss', pick.id);
      if (!won) db.prepare('UPDATE knockout_entries SET alive=0, eliminated_round=? WHERE id=?').run(roundNumber, pick.entry_id);
    }

    if (phase === 'superbowl') {
      db.prepare("UPDATE knockout_seasons SET champion_ticker=? WHERE id=?").run(Object.values(winners)[0], seasonId);
      db.exec('COMMIT');
      return settleSeason({ seasonId, reason: 'champion' });
    }

    // Build next round from THIS round's winners, seeded correctly:
    // divisional = 1-seed vs the lowest remaining seed, other two winners play each other;
    // conference = the two divisional winners, one per conference.
    const nextPhase = NEXT_PHASE[phase];
    const nextRound = PHASE_ROUND[nextPhase];
    const insertGame = db.prepare('INSERT INTO knockout_schedule (season_id, round_number, phase, stock_a, stock_b) VALUES (?,?,?,?,?)');

    if (nextPhase === 'divisional') {
      for (const conf of Object.keys(CONFERENCES)) {
        const seeds = db.prepare('SELECT seed, ticker FROM knockout_playoff_seeds WHERE season_id=? AND conference=? ORDER BY seed').all(seasonId, conf);
        const seedOf = t => seeds.find(s=>s.ticker===t)?.seed ?? 99;
        const confWinners = Object.entries(winners).filter(([k]) => {
          const [a,b] = k.split('|'); return seeds.some(s=>s.ticker===a) && seeds.some(s=>s.ticker===b);
        }).map(([,w]) => w);
        const sorted = confWinners.sort((a,b)=>seedOf(b)-seedOf(a));
        const lowestSeedWinner = sorted[0];
        const others = confWinners.filter(w=>w!==lowestSeedWinner);
        const oneSeed = seeds.find(s=>s.seed===1).ticker;
        insertGame.run(seasonId, nextRound, 'divisional', oneSeed, lowestSeedWinner);
        insertGame.run(seasonId, nextRound, 'divisional', others[0], others[1]);
      }
    } else if (nextPhase === 'conference') {
      // Divisional round has 4 winners, 2 per conference. Each conference's
      // OWN 2 winners play each other - two separate championship games,
      // not one game pulled arbitrarily across conferences.
      for (const conf of Object.keys(CONFERENCES)) {
        const seeds = db.prepare('SELECT ticker FROM knockout_playoff_seeds WHERE season_id=? AND conference=?').all(seasonId, conf).map(r=>r.ticker);
        const confWinners = Object.entries(winners).filter(([k]) => {
          const [a,b] = k.split('|'); return seeds.includes(a) && seeds.includes(b);
        }).map(([,w]) => w);
        insertGame.run(seasonId, nextRound, 'conference', confWinners[0], confWinners[1]);
      }
    } else if (nextPhase === 'superbowl') {
      // Conference round resolves to exactly 2 winners now (one per
      // conference championship), so this pairing is unambiguous.
      const confChamps = Object.values(winners);
      insertGame.run(seasonId, nextRound, 'superbowl', confChamps[0], confChamps[1]);
    }
    db.prepare('UPDATE knockout_seasons SET current_round=? WHERE id=?').run(nextRound, seasonId);
    db.exec('COMMIT');
    return { seasonId, phase: nextPhase, roundNumber: nextRound };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function voteSplit({ entryId, roundNumber }) {
  const entry = db.prepare('SELECT * FROM knockout_entries WHERE id=?').get(entryId);
  if (!entry || !entry.alive) throw new Error(`Entry ${entryId} not alive, cannot vote to split`);
  db.prepare('INSERT OR IGNORE INTO knockout_split_votes (entry_id, round_number) VALUES (?,?)').run(entryId, roundNumber);
  return checkSplitConsensus({ seasonId: entry.season_id });
}

function checkSplitConsensus({ seasonId }) {
  const alive = db.prepare('SELECT COUNT(*) n FROM knockout_entries WHERE season_id=? AND alive=1').get(seasonId).n;
  const votes = db.prepare(`
    SELECT COUNT(*) n FROM knockout_split_votes sv JOIN knockout_entries e ON e.id=sv.entry_id
    WHERE e.season_id=? AND e.alive=1
  `).get(seasonId).n;
  if (alive > 0 && votes === alive) return settleSeason({ seasonId, reason: 'split' });
  return { seasonId, aliveCount: alive, splitVotes: votes, settled: false };
}

// Reuses the exact same fund-whole-units-then-remainder algorithm as the
// Main Event and every satellite - one function, same as prizeLadder.js
// documents, just applied to this pot with this unit cost.
function settleSeason({ seasonId, reason }) {
  const season = db.prepare('SELECT * FROM knockout_seasons WHERE id=?').get(seasonId);
  const winners = reason === 'split'
    ? db.prepare('SELECT account_id FROM knockout_entries WHERE season_id=? AND alive=1').all(seasonId)
    : db.prepare('SELECT account_id FROM knockout_entries WHERE season_id=? AND alive=1').all(seasonId);

  db.exec('BEGIN');
  try {
    if (winners.length === 0) {
      // Everyone eliminated before a natural champion or split - pay out to
      // whoever survived furthest, split evenly among ties at that round.
      const furthest = db.prepare('SELECT MAX(eliminated_round) r FROM knockout_entries WHERE season_id=?').get(seasonId).r;
      const consolation = db.prepare('SELECT account_id FROM knockout_entries WHERE season_id=? AND eliminated_round=?').all(seasonId, furthest);
      const each = Math.round((season.pot_stonk * 0.85) / consolation.length); // same 15% platform rake as everywhere else
      for (const w of consolation) custodian.credit(w.account_id, each, 'knockout_wipeout_consolation', { referenceType: 'knockout_season', referenceId: seasonId });
      db.prepare("UPDATE knockout_seasons SET status='complete', settled_at=CURRENT_TIMESTAMP WHERE id=?").run(seasonId);
      db.exec('COMMIT');
      return { seasonId, reason: 'wipeout_consolation', paidTo: consolation.length, each };
    }

    const netPool = Math.round(season.pot_stonk * 0.85);
    const { unitsFunded, remainder } = computeLadder(netPool, ACTIVATED_STONKBROKER_BACKING);
    if (unitsFunded >= 1 && winners.length === 1) {
      // Sole champion, pot funds at least one Activated Stonk Broker.
      custodian.credit(winners[0].account_id, netPool, 'knockout_champion', { referenceType: 'knockout_season', referenceId: seasonId });
    } else {
      const each = Math.round(netPool / winners.length);
      for (const w of winners) custodian.credit(w.account_id, each, `knockout_${reason}`, { referenceType: 'knockout_season', referenceId: seasonId });
    }
    db.prepare("UPDATE knockout_seasons SET status='complete', settled_at=CURRENT_TIMESTAMP WHERE id=?").run(seasonId);
    db.exec('COMMIT');
    return { seasonId, reason, paidTo: winners.length, netPool };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = {
  CONFERENCES, allStocks, divisionsOf, stocksIn,
  createSeason, enterSeason, submitPick, openRound, resolveRound,
  standingsFor, seedPlayoffs, resolvePlayoffRound,
  voteSplit, checkSplitConsensus, settleSeason,
};
