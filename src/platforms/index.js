const { definePlatform } = require('./base');
const linkedin = require('./linkedin');
const meta = require('./meta');
const youtube = require('./youtube');
const tiktok = require('./tiktok');

const metaEntry = definePlatform({
  id: 'meta',
  label: 'Meta — Facebook + Instagram',
  available: meta.facebook.available,
  missing: 'META_CLIENT_ID and META_CLIENT_SECRET are not set in .env',
  connectNote:
    'One connection imports every Facebook page you admin plus each linked Instagram business account.',
  buildAuthorizeUrl: meta.facebook.buildAuthorizeUrl,
  handleCallback: meta.facebook.handleCallback,
});

const whatsapp = definePlatform({
  id: 'whatsapp',
  label: 'WhatsApp',
  available: false,
  connectNote: 'Not in v1 — WhatsApp is messaging, not a feed. A broadcast mode can be added later via the Meta Cloud API.',
});

const platforms = {
  meta: metaEntry,
  linkedin,
  facebook: meta.facebook,
  instagram: meta.instagram,
  youtube,
  tiktok,
  whatsapp,
};

module.exports = platforms;
