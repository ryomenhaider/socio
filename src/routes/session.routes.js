const express = require('express');
const {
  verifyPassword,
  getUserByUsername,
  createSession,
  verifySession,
  SESSION_TTL_MS,
} = require('../auth');

const router = express.Router();

router.get('/login', (req, res) => {
  if (verifySession(req.cookies.sid)) {
    return res.redirect(req.query.next || '/dashboard');
  }
  const next =
    typeof req.query.next === 'string' && req.query.next.startsWith('/')
      ? req.query.next
      : '/dashboard';
  res.render('pages/login', {
    title: 'Sign in',
    msg: req.query.msg || null,
    next,
    active: null,
  });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const next =
    typeof req.query.next === 'string' && req.query.next.startsWith('/')
      ? req.query.next
      : '/dashboard';
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.redirect(`/login?next=${encodeURIComponent(next)}&msg=bad_credentials`);
  }
  res.cookie('__Host-sid', createSession(user.username), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  res.clearCookie('sid');
  res.redirect('/');
});

module.exports = router;
