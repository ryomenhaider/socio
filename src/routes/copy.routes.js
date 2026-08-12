const express = require('express');
const { db } = require('../db');
const { generateCopy } = require('../services/ai');
const { fetchCreatorInfo } = require('../platforms/tiktok');

const router = express.Router();

router.get('/docs', (req, res) => {
  res.render('pages/docs', { title: 'Documentation', active: 'docs' });
});

router.post('/api/copy', async (req, res) => {
  const { topic, tone, length, model } = req.body;
  const platforms = [].concat(req.body.platforms || []).filter(Boolean);
  if (!(topic || '').trim()) {
    return res.render('partials/copy_result', {
      ok: false,
      error: 'Enter a topic or a few keywords first.',
      results: null,
    });
  }
  try {
    const results = await generateCopy({ topic, tone, length, platforms, model });
    res.render('partials/copy_result', { ok: true, error: null, results });
  } catch (err) {
    console.error('[copy]', err);
    res.render('partials/copy_result', {
      ok: false,
      error: String(err.message || err),
      results: null,
    });
  }
});

router.get('/api/tiktok/options', async (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.query.account_id);
  if (!account || account.platform !== 'tiktok') {
    return res.render('partials/tiktok_options', {
      ok: false,
      error: 'TikTok account not found.',
      info: null,
      accountId: req.query.account_id,
    });
  }
  try {
    const info = await fetchCreatorInfo(account);
    res.render('partials/tiktok_options', {
      ok: true,
      error: null,
      info,
      accountId: account.id,
    });
  } catch (err) {
    console.error('[tiktok options]', err);
    res.render('partials/tiktok_options', {
      ok: false,
      error: String(err.message || err),
      info: null,
      accountId: account.id,
    });
  }
});

module.exports = router;
