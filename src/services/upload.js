const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.mediaDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

function isMediaAllowed(file) {
  if (!file) return true;
  const mime = file.mimetype || '';
  return mime.startsWith('image/') || mime.startsWith('video/');
}

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isMediaAllowed(file)) cb(null, true);
    else cb(new Error('Only image or video files are allowed.'));
  },
});

function mediaTypeFromMime(mime) {
  return (mime || '').startsWith('video/') ? 'video' : 'image';
}

module.exports = { upload, mediaTypeFromMime };
