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
  const extra = target.extra ? JSON.parse(target.extra) : {};
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(target.post_id);
  const media =
    post.media_path && fs.existsSync(post.media_path)
      ? {
          type: post.media_type || 'image',
          mimeType: post.media_type === 'video' ? 'video/mp4' : 'image/jpeg',
          buffer: fs.readFileSync(post.media_path),
          name: path.basename(post.media_path),
        }
      : null;
  let accountForCall = await refreshAccountIfNeeded(account, adapter);
  try {
    const result = await adapter.publish(accountForCall, post, media, extra, target.external_id);
    return result;
  } catch (err) {
    if (isTokenError(err) && adapter.refresh) {
      accountForCall = await refreshAccountIfNeeded(account, adapter, true);
      const result = await adapter.publish(accountForCall, post, media, extra, target.external_id);
      return result;
    }
    throw err;
  }
}

function computeNextAttempt(target) {
  const backoffMin = Math.min(Math.pow(2, target.attempts) * 2, 60);
  return new Date(Date.now() + backoffMin * 60 * 1000).toISOString();
}

async function runOnce() {
  if (runOnce.locked) return 0;
  runOnce.locked = true;
  let published = 0;
  try {
    const now = new Date().toISOString();
    const due = db
      .prepare(
        `SELECT * FROM post_targets
         WHERE status = 'scheduled' AND next_attempt_at <= ?
         ORDER BY scheduled_at ASC LIMIT 10`
      )
      .all(now);
    for (const target of due) {
      db.prepare(
        `UPDATE post_targets SET status = 'publishing', attempts = attempts + 1 WHERE id = ?`
      ).run(target.id);
      try {
        const result = await publishTarget(target);
        db.prepare(
          `UPDATE post_targets SET status = 'published', external_id = ?, error = NULL WHERE id = ?`
        ).run(result?.externalId || null, target.id);
        published += 1;
      } catch (err) {
        const nextAttempts = target.attempts + 1;
        const failed = nextAttempts >= MAX_ATTEMPTS;
        const persistExternalId = err.persistExternalId || null;
        db.prepare(
          `UPDATE post_targets
           SET status = ?, error = ?, next_attempt_at = ?, external_id = COALESCE(?, external_id) WHERE id = ?`
        ).run(
          failed ? 'failed' : 'scheduled',
          String(err.message || err).slice(0, 2000),
          failed ? new Date().toISOString() : computeNextAttempt({ attempts: nextAttempts }),
          persistExternalId,
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
  } finally {
    runOnce.locked = false;
  }
}
runOnce.locked = false;

function start() {
  setInterval(() => {
    runOnce().catch((err) => console.error('[scheduler]', err));
  }, 30 * 1000);
  console.log('[scheduler] started, polling every 30s');
}

module.exports = { runOnce, start, MAX_ATTEMPTS };
