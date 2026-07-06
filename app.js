require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const { initDb } = require('./db/schema');

const app = express();
const PORT = process.env.PORT || 3000;

// For hosting behind Render/Railway proxy
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false }));

const UPLOADS_DIR = process.env.UPLOADS_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data', 'uploads')
  : path.join(__dirname, 'uploads');
const THUMBS_DIR = process.env.THUMBNAILS_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data', 'thumbnails')
  : path.join(__dirname, 'thumbnails');
const DATA_FILE = process.env.DATA_FILE || process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data', 'data.db')
  : path.join(__dirname, 'data.db');
[{ d: UPLOADS_DIR }, { d: THUMBS_DIR }].forEach(({ d }) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
process.env.UPLOADS_DIR = UPLOADS_DIR;
process.env.THUMBNAILS_DIR = THUMBS_DIR;
process.env.DATA_FILE = DATA_FILE;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/thumbnails', express.static(THUMBS_DIR));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' }
});
app.use(limiter);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  res.locals.buildPageUrl = function(page) {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    url.searchParams.set('page', page);
    return url.pathname + url.search;
  };
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/gallery'));
app.use('/admin', require('./routes/admin'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', message: 'Page not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong' });
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Street Media running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
