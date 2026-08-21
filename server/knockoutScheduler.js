// Knockout scheduler. Same tick()/start() pattern as contestScheduler.js and
// satelliteScheduler.js - one interval loop that opens/resolves whatever's
// due, driven by the shared test clock so SIM and LIVE time both work the
// same way everything else in this codebase already does.
//
// Daily cadence rounds are aligned to real market hours (9:30 open, 4:00
// close ET) using the same timeHelpers.js the existing satellite system
// relies on - not an approximated 24-hour window. A new daily season is
// created automatically for each upcoming trading day, enrollment opening
// the calendar day before at 4pm ET and closing at that day's opening bell,
// matching the exact convention already established for satellites.
//
// Weekly/hourly cadences still use the older fixed-duration approximation -
// out of scope for now since daily is the one actually launching.

const db = require("./db");
const { getNow } = require("./testClock");
const { isWeekday, etDateTime, etCalendarDate, nextMarketOpen } = require("./timeHelpers");
const engine = require("./knockoutEngine");

function nextTradingDayOpen(afterDate) {
  return nextMarketOpen(afterDate);
}

// Round N of a daily-cadence season is the Nth trading day starting from
// the season's own start date (inclusive) - open at 9:30 ET, close at 4:00
// PM ET, same day. This replaces the old "+24 hours" approximation, which
// landed close on the NEXT day's open rather than the SAME day's close.
function roundWindow(season, roundNumber) {
  if (season.cadence !== "daily") {
    // weekly/hourly: unchanged fixed-duration fallback, not in active use.
    const MS = { weekly: 7 * 24 * 60 * 60 * 1000, hourly: 60 * 60 * 1000 }[season.cadence];
    const opensAt = new Date(new Date(season.season_starts_at).getTime() + (roundNumber - 1) * MS);
    const closesAt = new Date(opensAt.getTime() + MS);
    return { opensAt, closesAt };
  }
  let probe = new Date(season.season_starts_at);
  let tradingDay = 1;
  while (tradingDay < roundNumber) {
    probe = new Date(probe.getTime() + 24 * 60 * 60 * 1000);
    if (isWeekday(probe)) tradingDay++;
  }
  const { year, month, day } = etCalendarDate(probe);
  return { opensAt: etDateTime(year, month, day, 9, 30, 0), closesAt: etDateTime(year, month, day, 16, 0, 0) };
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

// Creates the next day's season for EVERY tier (Runner, Clerk, Trader, Jr.
// Stonkbroker - no Free Roll, see the tier decision this followed) once
// that day's enrollment window should be open, skipping any tier that
// already has a season for that exact start time - safe to call every tick.
function ensureNextDailySeasonsExist(now) {
  const startsAt = nextTradingDayOpen(now);
  const { year, month, day } = etCalendarDate(new Date(startsAt.getTime() - 12 * 60 * 60 * 1000)); // the calendar day before
  const enrollmentOpensAt = etDateTime(year, month, day, 16, 0, 0);
  if (now.getTime() < enrollmentOpensAt.getTime()) return;

  for (const [tierKey, tier] of Object.entries(engine.TIERS)) {
    const exists = db.prepare(
      "SELECT 1 FROM knockout_seasons WHERE cadence='daily' AND tier=? AND season_starts_at=?"
    ).get(tierKey, startsAt.toISOString());
    if (exists) continue;

    try {
      engine.createSeason({
        cadence: "daily",
        tier: tierKey,
        entryFeeStonk: tier.entryFeeStonk,
        enrollmentOpensAt: enrollmentOpensAt.toISOString(),
        enrollmentClosesAt: startsAt.toISOString(),
        seasonStartsAt: startsAt.toISOString(),
      });
    } catch (e) {
      console.error(`[knockoutScheduler] failed to auto-create ${tierKey} season for ${startsAt.toISOString()}: ${e.message}`);
    }
  }
}

function tick(now = getNow()) {
  ensureNextDailySeasonsExist(now);

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

module.exports = { start, tick, roundWindow, ensureNextDailySeasonsExist };
