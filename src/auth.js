const crypto = require('crypto');
const { db } = require('./db');
const config = require('./config');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const calc = crypto.scryptSync(String(password), parts[0], 64);
  const expected = Buffer.from(parts[1], 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

function getUserByUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(normalized);
}

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(parts[0])
    .digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function createSession(username) {
  return signSession({ username, exp: Date.now() + SESSION_TTL_MS });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
    }
  }
  return out;
}

function requireAuth(req, res, next) {
  const session = verifySession(req.cookies['__Host-sid'] || req.cookies.sid);
  if (!session) {
    if (req.path.startsWith('/api/') || req.method !== 'GET') {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  res.locals.user = session.username;
  next();
}

module.exports = {
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  getUserByUsername,
  createSession,
  verifySession,
  parseCookies,
  requireAuth,
};
