const fs = require('fs');
const path = require('path');
const express = require('express');
const { db } = require('../db');
const { upload, mediaTypeFromMime } = require('../services/upload');
const { generateCaption, hasKey } = require('../services/ai');
const { runOnce } = require('../services/publisher');

const router = express.Router();

const MSG = {
  posted: { ok: true, text: 'Post queued and dispatched.' },
  scheduled: { ok: true, text: 'Post scheduled.' },
  error: { ok: false, text: 'Something went wrong. Check the post status.' },
  no_platform: { ok: false, text: 'Select at least one platform to post to.' },
  empty: { ok: false, text: 'Write some text or use the AI caption generator.' },
  no_media: { ok: false, text: 'This platform requires text or media.' },
  no_consent: { ok: false, text: 'TikTok requires your consent to post (music usage confirmation).' },
  no_privacy: { ok: false, text: 'TikTok requires a privacy level. Pick one from the dropdown.' },
};

router.get('/dashboard', (req, res) => {
  const stats = {
    drafts: db.prepare("SELECT COUNT(*) c FROM posts WHERE status = 'draft'").get().c,
    scheduled: db
      .prepare("SELECT COUNT(*) c FROM posts WHERE status = 'scheduled'")
      .get().c,
    published: db
      .prepare("SELECT COUNT(*) c FROM posts WHERE status = 'published'")
      .get().c,
    failed: db.prepare("SELECT COUNT(*) c FROM posts WHERE status = 'failed'").get().c,
  };
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY platform').all();
  const upcoming = db
    .prepare(
      `SELECT t.*, a.display_name AS account_name, a.platform AS account_platform
       FROM post_targets t JOIN accounts a ON a.id = t.account_id
       WHERE t.status = 'scheduled'
       ORDER BY t.scheduled_at ASC LIMIT 10`
    )
    .all();
  const recent = db
    .prepare(
      `SELECT p.*, COUNT(t.id) AS target_count
       FROM posts p LEFT JOIN post_targets t ON t.post_id = p.id
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 8`
    )
    .all();
  res.render('pages/dashboard', {
    title: 'Dashboard',
    stats,
    accounts,
    upcoming,
    recent,
    active: 'dashboard',
  });
});

router.get('/compose', (req, res) => {
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE status = 'connected' ORDER BY platform")
    .all();
  res.render('pages/compose', {
    title: 'Compose',
    accounts,
    aiConfigured: hasKey(),
    msg: req.query.msg || null,
    active: 'compose',
  });
});

router.post('/compose', upload.single('media'), async (req, res) => {
  const { text, topic, tone, length, publish_mode, scheduled_at } = req.body;
  const accountIds = [].concat(req.body.platforms || []).filter(Boolean);
  let caption = (text || '').trim();
  try {
    if (!caption && (topic || '').trim()) {
      caption = await generateCaption({ topic, tone, length });
    }
    if (!caption) return res.redirect('/compose?msg=empty');
    if (accountIds.length === 0) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.redirect('/compose?msg=no_platform');
    }
    const accounts = db
      .prepare(`SELECT * FROM accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`)
      .all(...accountIds.map(Number));
    if (accounts.length === 0) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.redirect('/compose?msg=no_platform');
    }
    const wantsTikTok = accounts.some((a) => a.platform === 'tiktok');
    if (wantsTikTok) {
      if (!req.body.tiktok_consent) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.redirect('/compose?msg=no_consent');
      }
      if (!req.body.tiktok_privacy_level) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.redirect('/compose?msg=no_privacy');
      }
    }
    const info = db
      .prepare(
        'INSERT INTO posts (text, media_path, media_type, media_name, status) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        caption,
        req.file?.path || null,
        req.file ? mediaTypeFromMime(req.file.mimetype) : null,
        req.file?.originalname || null,
        'scheduled'
      );
    const postId = info.lastInsertRowid;
    const when = publish_mode === 'now' ? new Date() : new Date(scheduled_at || Date.now());
    if (Number.isNaN(when.getTime())) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.redirect('/compose?msg=error');
    }
    const whenIso = when.toISOString();
    const tiktokExtra = wantsTikTok
      ? {
          privacy_level: req.body.tiktok_privacy_level,
          title: req.body.tiktok_title || null,
          disable_comment: Boolean(req.body.tiktok_disable_comment),
          disable_duet: Boolean(req.body.tiktok_disable_duet),
          disable_stitch: Boolean(req.body.tiktok_disable_stitch),
          disclosure: Array.isArray(req.body.tiktok_disclosure)
            ? req.body.tiktok_disclosure[req.body.tiktok_disclosure.length - 1]
            : req.body.tiktok_disclosure || 'none',
          is_aigc: Boolean(req.body.tiktok_is_aigc),
        }
      : null;
    const youtubeExtra = {
      title: req.body.youtube_title || null,
      privacyStatus: req.body.youtube_privacy || 'public',
    };
    const insertTarget = db.prepare(
      `INSERT INTO post_targets (post_id, account_id, platform, scheduled_at, next_attempt_at, extra)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (const acc of accounts) {
        const extra =
          acc.platform === 'tiktok'
            ? JSON.stringify(tiktokExtra)
            : acc.platform === 'youtube'
              ? JSON.stringify(youtubeExtra)
              : null;
        insertTarget.run(postId, acc.id, acc.platform, whenIso, whenIso, extra);
      }
    });
    tx();
    if (publish_mode === 'now') {
      await runOnce();
      return res.redirect('/posts?msg=posted');
    }
    return res.redirect('/posts?msg=scheduled');
  } catch (err) {
    console.error('[compose]', err);
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.redirect('/compose?msg=error');
  }
});

router.get('/posts', (req, res) => {
  const posts = db
    .prepare(
      `SELECT p.*, GROUP_CONCAT(t.id) AS target_ids
       FROM posts p LEFT JOIN post_targets t ON t.post_id = p.id
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50`
    )
    .all();
  for (const p of posts) {
    p.mediaUrl = p.media_path ? `/media/${encodeURIComponent(path.basename(p.media_path))}` : null;
  }
  const targetsByPost = new Map();
  for (const p of posts) {
    const targets = db
      .prepare(
        `SELECT t.*, a.display_name AS account_name, a.platform AS account_platform
         FROM post_targets t JOIN accounts a ON a.id = t.account_id
         WHERE t.post_id = ? ORDER BY t.id`
      )
      .all(p.id);
    targetsByPost.set(p.id, targets);
  }
  res.render('pages/posts', {
    title: 'Posts',
    posts,
    targetsByPost,
    msg: MSG[req.query.msg] || null,
    active: 'posts',
  });
});

router.post('/targets/:id/retry', async (req, res) => {
  const target = db.prepare('SELECT * FROM post_targets WHERE id = ?').get(req.params.id);
  if (target) {
    db.prepare(
      `UPDATE post_targets SET status = 'scheduled', attempts = 0, error = NULL, next_attempt_at = ? WHERE id = ?`
    ).run(new Date().toISOString(), target.id);
  }
  await runOnce();
  res.redirect('/posts');
});

module.exports = router;
