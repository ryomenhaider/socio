const { definePlatform } = require('./base');
const config = require('../config');

const API = 'https://api.linkedin.com';
const AUTH = 'https://www.linkedin.com/oauth/v2';

const SCOPES = ['openid', 'profile', 'email', 'w_member_social'];

function redirectUri() {
  return `${config.baseUrl}/auth/linkedin/callback`;
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.linkedin.clientId,
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES.join(' '),
  });
  return `${AUTH}/authorization?${params.toString()}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: config.linkedin.clientId,
    client_secret: config.linkedin.clientSecret,
  });
  const res = await fetch(`${AUTH}/accessToken`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`LinkedIn token error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fetchProfile(accessToken) {
  const res = await fetch(`${API}/v2/userinfo`, {
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`LinkedIn profile error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.linkedin.clientId,
    client_secret: config.linkedin.clientSecret,
  });
  const res = await fetch(`${AUTH}/accessToken`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`LinkedIn refresh error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function tokenPayload(t) {
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
  };
}

async function registerUpload(accessToken, personId, category) {
  const recipe =
    category === 'video'
      ? 'urn:li:digitalmediaRecipe:feedshare-video'
      : 'urn:li:digitalmediaRecipe:feedshare-image';
  const res = await fetch(`${API}/v2/assets?action=registerUpload`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [recipe],
        owner: `urn:li:person:${personId}`,
        serviceRelationships: [
          { relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' },
        ],
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`LinkedIn upload register error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const value = data.value;
  const uploadUrl = value.uploadMechanism[
    'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'
  ].uploadUrl;
  return { uploadUrl, asset: value.asset };
}

async function uploadBinary(accessToken, uploadUrl, buffer, mimeType) {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(10 * 60 * 1000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mimeType || 'application/octet-stream',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`LinkedIn binary upload error ${res.status}: ${await res.text()}`);
  }
}

async function createUgcPost(accessToken, personId, text, media, category) {
  const payload = {
    author: `urn:li:person:${personId}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: category,
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
  if (media) {
    payload.specificContent['com.linkedin.ugc.ShareContent'].media = [
      { status: 'READY', media: media.asset, title: { text: media.title || '' } },
    ];
  }
  const res = await fetch(`${API}/v2/ugcPosts`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`LinkedIn post error ${res.status}: ${await res.text()}`);
  }
  return res.headers.get('restli-id') || 'ok';
}

module.exports = definePlatform({
  id: 'linkedin',
  label: 'LinkedIn',
  available: Boolean(config.linkedin.clientId && config.linkedin.clientSecret),
  missing: 'LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are not set in .env',
  buildAuthorizeUrl,
  handleCallback: async (code, state) => {
    const token = await exchangeCode(code);
    const profile = await fetchProfile(token.access_token);
    const name =
      profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || 'LinkedIn user';
    return {
      accounts: [
        {
          displayName: name,
          token: JSON.stringify({
            ...tokenPayload(token),
            profile: { id: profile.sub, name },
          }),
        },
      ],
    };
  },
  refresh: async (account) => {
    const tok = JSON.parse(account.token);
    if (!tok.refresh_token) return null;
    const t = await refreshAccessToken(tok.refresh_token);
    return {
      ...tok,
      access_token: t.access_token,
      refresh_token: t.refresh_token || tok.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
    };
  },
  publish: async (account, post, media) => {
    const tok = JSON.parse(account.token);
    const personId = tok.profile.id;
    const category = media && media.type === 'video' ? 'VIDEO' : media ? 'IMAGE' : 'NONE';
    if (media) {
      const { uploadUrl, asset } = await registerUpload(
        tok.access_token,
        personId,
        media.type === 'video' ? 'video' : 'image'
      );
      await uploadBinary(tok.access_token, uploadUrl, media.buffer, media.mimeType);
      const externalId = await createUgcPost(tok.access_token, personId, post.text, { asset }, category);
      return { externalId };
    }
    const externalId = await createUgcPost(tok.access_token, personId, post.text, null, 'NONE');
    return { externalId };
  },
});
