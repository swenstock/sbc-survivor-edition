// ============================================================================
// CUSTODIAN ADAPTER
// ============================================================================
// Every single place STONK moves — entry fees, prizes, referral earnings,
// ticket trades, everything — goes through this file and nowhere else. That
// wasn't true before this existed: 10 separate places across 8 files ran raw
// SQL directly against accounts.stonk_balance, with no shared choke point and
// no audit trail of *why* a balance changed.
//
// This is deliberately built as a swappable interface, not a hardcoded
// implementation. Right now, `InternalLedgerCustodian` is the only
// implementation — it's pure internal bookkeeping, exactly what the platform
// has always actually done, just centralized and now logged to an immutable
// ledger instead of silently overwriting a running number.
//
// When it's time to connect a REAL custodian (an audited third-party payment
// processor or exchange API — see the CRITICAL WARNING below), that
// integration is a NEW class implementing the exact same five methods below,
// swapped in via CUSTODIAN_PROVIDER. Nothing that calls credit()/debit()
// anywhere else in the codebase needs to change at all.
//
// ============================================================================
// CRITICAL: DO NOT implement real custody (real wallets, real private keys,
// real on-chain transactions) directly in this file, or anywhere in this
// codebase, without both (a) a security audit of that specific code and
// (b) real legal review of how it's structured. A bug in home-grown custody
// code doesn't ship a patch — it can mean funds are gone, instantly,
// unrecoverably. Use an established, already-audited third-party rail
// (a payment processor or exchange API) for the actual custody and movement
// of real tokens; this file should only ever be the accounting layer on top
// of that, calling out to their API, never holding keys itself.
// ============================================================================

const db = require("./db");

const CUSTODIAN_PROVIDER = process.env.CUSTODIAN_PROVIDER || "internal_ledger";

class InternalLedgerCustodian {
  // Returns the account's current balance — the fast path, reads straight
  // from accounts.stonk_balance rather than summing the whole ledger every
  // time. (The ledger is the source of truth for AUDIT purposes; this
  // column is a maintained cache of what it sums to, kept in lockstep by
  // credit()/debit() below, always inside the same transaction.)
  getBalance(accountId) {
    const row = db.prepare("SELECT stonk_balance FROM accounts WHERE id = ?").get(accountId);
    if (!row) throw new Error(`No such account: ${accountId}`);
    return row.stonk_balance;
  }

  // Adds STONK to an account — a prize, a referral payout, a ticket sale,
  // a real deposit once a real custodian is connected. `reason` is
  // required and should be one of the documented ledger_entries.reason
  // values (see db.js) — this is what makes the ledger actually useful
  // for reconciliation later, not just a pile of numbers.
  credit(accountId, amount, reason, { referenceType = null, referenceId = null } = {}) {
    if (!(amount > 0)) throw new Error(`credit() amount must be positive, got ${amount}`);
    if (!reason) throw new Error("credit() requires a reason");
    return this._applyLedgerEntry(accountId, amount, reason, referenceType, referenceId);
  }

  // Removes STONK from an account — an entry fee, a ticket purchase, a
  // real withdrawal once a real custodian is connected. Throws if the
  // account doesn't have enough — the caller should always check
  // getBalance() first for a clean user-facing error message, but this is
  // the actual enforcement backstop regardless.
  debit(accountId, amount, reason, { referenceType = null, referenceId = null } = {}) {
    if (!(amount > 0)) throw new Error(`debit() amount must be positive, got ${amount}`);
    if (!reason) throw new Error("debit() requires a reason");
    const current = this.getBalance(accountId);
    if (current < amount) {
      throw new Error(`Insufficient balance: account ${accountId} has ${current}, tried to debit ${amount}`);
    }
    return this._applyLedgerEntry(accountId, -amount, reason, referenceType, referenceId);
  }

  _applyLedgerEntry(accountId, signedAmount, reason, referenceType, referenceId) {
    // Caller is expected to already be inside a db.exec("BEGIN")/"COMMIT"
    // block when this is one step of a larger multi-table operation (e.g.
    // "debit entry fee AND create the satellite_entries row" must succeed
    // or fail together) — better-sqlite3 is synchronous, so nested
    // BEGIN/COMMIT from an outer transaction is safe here as long as
    // callers follow the existing pattern already used throughout the
    // codebase (db.exec("BEGIN") ... db.exec("COMMIT")).
    db.prepare("UPDATE accounts SET stonk_balance = stonk_balance + ? WHERE id = ?").run(signedAmount, accountId);
    const newBalance = this.getBalance(accountId);
    db.prepare(
      `INSERT INTO ledger_entries (account_id, amount, reason, reference_type, reference_id, balance_after)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(accountId, signedAmount, reason, referenceType, referenceId, newBalance);
    return newBalance;
  }

  // ---- Real-money rails: NOT implemented. Placeholders only. ----
  // These exist so the shape of a real integration is visible now, not
  // hidden until later. Every one of these throws until a real custodian
  // is actually connected — see the CRITICAL WARNING at the top of this
  // file before ever implementing them for real.
  requestDeposit(_accountId, _amount) {
    throw new Error("No real custodian connected — requestDeposit() is not implemented. See custodian.js.");
  }
  requestWithdrawal(_accountId, _amount, _destinationAddress) {
    throw new Error("No real custodian connected — requestWithdrawal() is not implemented. See custodian.js.");
  }
}

// Swap point for a real custodian later: add e.g. `else if
// (CUSTODIAN_PROVIDER === "real_processor_name") custodian = new
// RealProcessorCustodian();` — every caller elsewhere in the codebase is
// already written against this same five-method interface and needs zero
// changes when that day comes.
let custodian;
if (CUSTODIAN_PROVIDER === "internal_ledger") {
  custodian = new InternalLedgerCustodian();
} else {
  throw new Error(`Unknown CUSTODIAN_PROVIDER: ${CUSTODIAN_PROVIDER}`);
}

module.exports = custodian;
