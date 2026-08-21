// Database layer for SBC Survivor Edition - a standalone project, separate
// from the main Stonk Broker Challenge codebase. Same node:sqlite approach
// (no native build step - see the main project's db.js for the full
// rationale), but deliberately minimal: this schema holds only what
// Survivor Edition itself needs. It intentionally does NOT include the main
// project's contests/satellites/tickets/portfolios - those don't exist here.
//
// This does mean separate accounts and a separate STONK balance from the
// main SBC platform - a player's balance in one doesn't carry over to the
// other. That's a deliberate consequence of these being genuinely separate
// projects for now, not an oversight - see the note on merging later.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  referral_code TEXT UNIQUE NOT NULL,
  referred_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stonk_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

-- Same ledger pattern as the main project - immutable, auditable, the real
-- source of truth. Reasons here are knockout_* only; no satellite/contest
-- reasons exist in this project.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT,
  reference_id INTEGER,
  balance_after REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_reason ON ledger_entries(reason);
`);

module.exports = db;
