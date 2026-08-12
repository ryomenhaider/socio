const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const config = require('../config');

const MAX_FILE_COUNT = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

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
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILE_COUNT },
  fileFilter: (req, file, cb) => {
    if (isMediaAllowed(file)) cb(null, true);
    else cb(new Error('Only image or video files are allowed.'));
  },
});

function mediaTypeFromMime(mime) {
  return (mime || '').startsWith('video/') ? 'video' : 'image';
}

module.exports = { upload, mediaTypeFromMime };
