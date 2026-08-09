const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const config = require('../config');
const { generateCaption } = require('../services/ai');
const platforms = require('../platforms');
const { fetchCreatorInfo } = require('../platforms/tiktok');

const router = express.Router();

router.get('/settings', (req, res) => {
  res.render('pages/settings', {
    title: 'Settings',
    key: getSetting('openrouter_api_key') || '',
    model: getSetting('openrouter_model') || config.openrouter.model,
    msg: req.query.msg || null,
    active: 'settings',
  });
});

router.post('/settings', (req, res) => {
  const key = (req.body.openrouter_api_key || '').trim();
  const model = (req.body.openrouter_model || '').trim();
  if (key) setSetting('openrouter_api_key', key);
  if (model) setSetting('openrouter_model', model);
  res.redirect('/settings?msg=saved');
});

router.post('/api/caption', async (req, res) => {
  const { topic, tone, length } = req.body;
  if (!(topic || '').trim()) {
    return res.render('partials/caption_result', {
      ok: false,
      error: 'Enter a topic or a few keywords first.',
      caption: null,
    });
  }
  try {
    const caption = await generateCaption({ topic, tone, length });
    res.render('partials/caption_result', { ok: true, error: null, caption });
  } catch (err) {
    console.error('[caption]', err);
    res.render('partials/caption_result', {
      ok: false,
      error: String(err.message || err),
      caption: null,
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
    });
  }
  try {
    const info = await fetchCreatorInfo(account);
    res.render('partials/tiktok_options', { ok: true, error: null, info });
  } catch (err) {
    console.error('[tiktok options]', err);
    res.render('partials/tiktok_options', {
      ok: false,
      error: String(err.message || err),
      info: null,
    });
  }
});

module.exports = router;
