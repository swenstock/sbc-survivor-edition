// Knockout scheduler. Same tick()/start() pattern as contestScheduler.js and
// satelliteScheduler.js - one interval loop that opens/resolves whatever's
// due, driven by the shared test clock so SIM and LIVE time both work the
// same way everything else in this codebase already does.
//
// KNOWN SIMPLIFICATION: round length is a fixed duration from the cadence
// (7 days / 1 day / 1 hour), skipping weekends via the existing isWeekday
// helper for daily and hourly cadences. This does not yet align hourly
// rounds to actual market-open clock hours the way satellites.js's
// nextOccurrence() does for Degen Hours - a real hourly knockout round
// could currently open at, say, 2:37pm rather than on the hour. Fine for
// getting rounds to advance automatically at all; worth tightening to match
// real trading-hour boundaries before an hourly cadence actually launches.

const db = require("./db");
const { getNow } = require("./testClock");
const { isWeekday } = require("./timeHelpers");
const engine = require("./knockoutEngine");

const ROUND_DURATION_MS = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  hourly: 60 * 60 * 1000,
};

function addRoundDuration(date, cadence) {
  let next = new Date(date.getTime() + ROUND_DURATION_MS[cadence]);
  if (cadence !== "weekly") {
    // Daily/hourly rounds skip non-trading days entirely rather than
    // opening a round nobody's market can move in.
    while (!isWeekday(next)) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  }
  return next;
}

function roundWindow(season, roundNumber) {
  let opensAt = new Date(season.season_starts_at);
  for (let r = 1; r < roundNumber; r++) opensAt = addRoundDuration(opensAt, season.cadence);
  const closesAt = addRoundDuration(opensAt, season.cadence);
  return { opensAt, closesAt };
}

function advanceSeason(season, now) {
  const round = season.current_round || 1;
  const phase = round <= season.total_regular_rounds ? "regular"
    : { 19: "wildcard", 20: "divisional", 21: "conference", 22: "superbowl" }[round];
  if (!phase) return; // already complete or in an unexpected state - leave alone rather than guess

  const { opensAt, closesAt } = roundWindow(season, round);

  const alreadyOpened = db.prepare(
    "SELECT COUNT(*) n FROM knockout_schedule WHERE season_id=? AND round_number=? AND opened_at IS NOT NULL"
  ).get(season.id, round).n > 0;
  if (!alreadyOpened && now.getTime() >= opensAt.getTime()) {
    try { engine.openRound({ seasonId: season.id, roundNumber: round }); }
    catch (e) { console.error(`[knockoutScheduler] failed to open season ${season.id} round ${round}: ${e.message}`); }
    return; // one action per tick per season - resolve happens on a later tick once closesAt passes
  }

  if (alreadyOpened && now.getTime() >= closesAt.getTime()) {
    try {
      if (phase === "regular") engine.resolveRound({ seasonId: season.id, roundNumber: round });
      else engine.resolvePlayoffRound({ seasonId: season.id, phase });
    } catch (e) {
      console.error(`[knockoutScheduler] failed to resolve season ${season.id} round ${round}: ${e.message}`);
    }
  }
}

function tick(now = getNow()) {
  // Enrollment -> regular_season transition: once enrollment closes, the
  // season is live and its rounds start advancing.
  db.prepare(
    "UPDATE knockout_seasons SET status='regular_season' WHERE status='enrolling' AND enrollment_closes_at <= ?"
  ).run(now.toISOString());

  const active = db.prepare(
    "SELECT * FROM knockout_seasons WHERE status IN ('regular_season','playoffs')"
  ).all();
  for (const season of active) advanceSeason(season, now);
}

function start() {
  tick();
  const interval = setInterval(() => tick(), 15000);
  interval.unref?.();
}

module.exports = { start, tick, roundWindow };
