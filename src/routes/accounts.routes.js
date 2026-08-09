const express = require('express');
const { db } = require('../db');
const platforms = require('../platforms');

const router = express.Router();

router.get('/accounts', (req, res) => {
  const accounts = db
    .prepare('SELECT * FROM accounts ORDER BY platform, display_name')
    .all()
    .map((a) => {
      let tok = {};
      try {
        tok = JSON.parse(a.token);
      } catch {
        tok = {};
      }
      return {
        ...a,
        expires_at: tok.expires_at || null,
        has_refresh: Boolean(platforms[a.platform]?.refresh),
      };
    });
  const msg = req.query.msg || null;
  res.render('pages/accounts', {
    title: 'Accounts',
    accounts,
    platforms,
    msg,
    active: 'accounts',
  });
});

router.post('/accounts/:id/disconnect', (req, res) => {
  db.prepare('DELETE FROM post_targets WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.redirect('/accounts?msg=disconnected');
});

router.post('/accounts/:id/refresh', async (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.redirect('/accounts?msg=error');
  const adapter = platforms[account.platform];
  if (!adapter?.refresh) return res.redirect('/accounts?msg=error');
  try {
    const refreshed = await adapter.refresh(account);
    db.prepare('UPDATE accounts SET token = ? WHERE id = ?').run(
      JSON.stringify(refreshed),
      account.id
    );
    res.redirect('/accounts?msg=refreshed');
  } catch (err) {
    console.error('[refresh]', err);
    db.prepare(
      'UPDATE accounts SET status = ?, last_error = ? WHERE id = ?'
    ).run('error', String(err.message || err).slice(0, 500), account.id);
    res.redirect('/accounts?msg=error');
  }
});

module.exports = router;
