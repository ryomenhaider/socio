const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('pages/landing', { title: 'Socio', active: null });
});

router.get('/terms', (req, res) => {
  res.render('pages/terms', { title: 'Terms of Service', active: null });
});

router.get('/privacy', (req, res) => {
  res.render('pages/privacy', { title: 'Privacy Policy', active: null });
});

module.exports = router;
