const { definePlatform } = require('./base');
const config = require('../config');

const API = 'https://open.tiktokapis.com';
const SCOPES = 'user.info.basic,video.publish';

const MB = 1024 * 1024;

function redirectUri() {
  return `${config.baseUrl}/auth/tiktok/callback`;
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function tokenPost(form) {
  const res = await fetch(`${API}/v2/oauth/token/`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(
      `TikTok token error: ${data.error_description || data.error || `HTTP ${res.status}`}`
    );
  }
  return data;
}

async function apiPost(path, accessToken, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (data.error && data.error.code !== 'ok') {
    const msg = data.error.message || data.error.code || `HTTP ${res.status}`;
    const err = new Error(`TikTok: ${msg}`);
    if (res.status === 401 || data.error.code === 'access_token_invalid' || data.error.code === 'scope_not_authorized') {
      err.tokenExpired = true;
    }
    throw err;
  }
  return data;
}

async function handleCallback(code, state) {
  const t = await tokenPost({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });
  const res = await fetch(
    `${API}/v2/user/info/?fields=open_id,display_name,avatar_url`,
    {
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${t.access_token}` },
    }
  );
  const info = await res.json().catch(() => ({}));
  const user = info.data?.user || {};
  return {
    accounts: [
      {
        displayName: user.display_name || user.open_id || 'TikTok user',
        token: JSON.stringify({
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
          profile: { id: t.open_id, name: user.display_name || user.open_id || 'TikTok user' },
        }),
      },
    ],
  };
}

async function fetchCreatorInfo(account) {
  const tok = JSON.parse(account.token);
  const data = await apiPost('/v2/post/publish/creator_info/query/', tok.access_token);
  return data.data || {};
}

function chunkPlan(size) {
  if (size <= 64 * MB) {
    return { chunkSize: size, count: 1 };
  }
  let chunkSize = Math.min(64 * MB, Math.max(5 * MB, Math.ceil(size / 8)));
  chunkSize = Math.floor(chunkSize / MB) * MB;
  if (chunkSize < 5 * MB) chunkSize = 5 * MB;
  return { chunkSize, count: Math.ceil(size / chunkSize) };
}

async function uploadChunks(uploadUrl, buffer, chunkSize, count) {
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = Math.min(buffer.length - 1, start + chunkSize - 1);
    const chunk = buffer.subarray(start, end + 1);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      signal: AbortSignal.timeout(10 * 60 * 1000),
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
      },
      body: chunk,
    });
    if (res.status !== 206 && res.status !== 201 && res.status !== 200) {
      const body = await res.text().catch(() => '');
      throw new Error(`TikTok upload chunk ${i + 1}/${count} failed (${res.status}): ${body.slice(0, 200)}`);
    }
  }
}

async function initVideo(account, post, media, extra, tok, plan) {
  const data = await apiPost('/v2/post/publish/video/init/', tok.access_token, {
    post_info: {
      title: (extra?.title || post.text || '').slice(0, 2200),
      privacy_level: extra?.privacy_level,
      disable_comment: Boolean(extra?.disable_comment),
      disable_duet: Boolean(extra?.disable_duet),
      disable_stitch: Boolean(extra?.disable_stitch),
      brand_content_toggle: extra?.disclosure === 'branded',
      brand_organic_toggle: extra?.disclosure === 'your_brand',
      is_aigc: Boolean(extra?.is_aigc),
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: media.buffer.length,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.count,
    },
  });
  const info = data.data;
  if (!info?.upload_url || !info?.publish_id) {
    throw new Error('TikTok: no upload_url/publish_id in init response.');
  }
  return info;
}

async function pollStatus(tok, publishId) {
  const data = await apiPost('/v2/post/publish/status/fetch/', tok.access_token, {
    publish_id: publishId,
  });
  return data.data || {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tiktok = definePlatform({
  id: 'tiktok',
  label: 'TikTok',
  available: Boolean(config.tiktok.clientKey && config.tiktok.clientSecret),
  missing: 'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET are not set in .env',
  connectNote:
    'Requires a TikTok for Developers app with Content Posting API + Direct Post. Redirect URI must be HTTPS. Posts from unaudited apps stay private (SELF_ONLY) until the app passes TikTok\u2019s audit.',
  buildAuthorizeUrl,
  handleCallback,
  refresh: async (account) => {
    const tok = JSON.parse(account.token);
    if (!tok.refresh_token) return null;
    const t = await tokenPost({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token',
    });
    return {
      ...tok,
      access_token: t.access_token,
      refresh_token: t.refresh_token || tok.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    };
  },
  publish: async (account, post, media, extra, externalId) => {
    const tok = JSON.parse(account.token);
    if (!media || media.type !== 'video') {
      throw new Error('TikTok requires a video file (photo posts need a TikTok-verified domain URL).');
    }
    if (!extra?.privacy_level) {
      throw new Error('TikTok: pick a privacy level for this post.');
    }
    let publishId = externalId || null;
    if (!publishId) {
      const plan = chunkPlan(media.buffer.length);
      const info = await initVideo(account, post, media, extra, tok, plan);
      publishId = info.publish_id;
      await uploadChunks(info.upload_url, media.buffer, plan.chunkSize, plan.count);
    }
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const status = await pollStatus(tok, publishId);
      if (status.status === 'PUBLISH_COMPLETE') {
        return { externalId: publishId };
      }
      if (status.status === 'FAILED') {
        throw new Error(`TikTok publish failed: ${status.fail_reason || 'unknown reason'}`);
      }
    }
    const err = new Error('TikTok is still processing this video; socio will keep checking.');
    err.persistExternalId = publishId;
    throw err;
  },
});

module.exports = tiktok;
module.exports.fetchCreatorInfo = fetchCreatorInfo;
module.exports.chunkPlan = chunkPlan;
module.exports.uploadChunks = uploadChunks;
