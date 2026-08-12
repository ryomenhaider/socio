const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const config = require('../config');
const platforms = require('../platforms');

const MAX_ATTEMPTS = 3;

function isTokenError(err) {
  const m = String(err?.message || err);
  return (
    /401|unauthorized|invalid.*token|token.*expired|access_token_invalid|scope_not_authorized/i.test(m) ||
    err?.tokenExpired === true
  );
}

async function refreshAccountIfNeeded(account, adapter, force) {
  const tok = JSON.parse(account.token);
  const nearExpiry = tok.expires_at && Date.now() > tok.expires_at - 24 * 60 * 60 * 1000;
  if (force || nearExpiry) {
    if (!adapter.refresh) {
      if (force) throw new Error(`Token for ${adapter.label} is invalid or expired. Re-connect the account.`);
      throw new Error(`Token for ${adapter.label} has expired. Re-connect the account.`);
    }
    const refreshed = await adapter.refresh(account);
    if (!refreshed) {
      throw new Error(`Token for ${adapter.label} cannot be refreshed. Re-connect the account.`);
    }
    db.prepare('UPDATE accounts SET token = ? WHERE id = ?').run(
      JSON.stringify(refreshed),
      account.id
    );
    return { ...account, token: JSON.stringify(refreshed) };
  }
  return account;
}

async function publishTarget(target) {
  const account = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(target.account_id);
  if (!account) throw new Error('Account no longer exists');
  const adapter = platforms[target.platform];
  if (!adapter || !adapter.available) {
    throw new Error(`${target.platform} integration is not available yet`);
  }
  if (typeof adapter.publish !== 'function') {
    throw new Error(`${target.platform}: publish is not supported by this integration`);
  }
  const extra = target.extra ? JSON.parse(target.extra) : {};
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(target.post_id);
  const content = { ...post };
  if (target.text) content.text = target.text;
  if (target.media_path) {
    content.media_path = target.media_path;
    content.media_type = target.media_type;
    content.media_name = target.media_name;
  }
  const media =
    content.media_path && fs.existsSync(content.media_path)
      ? {
          type: content.media_type || 'image',
          mimeType: content.media_type === 'video' ? 'video/mp4' : 'image/jpeg',
          buffer: fs.readFileSync(content.media_path),
          name: path.basename(content.media_path),
        }
      : null;
  let accountForCall = await refreshAccountIfNeeded(account, adapter);
  try {
    const result = await adapter.publish(accountForCall, content, media, extra, target.external_id);
    return result;
  } catch (err) {
    if (isTokenError(err) && adapter.refresh) {
      accountForCall = await refreshAccountIfNeeded(account, adapter, true);
      const result = await adapter.publish(accountForCall, content, media, extra, target.external_id);
      return result;
    }
    throw err;
  }
}

function computeNextAttempt(target) {
  const backoffMin = Math.min(Math.pow(2, target.attempts) * 2, 60);
  return new Date(Date.now() + backoffMin * 60 * 1000).toISOString();
}

const STALE_TIMEOUT_MS = 15 * 60 * 1000;

const claimTarget = db.transaction((id, ts) =>
  db
    .prepare(
      `UPDATE post_targets SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'`
    )
    .run(ts, id).changes
);

async function runOnce() {
  let published = 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - STALE_TIMEOUT_MS).toISOString();

  const stale = db
    .prepare(
      `SELECT id, platform, external_id FROM post_targets WHERE status = 'publishing' AND updated_at < ?`
    )
    .all(staleBefore);
  for (const t of stale) {
    const resumable = t.platform === 'tiktok' && t.external_id;
    db.prepare(
      `UPDATE post_targets
       SET status = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`
    ).run(
      resumable ? 'scheduled' : 'failed',
      resumable
        ? null
        : 'Stalled publish (no progress for 15+ min) - manual verification required.',
      nowIso,
      nowIso,
      t.id
    );
  }

  const due = db
    .prepare(
      `SELECT * FROM post_targets
       WHERE status = 'scheduled' AND next_attempt_at <= ?
       ORDER BY scheduled_at ASC LIMIT 10`
    )
    .all(nowIso);
  for (const target of due) {
    if (claimTarget(target.id, nowIso) !== 1) continue;
    try {
      const result = await publishTarget(target);
      db.prepare(
        `UPDATE post_targets SET status = 'published', external_id = ?, error = NULL, updated_at = ? WHERE id = ?`
      ).run(result?.externalId || null, nowIso, target.id);
      published += 1;
    } catch (err) {
      const nextAttempts = target.attempts + 1;
      const failed = nextAttempts >= MAX_ATTEMPTS;
      const persistExternalId = err.persistExternalId || null;
      db.prepare(
        `UPDATE post_targets
         SET status = ?, error = ?, next_attempt_at = ?, attempts = ?, external_id = COALESCE(?, external_id), updated_at = ? WHERE id = ?`
      ).run(
        failed ? 'failed' : 'scheduled',
        String(err.message || err).slice(0, 2000),
        failed ? nowIso : computeNextAttempt({ attempts: nextAttempts }),
        nextAttempts,
        persistExternalId,
        nowIso,
        target.id
      );
    }
  }
  const completed = db
    .prepare(
      `UPDATE posts SET status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM post_targets WHERE post_id = posts.id AND status IN ('scheduled','publishing')) THEN
           CASE WHEN EXISTS (SELECT 1 FROM post_targets WHERE post_id = posts.id AND status = 'failed') AND
                     NOT EXISTS (SELECT 1 FROM post_targets WHERE post_id = posts.id AND status = 'published')
             THEN 'failed' ELSE 'published' END
         ELSE 'scheduled' END
       WHERE status IN ('scheduled','publishing')`
    )
    .run();
  return published;
}

function start() {
  setInterval(() => {
    runOnce().catch((err) => console.error('[scheduler]', err));
  }, 30 * 1000);
  console.log('[scheduler] started, polling every 30s');
}

module.exports = { runOnce, start, MAX_ATTEMPTS };
