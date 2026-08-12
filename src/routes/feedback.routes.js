const express = require('express');
const { scoreFeedback, hasKey, FEEDBACK_THRESHOLD } = require('../services/ai');
const { sendFeedback, FEEDBACK_TO, mailConfigured } = require('../services/feedback');

const router = express.Router();

const MAX_LENGTH = 5000;

function renderResult(res, opts) {
  return res.render('partials/feedback_result', {
    FEEDBACK_TO,
    message: '',
    email: '',
    force: false,
    ...opts,
  });
}

router.get('/feedback', (req, res) => {
  res.render('pages/feedback', {
    title: 'Feedback',
    active: 'feedback',
    aiReady: hasKey(),
    mailReady: mailConfigured(),
    FEEDBACK_TO,
  });
});

router.post('/feedback/submit', async (req, res) => {
  const message = String(req.body.message || '').trim();
  const email = String(req.body.email || '').trim();
  const force = req.body.force === '1';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderResult(res, {
      ok: false,
      error: 'Enter a valid email address for replies (or leave it empty).',
      score: null,
      reason: null,
      message,
      email,
      force,
    });
  }
  if (!force) {
    if (!message) {
      return renderResult(res, {
        ok: false,
        error: 'Write a message first.',
        score: null,
        reason: null,
        message,
        force,
      });
    }
    if (message.length > MAX_LENGTH) {
      return renderResult(res, {
        ok: false,
        error: `Message is too long (max ${MAX_LENGTH} characters).`,
        score: null,
        reason: null,
        message,
        force,
      });
    }
  }
  let score = null;
  let reason = null;
  try {
    if (!force) {
      const verdict = await scoreFeedback(message);
      score = verdict.score;
      reason = verdict.reason;
      if (score < FEEDBACK_THRESHOLD) {
        return renderResult(res, {
          ok: false,
          lowScore: true,
          error: null,
          score,
          reason,
          message,
          force,
        });
      }
    }
    await sendFeedback({
      subject: `[Socio feedback] from ${res.locals.user}`,
      message,
      user: res.locals.user,
      score,
      reason,
      email,
    });
    return renderResult(res, {
      ok: true,
      error: null,
      score,
      reason,
      message,
      force,
    });
  } catch (err) {
    console.error('[feedback]', err);
    return renderResult(res, {
      ok: false,
      error: String(err.message || err),
      score,
      reason,
      message,
      force,
    });
  }
});

module.exports = router;