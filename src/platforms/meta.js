const { definePlatform } = require('./base');
const config = require('../config');

const GRAPH = 'https://graph.facebook.com';
const VERSION = 'v26.0';

function redirectUri() {
  return `${config.baseUrl}/auth/meta/callback`;
}

function isNetworkError(err) {
  return (
    err instanceof TypeError ||
    ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED'].includes(err?.cause?.code)
  );
}

function wrapNetworkError(err) {
  if (isNetworkError(err)) {
    return new Error(
      'Network error reaching Meta (graph.facebook.com). Check your internet connection and try again.'
    );
  }
  return err;
}

function available() {
  return Boolean(config.meta.clientId && config.meta.clientSecret);
}

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.meta.clientId,
    redirect_uri: redirectUri(),
    state,
    config_id: config.meta.configId,
    response_type: 'code',
    override_default_response_type: 'true',
  });
  return `https://www.facebook.com/${VERSION}/dialog/oauth?${params.toString()}`;
}

async function graphGet(path, params) {
  const qs = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(`${GRAPH}/${VERSION}/${path}?${qs.toString()}`, {
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw wrapNetworkError(err);
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`Meta error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data;
}

async function graphPost(path, params) {
  let res;
  try {
    res = await fetch(`${GRAPH}/${VERSION}/${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw wrapNetworkError(err);
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`Meta error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data;
}

async function graphPostMultipart(path, fields, fileField, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) fd.append(k, String(v));
  }
  if (file) {
    fd.append(fileField, new Blob([file.buffer], { type: file.mimeType }), file.name);
  }
  const res = await fetch(`${GRAPH}/${VERSION}/${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10 * 60 * 1000),
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`Meta error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data;
}

async function exchangeCode(code) {
  return graphGet('oauth/access_token', {
    client_id: config.meta.clientId,
    client_secret: config.meta.clientSecret,
    redirect_uri: redirectUri(),
    code,
  });
}

async function longLived(shortToken) {
  return graphGet('oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: config.meta.clientId,
    client_secret: config.meta.clientSecret,
    fb_exchange_token: shortToken,
  });
}

async function fetchPages(userToken) {
  const pages = [];
  let url = `/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`;
  while (url) {
    const res = await fetch(`${GRAPH}/${VERSION}${url}`, {
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      throw new Error(`Meta error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    pages.push(...(data.data || []));
    url = data.paging?.next ? new URL(data.paging.next).search : null;
  }
  return pages;
}

async function debugToken(userToken) {
  const data = await graphGet('debug_token', {
    input_token: userToken,
    access_token: `${config.meta.clientId}|${config.meta.clientSecret}`,
  });
  return data.data || {};
}

async function fetchIgAccount(pageId, pageToken) {
  const data = await graphGet(pageId, {
    fields: 'instagram_business_account',
    access_token: pageToken,
  });
  return data.instagram_business_account || null;
}

async function handleCallback(code, state) {
  const short = await exchangeCode(code);
  const long = await longLived(short.access_token);
  const userToken = long.access_token;
  const expiresAt = long.expires_in ? Date.now() + long.expires_in * 1000 : null;
  let pages;
  try {
    pages = await fetchPages(userToken);
  } catch (err) {
    throw wrapNetworkError(err);
  }
  if (pages.length === 0) {
    let detail =
      'Your Facebook account must be an admin of at least one page, and that page must be linked to the Instagram business account you want to post to.';
    try {
      const info = await debugToken(userToken);
      const scopes = info.granted_scopes || info.scopes || [];
      const needed = ['pages_show_list', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
      const missing = needed.filter((s) => !scopes.includes(s));
      if (missing.length > 0) {
        detail = `Your Meta token is missing permissions: ${missing.join(', ')} (granted: ${
          scopes.join(', ') || 'none'
        }). Recreate the Facebook Login for Business configuration with asset type "Pages" and the pages_* + instagram_* permissions, then re-connect.`;
      }
    } catch (e) {
      /* debug_token is best-effort; keep the generic message */
    }
    throw new Error(`No Facebook pages found for this account. ${detail}`);
  }
  const accounts = [];
  for (const page of pages) {
    accounts.push({
      platform: 'facebook',
      displayName: `${page.name} (page)`,
      token: JSON.stringify({
        access_token: page.access_token,
        user_token: userToken,
        expires_at: expiresAt,
        profile: { id: page.id, name: page.name },
      }),
    });
    const ig = await fetchIgAccount(page.id, page.access_token);
    if (ig) {
      accounts.push({
        platform: 'instagram',
        displayName: `@${ig.username || ig.id} (Instagram)`,
        token: JSON.stringify({
          access_token: page.access_token,
          user_token: userToken,
          expires_at: expiresAt,
          ig_id: ig.id,
          profile: { id: ig.id, name: ig.username || ig.id },
        }),
      });
    }
  }
  return { accounts };
}

function pageToken(account) {
  return JSON.parse(account.token).access_token;
}

const facebook = definePlatform({
  id: 'facebook',
  label: 'Facebook',
  available: available(),
  missing: 'META_CLIENT_ID and META_CLIENT_SECRET are not set in .env',
  buildAuthorizeUrl,
  handleCallback,
  publish: async (account, post, media) => {
    const token = pageToken(account);
    const pageId = JSON.parse(account.token).profile.id;
    if (!media) {
      const data = await graphPost(`${pageId}/feed`, {
        message: post.text,
        access_token: token,
      });
      return { externalId: data.id || null };
    }
    if (media.type === 'video') {
      const data = await graphPostMultipart(
        `${pageId}/videos`,
        { description: post.text, access_token: token },
        'source',
        media
      );
      return { externalId: data.id || null };
    }
    const data = await graphPostMultipart(
      `${pageId}/photos`,
      { message: post.text, access_token: token },
      'source',
      media
    );
    return { externalId: data.post_id || data.id || null };
  },
});

async function createContainer(igId, params) {
  const res = await fetch(`${GRAPH}/${VERSION}/${igId}/media`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`Meta error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data;
}

async function publishContainer(igId, containerId, token) {
  return graphPost(`${igId}/media_publish`, {
    creation_id: containerId,
    access_token: token,
  });
}

async function containerStatus(containerId, token) {
  return graphGet(containerId, { fields: 'status_code', access_token: token });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForContainer(containerId, token, label) {
  for (let i = 0; i < 24; i++) {
    await sleep(10000);
    const data = await containerStatus(containerId, token);
    const code = data.status_code;
    if (code === 'FINISHED' || code === 'PUBLISHED') return;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Instagram: ${label} container ${containerId} failed (${code}).`);
    }
  }
  throw new Error(`Instagram: ${label} container ${containerId} still processing after 4 min.`);
}

const instagram = definePlatform({
  id: 'instagram',
  label: 'Instagram',
  available: available(),
  missing: 'META_CLIENT_ID and META_CLIENT_SECRET are not set in .env',
  connectNote:
    'Requires a Meta app + a professional (business/creator) Instagram account linked to a Facebook page.',
  buildAuthorizeUrl,
  handleCallback,
  publish: async (account, post, media) => {
    const tok = JSON.parse(account.token);
    const token = tok.access_token;
    const igId = tok.ig_id;
    if (!media) {
      throw new Error('Instagram requires an image or video — text-only posts are not supported.');
    }
    if (media.type === 'image') {
      if (!isPublicUrl(config.baseUrl)) {
        throw new Error(
          'Instagram images must be publicly reachable: set BASE_URL to a public HTTPS domain (videos work without it).'
        );
      }
      const imageUrl = `${config.baseUrl}/media/${encodeURIComponent(media.name)}`;
      const container = await createContainer(igId, {
        image_url: imageUrl,
        caption: post.text,
        access_token: token,
      });
      const published = await publishContainer(igId, container.id, token);
      return { externalId: published.id || container.id };
    }
    const container = await createContainer(igId, {
      media_type: 'VIDEO',
      upload_type: 'resumable',
      caption: post.text,
      access_token: token,
    });
    if (!container.uri) {
      throw new Error(
        `Instagram: resumable upload not available (${container.error?.message || 'no upload URI'}).`
      );
    }
    const up = await fetch(container.uri, {
      method: 'POST',
      signal: AbortSignal.timeout(10 * 60 * 1000),
      headers: {
        Authorization: `OAuth ${token}`,
        offset: '0',
        file_size: String(media.buffer.length),
      },
      body: media.buffer,
    });
    const upData = await up.json().catch(() => ({}));
    if (!up.ok || !upData.success) {
      throw new Error(
        `Instagram upload failed: ${upData.debug_info?.message || JSON.stringify(upData)}`
      );
    }
    await waitForContainer(container.id, token, 'video');
    const published = await publishContainer(igId, container.id, token);
    return { externalId: published.id || container.id };
  },
});

function isPublicUrl(url) {
  try {
    const u = new URL(url);
    return (
      !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname) &&
      (u.protocol === 'https:' || u.protocol === 'http:')
    );
  } catch {
    return false;
  }
}

module.exports = { facebook, instagram };
