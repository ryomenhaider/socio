const express = require('express');
const { db } = require('../db');
const platforms = require('../platforms');
const { currentUserId, getOwnedAccount } = require('../auth');

const router = express.Router();

router.get('/accounts', (req, res) => {
  const accounts = db
    .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY platform, display_name')
    .all(currentUserId(res))
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
  const desc = req.query.desc || null;
  res.render('pages/accounts', {
    title: 'Accounts',
    accounts,
    platforms,
    msg,
    desc,
    active: 'accounts',
  });
});

router.post('/accounts/:id/disconnect', (req, res) => {
  const owned = getOwnedAccount(req.params.id, currentUserId(res));
  if (owned) {
    db.prepare('DELETE FROM post_targets WHERE account_id = ? AND user_id = ?').run(
      owned.id,
      currentUserId(res)
    );
    db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(
      owned.id,
      currentUserId(res)
    );
  }
  res.redirect('/accounts?msg=disconnected');
});

router.post('/accounts/:id/refresh', async (req, res) => {
  const userId = currentUserId(res);
  const account = getOwnedAccount(req.params.id, userId);
  if (!account) return res.redirect('/accounts?msg=error');
  const adapter = platforms[account.platform];
  if (!adapter?.refresh) return res.redirect('/accounts?msg=error');
  try {
    const refreshed = await adapter.refresh(account);
    db.prepare('UPDATE accounts SET token = ? WHERE id = ? AND user_id = ?').run(
      JSON.stringify(refreshed),
      account.id,
      userId
    );
    res.redirect('/accounts?msg=refreshed');
  } catch (err) {
    console.error('[refresh]', err);
    db.prepare(
      'UPDATE accounts SET status = ?, last_error = ? WHERE id = ? AND user_id = ?'
    ).run('error', String(err.message || err).slice(0, 500), account.id, userId);
    res.redirect('/accounts?msg=error');
  }
});

module.exports = router;
