const express = require('express');
const bcrypt = require('bcryptjs');
const { dbGet } = require('../db/schema');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Login', error: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('auth/login', { title: 'Login', error: 'Username and password required' });
  }
  const user = dbGet('SELECT * FROM users WHERE username = ?', username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('auth/login', { title: 'Login', error: 'Invalid username or password' });
  }
  req.session.user = { id: user.id, username: user.username, display_name: user.display_name, role: user.role };
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
