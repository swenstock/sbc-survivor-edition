// Knockout (survivor pool) schema additions. Follows the exact pattern
// schemaV45.js already uses: idempotent addColumn() for existing tables,
// CREATE TABLE IF NOT EXISTS for new ones, run() called once at startup.
// Never drops existing data.

const db = require('./db');

function columns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
}

function addColumn(table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function run() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knockout_seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cadence TEXT NOT NULL,              -- 'weekly' | 'daily' | 'hourly'
      tier TEXT,                          -- 'runner' | 'clerk' | 'trader' | 'junior' - which of the 4 parallel brackets this is
      entry_fee_stonk REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'enrolling',
                                           -- enrolling -> regular_season -> playoffs -> complete
      current_round INTEGER NOT NULL DEFAULT 0,
      total_regular_rounds INTEGER NOT NULL DEFAULT 18,
      enrollment_opens_at TEXT NOT NULL,
      enrollment_closes_at TEXT NOT NULL,
      season_starts_at TEXT NOT NULL,
      pot_stonk REAL NOT NULL DEFAULT 0,  -- accumulates as entries are charged; never decremented until settlement
      champion_ticker TEXT,
      settled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_knockout_seasons_status
      ON knockout_seasons(status, cadence);

    -- Roster + division/conference assignment for one season. Season-scoped
    -- (not global) on purpose, so the 32-stock lineup and division groupings
    -- can be revised season to season - a mega-cap dominating one season's
    -- division doesn't lock in every future season.
    CREATE TABLE IF NOT EXISTS knockout_stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES knockout_seasons(id) ON DELETE CASCADE,
      ticker TEXT NOT NULL,
      conference TEXT NOT NULL,
      division TEXT NOT NULL,
      UNIQUE(season_id, ticker)
    );
    CREATE INDEX IF NOT EXISTS idx_knockout_stocks_season
      ON knockout_stocks(season_id, conference, division);

    -- Single source of truth for every stock-vs-stock game, regular season
    -- AND playoffs alike - distinguished only by phase, with round_number
    -- continuing to climb (e.g. 19 = wild card, 22 = the championship game).
    -- Deliberately one table rather than a separate playoff-bracket table:
    -- standings, results, and bracket progression all read from the same
    -- place, so there's no second copy of "who won" that can drift.
    CREATE TABLE IF NOT EXISTS knockout_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES knockout_seasons(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'regular',
                                           -- regular | wildcard | divisional | conference | superbowl
      stock_a TEXT NOT NULL,
      stock_b TEXT NOT NULL,
      stock_a_open_price REAL,            -- captured when the round opens - the
      stock_b_open_price REAL,            -- reference point the round's move is measured from
      stock_a_pct_move REAL,
      stock_b_pct_move REAL,
      winner_ticker TEXT,
      opened_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_knockout_schedule_season_round
      ON knockout_schedule(season_id, round_number);
    CREATE INDEX IF NOT EXISTS idx_knockout_schedule_stock
      ON knockout_schedule(season_id, stock_a, stock_b);

    -- Locked once the regular season ends. Persisted rather than
    -- recomputed on demand so the playoff bracket has a fixed, auditable
    -- starting point that can't silently shift if standings math changes.
    CREATE TABLE IF NOT EXISTS knockout_playoff_seeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES knockout_seasons(id) ON DELETE CASCADE,
      conference TEXT NOT NULL,
      seed INTEGER NOT NULL,              -- 1-7; 1-4 are always division winners by rule
      ticker TEXT NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      UNIQUE(season_id, conference, seed)
    );

    CREATE TABLE IF NOT EXISTS knockout_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES knockout_seasons(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      entry_fee_paid REAL NOT NULL,
      alive INTEGER NOT NULL DEFAULT 1,
      eliminated_round INTEGER,
      joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(season_id, account_id)       -- one entry per account per season
    );
    CREATE INDEX IF NOT EXISTS idx_knockout_entries_season_alive
      ON knockout_entries(season_id, alive);

    -- The two UNIQUE constraints here are the actual rule enforcement, not
    -- just indexes: (entry_id, stock_ticker) makes "never reuse a stock"
    -- a database guarantee, not just something the route handler has to
    -- remember to check. (entry_id, round_number) makes "one pick per
    -- round" the same kind of guarantee.
    CREATE TABLE IF NOT EXISTS knockout_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES knockout_entries(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      stock_ticker TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT 'pending',  -- pending | win | loss
      picked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id, stock_ticker),
      UNIQUE(entry_id, round_number)
    );

    -- A vote to split only counts while the entry is still alive - an entry
    -- eliminated in a later round doesn't need its vote removed, a query
    -- that joins against knockout_entries.alive naturally ignores it. The
    -- season settles as a split the moment every currently-alive entry has
    -- an unretracted vote here.
    CREATE TABLE IF NOT EXISTS knockout_split_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES knockout_entries(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      voted_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entry_id)
    );
  `);

  // The live database already has knockout_seasons from before tiers
  // existed - CREATE TABLE IF NOT EXISTS above is a no-op for it, so the
  // actual migration for existing rows happens here.
  addColumn('knockout_seasons', 'tier TEXT');
}

module.exports = { run, columns, addColumn };
