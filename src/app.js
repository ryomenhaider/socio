const express = require('express');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const authRoutes = require('./routes/auth.routes');
const accountRoutes = require('./routes/accounts.routes');
const postRoutes = require('./routes/posts.routes');
const settingRoutes = require('./routes/settings.routes');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'web', 'views'));
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/media', express.static(config.mediaDir, { fallthrough: true }));
app.use(express.static(path.join(__dirname, 'web', 'static')));

app.use((req, res, next) => {
  res.locals.baseUrl = config.baseUrl;
  next();
});

app.get('/healthz', (req, res) => {
  db.prepare('SELECT 1').get();
  res.send('ok');
});

app.use(authRoutes);
app.use(accountRoutes);
app.use(postRoutes);
app.use(settingRoutes);

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
