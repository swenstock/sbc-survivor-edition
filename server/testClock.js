// ============================================================================
// TEST CLOCK — dev/test-only. Lets a developer manually jump the server's
// notion of "now" to an arbitrary moment, so contest scheduling behavior
// (opens, locks, resolves, freeroll windows, everything) can be checked at
// any time of day or day of week without waiting for real time to pass.
//
// SAFETY: hard no-op unless TEST_MODE=true.
//
// A bare datetime-local value (YYYY-MM-DDTHH:mm) is interpreted as US
// Eastern time, not the Render/server machine timezone. ISO strings that
// already include Z or an explicit offset are respected as absolute instants.
// ============================================================================

const { etDateTime } = require('./timeHelpers');
const TEST_MODE = process.env.TEST_MODE === "true";

let overrideAnchorMs = null;
let overrideSetAtRealMs = null;

function getNow() {
  if (!TEST_MODE || overrideAnchorMs === null) return new Date();
  const elapsedSinceJump = Date.now() - overrideSetAtRealMs;
  return new Date(overrideAnchorMs + elapsedSinceJump);
}

function parseTestDate(dateInput) {
  if (dateInput instanceof Date) return new Date(dateInput);
  const text = String(dateInput || '').trim();
  const bare = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (bare) {
    const [, y, m, d, hh, mm, ss = '0'] = bare;
    return etDateTime(Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
  }
  return new Date(text);
}

function setOverride(dateInput) {
  if (!TEST_MODE) throw new Error("Time override only works with TEST_MODE=true — this is a dev/test-only tool.");
  const d = parseTestDate(dateInput);
  if (isNaN(d.getTime())) throw new Error("Invalid date/time");
  overrideAnchorMs = d.getTime();
  overrideSetAtRealMs = Date.now();
  return getNow();
}

function clearOverride() {
  overrideAnchorMs = null;
  overrideSetAtRealMs = null;
}

function getStatus() {
  return {
    testModeActive: TEST_MODE,
    overridden: TEST_MODE && overrideAnchorMs !== null,
    currentNow: getNow().toISOString(),
    displayTimeZone: 'America/New_York',
  };
}

module.exports = { getNow, setOverride, clearOverride, getStatus, parseTestDate, TEST_MODE };
