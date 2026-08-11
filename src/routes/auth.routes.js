const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const platforms = require('../platforms');

const router = express.Router();

router.get('/auth/:platform', (req, res) => {
  const adapter = platforms[req.params.platform];
  if (!adapter || !adapter.available) {
    return res.redirect('/accounts?msg=not_available');
  }
  if (!adapter.buildAuthorizeUrl) {
    return res.redirect('/accounts?msg=not_available');
  }
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO oauth_states (state, platform) VALUES (?, ?)').run(
    state,
    adapter.id
  );
  res.redirect(adapter.buildAuthorizeUrl(state));
});

router.get('/auth/:platform/callback', async (req, res) => {
  const adapter = platforms[req.params.platform];
  if (!adapter) {
    return res.redirect('/accounts?msg=error');
  }
  const { code, state, error } = req.query;
  if (error) {
    console.error(`[auth:${req.params.platform}] provider denied:`, req.query);
    const desc = String(req.query.error_description || '').slice(0, 300);
    return res.redirect(
      desc ? `/accounts?msg=denied&desc=${encodeURIComponent(desc)}` : '/accounts?msg=denied'
    );
  }
  if (!code || !state) {
    return res.redirect('/accounts?msg=error');
  }
  const saved = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(state);
  if (!saved || saved.platform !== adapter.id) {
    return res.redirect('/accounts?msg=bad_state');
  }
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  try {
    const result = await adapter.handleCallback(code, state);
    const incoming = (result.accounts || []).map((a) => ({
      platform: a.platform || adapter.id,
      displayName: a.displayName,
      token: typeof a.token === 'string' ? a.token : JSON.stringify(a.token),
    }));
    if (incoming.length === 0) {
      return res.redirect('/accounts?msg=error');
    }
    let added = 0;
    for (const acc of incoming) {
      const parsed = JSON.parse(acc.token);
      const profileId = parsed.profile?.id;
      const existing = profileId
        ? db
            .prepare('SELECT * FROM accounts WHERE platform = ?')
            .all(acc.platform)
            .find((a) => JSON.parse(a.token).profile?.id === profileId)
        : null;
      if (existing) {
        db.prepare('UPDATE accounts SET token = ?, display_name = ?, status = ?, last_error = NULL WHERE id = ?').run(
          acc.token,
          acc.displayName,
          'connected',
          existing.id
        );
      } else {
        db.prepare(
          'INSERT INTO accounts (platform, display_name, token) VALUES (?, ?, ?)'
        ).run(acc.platform, acc.displayName, acc.token);
        added += 1;
      }
    }
    res.redirect(added ? '/accounts?msg=connected' : '/accounts?msg=updated');
  } catch (err) {
    console.error('[auth]', err);
    res.redirect('/accounts?msg=error');
  }
});

module.exports = router;
