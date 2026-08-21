// Auth helpers — deliberately zero-dependency (uses Node's built-in crypto only).
// Password hashing: scrypt with a random salt per user.
// Sessions: a minimal signed token (HMAC-SHA256), same idea as a JWT but with no
// extra dependency and no external library surface to audit.

const crypto = require("crypto");

// Resolves the HMAC secret used to sign session tokens. Never falls back to a
// fixed, known string — that would mean anyone who has ever seen this source
// (e.g. a shared snapshot like this one) could forge a valid session for any
// user_id on any deployment that forgot to set SESSION_SECRET.
//
// - If SESSION_SECRET is set, use it (this is the only path a real deploy
//   should use — see README's "Optional environment variables").
// - If it's missing AND this looks like production (NODE_ENV=production, the
//   default Render/Heroku-style signal), refuse to boot at all.
// - If it's missing in any other environment (local dev, CI, tests), generate
//   a random secret for this process only, so `npm start`/`npm run dev`/tests
//   keep working with zero setup — but sessions won't survive a restart, and
//   we say so loudly rather than silently.
function resolveSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is not set. Refusing to start in production without an explicit, " +
      "secret session key — see README's 'Optional environment variables' section."
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[auth] SESSION_SECRET is not set — using a random secret generated for this process only. " +
    "All existing sessions will be invalidated on every restart. Set SESSION_SECRET in your " +
    "environment before deploying anywhere real."
  );
  return generated;
}

const SECRET = resolveSecret();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sign(payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, sign, verify };
