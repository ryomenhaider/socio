const fs = require('fs');
const path = require('path');
const express = require('express');
const { db } = require('../db');
const { upload, mediaTypeFromMime, validateMediaFiles } = require('../services/upload');
const { AI_MODELS, generateCaption, hasKey, getModel } = require('../services/ai');
const { runOnce } = require('../services/publisher');
const { perUserLimiter } = require('../rate-limit');
const { currentUserId, getOwnedTarget } = require('../auth');

const router = express.Router();

const composeLimiter = perUserLimiter(20, 'Too many posts. Please try again later.');
const retryLimiter = perUserLimiter(10, 'Too many retry attempts. Please try again later.');

const MSG = {
  posted: { ok: true, text: 'Post queued and dispatched.' },
  scheduled: { ok: true, text: 'Post scheduled.' },
  error: { ok: false, text: 'Something went wrong. Check the post status.' },
  bad_file: { ok: false, text: 'Rejected file — content did not match its declared type.' },
  no_platform: { ok: false, text: 'Select at least one platform to post to.' },
  empty: { ok: false, text: 'Every selected platform needs text — write some or use the AI copywriter.' },
  no_media: { ok: false, text: 'This platform requires text or media.' },
  no_consent: { ok: false, text: 'TikTok requires your consent to post (music usage confirmation).' },
  no_privacy: { ok: false, text: 'TikTok requires a privacy level. Pick one from the dropdown.' },
  media_required: { ok: false, text: 'This platform needs a media file — add one or uncheck the platform.' },
  bad_format: { ok: false, text: 'That file is not supported by this platform — YouTube and TikTok take mp4 video, Instagram takes image or video.' },
};

router.get('/dashboard', (req, res) => {
  const userId = currentUserId(res);
  const stats = {
    drafts: db.prepare("SELECT COUNT(*) c FROM posts WHERE status = 'draft' AND user_id = ?").get(userId).c,
    scheduled: db
      .prepare("SELECT COUNT(*) c FROM posts WHERE status = 'scheduled' AND user_id = ?")
      .get(userId).c,
    published: db
      .prepare("SELECT COUNT(*) c FROM posts WHERE status = 'published' AND user_id = ?")
      .get(userId).c,
    failed: db.prepare("SELECT COUNT(*) c FROM posts WHERE status = 'failed' AND user_id = ?").get(userId).c,
  };
  const accounts = db
    .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY platform')
    .all(userId);
  const upcoming = db
    .prepare(
      `SELECT t.*, a.display_name AS account_name, a.platform AS account_platform
       FROM post_targets t JOIN accounts a ON a.id = t.account_id
       WHERE t.status = 'scheduled' AND t.user_id = ?
       ORDER BY t.scheduled_at ASC LIMIT 10`
    )
    .all(userId);
  const recent = db
    .prepare(
      `SELECT p.*, COUNT(t.id) AS target_count
       FROM posts p LEFT JOIN post_targets t ON t.post_id = p.id
       WHERE p.user_id = ?
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 8`
    )
    .all(userId);
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
    .prepare("SELECT * FROM accounts WHERE status = 'connected' AND user_id = ? ORDER BY platform")
    .all(currentUserId(res));
  res.render('pages/compose', {
    title: 'Compose',
    accounts,
    aiConfigured: hasKey(),
    aiModels: AI_MODELS,
    aiModel: getModel(),
    aiPlatforms: [
      { id: 'linkedin', label: 'LinkedIn' },
      { id: 'facebook', label: 'Facebook' },
      { id: 'instagram', label: 'Instagram' },
      { id: 'youtube', label: 'YouTube' },
      { id: 'tiktok', label: 'TikTok' },
    ],
    msg: req.query.msg || null,
    active: 'compose',
  });
});

router.post('/compose', composeLimiter, upload.any(), async (req, res) => {
  const { text, topic, tone, length, publish_mode, scheduled_at } = req.body;
  const userId = currentUserId(res);
  const accountIds = [].concat(req.body.platforms || []).filter(Boolean);
  const files = req.files || [];
  const unlinkAll = () => {
    for (const f of files) fs.unlink(f.path, () => {});
  };
  const bad = validateMediaFiles(files);
  if (!bad.ok) {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    return res.redirect('/compose?msg=bad_file');
  }
  let caption = (text || '').trim();
  try {
    if (!caption && (topic || '').trim()) {
      caption = await generateCaption({ topic, tone, length });
    }
    if (accountIds.length === 0) {
      unlinkAll();
      return res.redirect('/compose?msg=no_platform');
    }
    const accounts = db
      .prepare(
        `SELECT * FROM accounts WHERE user_id = ? AND id IN (${accountIds.map(() => '?').join(',')})`
      )
      .all(userId, ...accountIds.map(Number));
    if (accounts.length === 0) {
      unlinkAll();
      return res.redirect('/compose?msg=no_platform');
    }
    const sharedFile = files.find((f) => f.fieldname === 'media');
    const targets = accounts.map((a) => {
      const ownFile = files.find((f) => f.fieldname === `media_${a.id}`);
      const file = ownFile || sharedFile;
      return {
        account: a,
        text: (req.body[`text_${a.id}`] || '').trim() || caption,
        ownFile: Boolean(ownFile),
        media: file
          ? {
              path: file.path,
              type: mediaTypeFromMime(file.mimetype),
              kind: file._media?.kind || null,
              name: file.originalname,
            }
          : null,
      };
    });
    if (targets.some((t) => !t.text)) {
      unlinkAll();
      return res.redirect('/compose?msg=empty');
    }
    const PLATFORM_MEDIA_RULES = {
      instagram: { required: true, kinds: new Set(['png', 'jpeg', 'gif', 'webp', 'mp4']) },
      youtube: { required: true, kinds: new Set(['mp4']) },
      tiktok: { required: true, kinds: new Set(['mp4']) },
      linkedin: { required: false, kinds: new Set(['png', 'jpeg', 'gif', 'webp']) },
      facebook: { required: false, kinds: new Set(['png', 'jpeg', 'gif', 'webp', 'mp4']) },
    };
    for (const t of targets) {
      const rule = PLATFORM_MEDIA_RULES[t.account.platform];
      if (!rule) continue;
      if (rule.required && !t.media) {
        unlinkAll();
        return res.redirect('/compose?msg=media_required');
      }
      if (t.media && !rule.kinds.has(t.media.kind)) {
        unlinkAll();
        return res.redirect('/compose?msg=bad_format');
      }
    }
    for (const t of targets) {
      if (t.account.platform !== 'tiktok') continue;
      const id = t.account.id;
      if (!req.body[`tiktok_consent_${id}`]) {
        unlinkAll();
        return res.redirect('/compose?msg=no_consent');
      }
      if (!req.body[`tiktok_privacy_level_${id}`]) {
        unlinkAll();
        return res.redirect('/compose?msg=no_privacy');
      }
    }
    const info = db
      .prepare(
        'INSERT INTO posts (user_id, text, media_path, media_type, media_name, status) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        userId,
        caption,
        sharedFile?.path || null,
        sharedFile ? mediaTypeFromMime(sharedFile.mimetype) : null,
        sharedFile?.originalname || null,
        'scheduled'
      );
    const postId = info.lastInsertRowid;
    const when = publish_mode === 'now' ? new Date() : new Date(scheduled_at || Date.now());
    if (Number.isNaN(when.getTime())) {
      db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
      unlinkAll();
      return res.redirect('/compose?msg=error');
    }
    const whenIso = when.toISOString();
    const insertTarget = db.prepare(
      `INSERT INTO post_targets (user_id, post_id, account_id, platform, text, media_path, media_type, media_name, scheduled_at, next_attempt_at, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (const t of targets) {
        const a = t.account;
        let extra = null;
        if (a.platform === 'tiktok') {
          extra = JSON.stringify({
            privacy_level: req.body[`tiktok_privacy_level_${a.id}`],
            title: req.body[`tiktok_title_${a.id}`] || null,
            disable_comment: Boolean(req.body[`tiktok_disable_comment_${a.id}`]),
            disable_duet: Boolean(req.body[`tiktok_disable_duet_${a.id}`]),
            disable_stitch: Boolean(req.body[`tiktok_disable_stitch_${a.id}`]),
            disclosure: Array.isArray(req.body[`tiktok_disclosure_${a.id}`])
              ? req.body[`tiktok_disclosure_${a.id}`][req.body[`tiktok_disclosure_${a.id}`].length - 1]
              : req.body[`tiktok_disclosure_${a.id}`] || 'none',
            is_aigc: Boolean(req.body[`tiktok_is_aigc_${a.id}`]),
          });
        } else if (a.platform === 'youtube') {
          extra = JSON.stringify({
            title: req.body[`youtube_title_${a.id}`] || null,
            privacyStatus: req.body[`youtube_privacy_${a.id}`] || 'public',
          });
        }
        insertTarget.run(
          userId,
          postId,
          a.id,
          a.platform,
          t.text,
          t.media?.path || null,
          t.media?.type || null,
          t.media?.name || null,
          whenIso,
          whenIso,
          extra
        );
      }
    });
    tx();
    const sharedUsed = sharedFile && targets.some((t) => !t.ownFile);
    for (const f of files) {
      const used = f === sharedFile ? sharedUsed : targets.some((t) => t.ownFile && t.media?.path === f.path);
      if (!used) fs.unlink(f.path, () => {});
    }
    if (publish_mode === 'now') {
      await runOnce();
      return res.redirect('/posts?msg=posted');
    }
    return res.redirect('/posts?msg=scheduled');
  } catch (err) {
    console.error('[compose]', err);
    unlinkAll();
    return res.redirect('/compose?msg=error');
  }
});

router.get('/posts', (req, res) => {
  const userId = currentUserId(res);
  const posts = db
    .prepare(
      `SELECT p.*, GROUP_CONCAT(t.id) AS target_ids
       FROM posts p LEFT JOIN post_targets t ON t.post_id = p.id
       WHERE p.user_id = ?
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT 50`
    )
    .all(userId);
  for (const p of posts) {
    p.mediaUrl = p.media_path ? `/media/${encodeURIComponent(path.basename(p.media_path))}` : null;
  }
  const targetsByPost = new Map();
  for (const p of posts) {
    const targets = db
      .prepare(
        `SELECT t.*, a.display_name AS account_name, a.platform AS account_platform
         FROM post_targets t JOIN accounts a ON a.id = t.account_id
         WHERE t.post_id = ? AND t.user_id = ? ORDER BY t.id`
      )
      .all(p.id, userId);
    targetsByPost.set(p.id, targets);
  }
  for (const p of posts) {
    for (const t of targetsByPost.get(p.id) || []) {
      const mediaPath = t.media_path || p.media_path;
      t.mediaUrl = mediaPath ? `/media/${encodeURIComponent(path.basename(mediaPath))}` : null;
      t.mediaType = t.media_type || p.media_type;
      t.resolvedText = t.text || p.text;
    }
  }
  res.render('pages/posts', {
    title: 'Posts',
    posts,
    targetsByPost,
    msg: MSG[req.query.msg] || null,
    active: 'posts',
  });
});

router.post('/targets/:id/retry', retryLimiter, async (req, res) => {
  const userId = currentUserId(res);
  const target = getOwnedTarget(req.params.id, userId);
  if (target) {
    db.prepare(
      `UPDATE post_targets SET status = 'scheduled', attempts = 0, error = NULL, next_attempt_at = ? WHERE id = ? AND user_id = ?`
    ).run(new Date().toISOString(), target.id, userId);
  }
  await runOnce();
  res.redirect('/posts');
});

module.exports = router;
