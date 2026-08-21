const { verify } = require("../auth");
const db = require("../db");

module.exports = function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: "Not authenticated" });

  const account = db.prepare("SELECT * FROM accounts WHERE user_id = ?").get(payload.userId);
  if (!account) return res.status(404).json({ error: "Account not found" });

  req.user = payload;
  req.account = account;
  next();
};
