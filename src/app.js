const express = require('express');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const { parseCookies, requireAuth } = require('./auth');
const publicRoutes = require('./routes/public.routes');
const sessionRoutes = require('./routes/session.routes');
const authRoutes = require('./routes/auth.routes');
const accountRoutes = require('./routes/accounts.routes');
const postRoutes = require('./routes/posts.routes');
const copyRoutes = require('./routes/copy.routes');
const feedbackRoutes = require('./routes/feedback.routes');

const app = express();

app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'web', 'views'));
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  res.locals.baseUrl = config.baseUrl;
  res.locals.user = null;
  next();
});

app.use(express.static(path.join(__dirname, 'web', 'static')));

app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.send('ok');
});

app.use(publicRoutes);
app.use(sessionRoutes);

app.use(requireAuth);

app.use('/media', express.static(config.mediaDir, { fallthrough: true }));
app.use(authRoutes);
app.use(accountRoutes);
app.use(postRoutes);
app.use(copyRoutes);
app.use(feedbackRoutes);

app.use((req, res) => {
  res.status(404).render('pages/error', { title: 'Not found', code: 404, message: 'Page not found.' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).render('pages/error', {
    title: 'Server error',
    code: 500,
    message: String(err.message || err),
  });
});

module.exports = app;
