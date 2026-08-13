const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const MINUTE = 60 * 1000;

function userKey(req, res) {
  return res.locals.user || ipKeyGenerator(req.ip);
}

function perUserLimiter(max, message) {
  return rateLimit({
    windowMs: MINUTE,
    limit: max,
    keyGenerator: userKey,
    standardHeaders: true,
    legacyHeaders: false,
    message,
  });
}

const loginLimiter = rateLimit({
  windowMs: MINUTE,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again in a minute.',
});

module.exports = { loginLimiter, perUserLimiter };
