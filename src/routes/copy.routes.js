const express = require('express');
const { db } = require('../db');
const { generateCopy } = require('../services/ai');
const { fetchCreatorInfo } = require('../platforms/tiktok');
const { perUserLimiter } = require('../rate-limit');
const { currentUserId } = require('../auth');

const router = express.Router();

const MAX_TOPIC_LENGTH = 3000;
const copyLimiter = perUserLimiter(
  10,
  'Too many copy requests. Please try again later.'
);

router.get('/docs', (req, res) => {
  res.render('pages/docs', { title: 'Documentation', active: 'docs' });
});

router.post('/api/copy', copyLimiter, async (req, res) => {
  const { tone, length, model } = req.body;
  const topic = String(req.body.topic || '').trim();
  if (topic.length > MAX_TOPIC_LENGTH) {
    return res.status(400).render('partials/copy_result', {
      ok: false,
      error: `Topic is too long (max ${MAX_TOPIC_LENGTH} characters).`,
      results: null,
    });
  }
  const platforms = [].concat(req.body.platforms || []).filter(Boolean);
  if (!topic) {
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
  const account = db
    .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
    .get(req.query.account_id, currentUserId(res));
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
