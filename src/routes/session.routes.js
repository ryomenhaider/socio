const express = require('express');
const {
  verifyPassword,
  getUserByUsername,
  createSession,
  verifySession,
  SESSION_TTL_MS,
} = require('../auth');
const { loginLimiter } = require('../rate-limit');
const config = require('../config');

const router = express.Router();

const secureCookies = config.baseUrl.startsWith('https');
const sessionCookieName = secureCookies ? '__Host-sid' : 'sid';

function safeNext(value) {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\')
    ? value
    : '/dashboard';
}

router.get('/login', (req, res) => {
  if (verifySession(req.cookies[sessionCookieName] || req.cookies['__Host-sid'])) {
    return res.redirect(safeNext(req.query.next));
  }
  const next = safeNext(req.query.next);
  res.render('pages/login', {
    title: 'Sign in',
    msg: req.query.msg || null,
    next,
    active: null,
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const next = safeNext(req.query.next);
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.redirect(`/login?next=${encodeURIComponent(next)}&msg=bad_credentials`);
  }
  res.cookie(sessionCookieName, createSession(user.username), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: secureCookies,
    maxAge: SESSION_TTL_MS,
  });
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  res.clearCookie(sessionCookieName, { path: '/' });
  res.redirect('/');
});

module.exports = router;
