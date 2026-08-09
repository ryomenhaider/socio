const { definePlatform } = require('./base');
const config = require('../config');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'openid',
  'email',
].join(' ');

function redirectUri() {
  return `${config.baseUrl}/auth/youtube/callback`;
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function tokenPost(form) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(
      `Google error: ${data.error_description || data.error || `HTTP ${res.status}`}`
    );
  }
  return data;
}

async function handleCallback(code, state) {
  const t = await tokenPost({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
  });
  const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const profile = await profileRes.json().catch(() => ({}));
  const name = profile.name || profile.email || 'YouTube user';
  return {
    accounts: [
      {
        displayName: name,
        token: JSON.stringify({
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
          profile: { id: profile.sub, name, email: profile.email },
        }),
      },
    ],
  };
}

module.exports = definePlatform({
  id: 'youtube',
  label: 'YouTube',
  available: Boolean(config.google.clientId && config.google.clientSecret),
  missing: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env',
  connectNote:
    'Requires a Google Cloud project with YouTube Data API v3 enabled and an OAuth consent screen.',
  buildAuthorizeUrl,
  handleCallback,
  refresh: async (account) => {
    const tok = JSON.parse(account.token);
    if (!tok.refresh_token) return null;
    const t = await tokenPost({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
    });
    return {
      ...tok,
      access_token: t.access_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    };
  },
  publish: async (account, post, media, extra) => {
    const tok = JSON.parse(account.token);
    if (!media || media.type !== 'video') {
      throw new Error('YouTube requires a video file — images and text-only posts are not supported.');
    }
    const title = (extra?.title || post.text || 'Untitled').slice(0, 100);
    const privacyStatus = extra?.privacyStatus || 'public';
    const metadata = JSON.stringify({
      snippet: {
        title,
        description: post.text,
      },
      status: { privacyStatus },
    });
    const init = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/*',
          'X-Upload-Content-Length': String(media.buffer.length),
        },
        body: metadata,
      }
    );
    if (!init.ok) {
      const body = await init.text().catch(() => '');
      throw new Error(`YouTube init failed (${init.status}): ${body.slice(0, 300)}`);
    }
    const location = init.headers.get('location');
    if (!location) throw new Error('YouTube init failed: no upload session URL returned.');
    const up = await fetch(location, {
      method: 'PUT',
      signal: AbortSignal.timeout(10 * 60 * 1000),
      headers: {
        Authorization: `Bearer ${tok.access_token}`,
        'Content-Length': String(media.buffer.length),
        'Content-Type': 'video/*',
      },
      body: media.buffer,
    });
    if (up.status !== 201 && up.status !== 200) {
      const body = await up.text().catch(() => '');
      throw new Error(`YouTube upload failed (${up.status}): ${body.slice(0, 300)}`);
    }
    const data = await up.json().catch(() => ({}));
    return { externalId: data.id || null };
  },
});
