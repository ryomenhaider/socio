const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');

const MAX_FILE_COUNT = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4']);
const TEXT_MARKERS = ['<?xml', '<svg', '<!DOCTYPE', '<html', '<script'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.mediaDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

function isMediaAllowed(file) {
  if (!file) return true;
  return ALLOWED_MIME.has(file.mimetype || '');
}

function startsWith(buf, sig) {
  const s = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  if (buf.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[i] !== s[i]) return false;
  return true;
}

function magicOk(mime, buf) {
  switch (mime) {
    case 'image/png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(buf, 'GIF87a') || startsWith(buf, 'GIF89a');
    case 'image/webp':
      return startsWith(buf, 'RIFF') && buf.length >= 12 && buf.toString('latin1', 8, 12) === 'WEBP';
    case 'video/mp4':
      return buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp';
    default:
      return false;
  }
}

function validateMediaFile(file) {
  if (!file) return { ok: true };
  const mime = file.mimetype || '';
  if (!isMediaAllowed({ mimetype: mime })) return { ok: false, reason: 'type not allowed' };
  let buf;
  try {
    const fd = fs.openSync(file.path, 'r');
    try {
      const b = Buffer.alloc(64);
      const n = fs.readSync(fd, b, 0, 64, 0);
      buf = b.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, reason: 'unreadable file' };
  }
  if (magicOk(mime, buf)) return { ok: true };
  const head = buf.toString('latin1').toLowerCase();
  if (TEXT_MARKERS.some((m) => head.includes(m))) {
    return { ok: false, reason: 'content is markup (SVG/HTML/XML) — rejected regardless of claimed type' };
  }
  return { ok: false, reason: 'content does not match its claimed file type' };
}

function validateMediaFiles(files) {
  for (const f of files || []) {
    const r = validateMediaFile(f);
    if (!r.ok) return { ok: false, file: f.originalname, reason: r.reason };
  }
  return { ok: true };
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILE_COUNT },
  fileFilter: (req, file, cb) => {
    if (isMediaAllowed(file)) cb(null, true);
    else cb(new Error('Only image or video files are allowed.'));
  },
});

function mediaTypeFromMime(mime) {
  return (mime || '').startsWith('video/') ? 'video' : 'image';
}

module.exports = { upload, mediaTypeFromMime, validateMediaFiles };
