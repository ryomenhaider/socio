const path = require('path');
require('dotenv').config();

const dataDir = path.resolve(process.env.DATA_DIR || './data');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  dataDir,
  mediaDir: path.join(dataDir, 'media'),
  dbPath: path.join(dataDir, 'socio.db'),
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  },
  mail: {
    host: process.env.MAIL_HOST || '',
    port: parseInt(process.env.MAIL_PORT || '465', 10),
    secure: process.env.MAIL_SECURE === 'true' || !process.env.MAIL_PORT || process.env.MAIL_PORT === '465',
    user: process.env.MAIL_USER || '',
    pass: process.env.MAIL_PASS || '',
    from: process.env.MAIL_FROM || '',
  },
  linkedin: {
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
  },
  meta: {
    clientId: process.env.META_CLIENT_ID || '',
    clientSecret: process.env.META_CLIENT_SECRET || '',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
  },
};

module.exports = config;
