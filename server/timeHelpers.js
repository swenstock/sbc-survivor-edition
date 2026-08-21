// Shared US Eastern Time calendar helpers — no external tz library needed.
const TZ = "America/New_York";

function easternParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

function isWeekday(date) {
  return !["Sat", "Sun"].includes(easternParts(date).weekday);
}

// Builds a Date for a given ET calendar date + hour, correctly offset.
function etDateTime(year, month, day, hour, minute, second) {
  const guessUTC = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const asET = new Date(guessUTC.toLocaleString("en-US", { timeZone: TZ }));
  const asUTC = new Date(guessUTC.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = asUTC.getTime() - asET.getTime();
  return new Date(guessUTC.getTime() + offsetMs);
}

// Today's date (ET) as {year, month, day}, from any UTC instant.
function etCalendarDate(date) {
  const p = easternParts(date);
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

function currentWeekWindow(now = new Date()) {
  const p = easternParts(now);
  const weekdayIndex = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[p.weekday];
  const daysSinceMonday = weekdayIndex === 0 ? 6 : weekdayIndex - 1;
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);

  const mondayGuessUTC = new Date(Date.UTC(y, m - 1, d - daysSinceMonday, 12, 0, 0));
  const mp = easternParts(mondayGuessUTC);
  // Opens at the real opening bell (9:30am ET Monday), not midnight — this
  // is a genuine trading week, not a calendar week.
  const monday = etDateTime(Number(mp.year), Number(mp.month), Number(mp.day), 9, 30, 0);
  const fridayGuessUTC = new Date(monday.getTime() + 4 * 24 * 60 * 60 * 1000);
  const fp = easternParts(fridayGuessUTC);
  // Closes at the real closing bell (4:00pm ET Friday), not end-of-day.
  const friday = etDateTime(Number(fp.year), Number(fp.month), Number(fp.day), 16, 0, 0);

  return { weekStart: monday, weekEnd: friday };
}

// The next real market open (9:30am ET) at or after `now` — used for
// scheduled orders queued against an already-joined portfolio.
function nextMarketOpen(now = new Date()) {
  let probe = new Date(now);
  for (let i = 0; i < 8; i++) {
    if (isWeekday(probe)) {
      const { year, month, day } = etCalendarDate(probe);
      const opensAt = etDateTime(year, month, day, 9, 30, 0);
      if (now.getTime() < opensAt.getTime()) return opensAt;
    }
    probe = new Date(probe.getTime() + 24 * 60 * 60 * 1000);
  }
  return now;
}

module.exports = { TZ, easternParts, isWeekday, etDateTime, etCalendarDate, currentWeekWindow, nextMarketOpen };
