const express = require("express");
const router = express.Router();
const db = require("../db");
const crypto = require("crypto");
const { hashPassword, verifyPassword, sign } = require("../auth");

const STARTING_STONK = Number(process.env.STARTING_STONK || 0); // "free to join" means free — no STONK grant on signup, matches the documented design. Was defaulting to 100000, which silently let anyone farm unlimited free paid-tier entries via throwaway accounts.

function generateReferralCode() {
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

router.post("/signup", (req, res) => {
  const { email, password, displayName, referralCode } = req.body || {};
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: "email, password, and displayName are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: "Email already registered" });

  let referredByUserId = null;
  if (referralCode) {
    const referrer = db
      .prepare("SELECT id FROM users WHERE referral_code = ?")
      .get(referralCode.trim().toUpperCase());
    if (referrer) referredByUserId = referrer.id;
  }

  let code = generateReferralCode();
  while (db.prepare("SELECT id FROM users WHERE referral_code = ?").get(code)) {
    code = generateReferralCode();
  }

  const password_hash = hashPassword(password);
  const insertUser = db.prepare(
    "INSERT INTO users (email, password_hash, display_name, referral_code, referred_by_user_id) VALUES (?, ?, ?, ?, ?)"
  );
  const info = insertUser.run(email.toLowerCase(), password_hash, displayName, code, referredByUserId);

  db.prepare("INSERT INTO accounts (user_id, stonk_balance) VALUES (?, ?)").run(
    info.lastInsertRowid,
    STARTING_STONK
  );

  const token = sign({ userId: info.lastInsertRowid, email: email.toLowerCase() });
  res.json({ token, displayName, startingStonk: STARTING_STONK, referralCode: code });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = sign({ userId: user.id, email: user.email });
  res.json({ token, displayName: user.display_name });
});

module.exports = router;
