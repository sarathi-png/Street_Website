const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db/schema');
const path = require('path');
const fs = require('fs');
const https = require('https');
const archiver = require('archiver');
const crypto = require('crypto');

const router = express.Router();
const PAGE_SIZE = 24;

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

function getMediaTags(mediaId) {
  const tags = dbAll(`SELECT t.name FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id = ?`, mediaId);
  return tags.map(t => t.name);
}

function getMediaTagsForAll(mediaIds) {
  if (!mediaIds.length) return {};
  const tags = dbAll(`SELECT mt.media_id, t.name FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id IN (${mediaIds.join(',')})`);
  const map = {};
  tags.forEach(t => { if (!map[t.media_id]) map[t.media_id] = []; map[t.media_id].push(t.name); });
  return map;
}

function syncMediaTags(mediaId, tagNames) {
  dbRun('DELETE FROM media_tags WHERE media_id = ?', mediaId);
  if (!tagNames || !tagNames.length) return;
  const unique = [...new Set(tagNames.map(t => t.trim().toLowerCase()).filter(Boolean))];
  unique.forEach(name => {
    let tag = dbGet('SELECT id FROM tags WHERE name = ?', name);
    if (!tag) { dbRun('INSERT INTO tags (name) VALUES (?)', name); tag = dbGet('SELECT id FROM tags WHERE name = ?', name); }
    if (tag) dbRun('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)', mediaId, tag.id);
  });
}

router.get('/', requireAuth, (req, res) => {
  const { category, search, type, sort, page } = req.query;
  let whereClauses = [];
  let params = [];

  if (category) { whereClauses.push('m.category_id = ?'); params.push(category); }
  if (search) { whereClauses.push('(m.title LIKE ? OR m.description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (type === 'photo' || type === 'video') { whereClauses.push('m.type = ?'); params.push(type); }

  const where = whereClauses.length ? ' WHERE ' + whereClauses.join(' AND ') : '';

  let orderBy = 'm.created_at DESC';
  if (sort === 'oldest') orderBy = 'm.created_at ASC';
  else if (sort === 'views') orderBy = 'm.views DESC';
  else if (sort === 'likes') orderBy = 'm.likes DESC';
  else if (sort === 'title') orderBy = 'm.title ASC';

  const countRow = dbGet(`SELECT COUNT(*) as total FROM media m${where}`, ...params);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const media = dbAll(
    `SELECT m.*, c.name as category_name, u.display_name as uploader_name
     FROM media m LEFT JOIN categories c ON m.category_id = c.id
     LEFT JOIN users u ON m.uploaded_by = u.id
     ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ...params, PAGE_SIZE, offset
  );

  const tagMap = getMediaTagsForAll(media.map(m => m.id));

  const favoriteIds = new Set();
  if (req.session.user) {
    const favs = dbAll('SELECT media_id FROM favorites WHERE user_id = ?', req.session.user.id);
    favs.forEach(f => favoriteIds.add(f.media_id));
  }

  res.render('gallery/index', {
    title: 'Gallery',
    media: media.map(m => ({ ...m, tags: tagMap[m.id] || [], isFavorite: favoriteIds.has(m.id) })),
    categories: dbAll('SELECT * FROM categories ORDER BY name'),
    currentCategory: category || '',
    search: search || '',
    currentType: type || '',
    currentSort: sort || 'newest',
    currentPage,
    totalPages,
    total
  });
});

router.get('/category/:id', requireAuth, (req, res) => {
  const { sort, page } = req.query;
  const cat = dbGet('SELECT * FROM categories WHERE id = ?', req.params.id);
  if (!cat) return res.status(404).render('error', { title: 'Not Found', message: 'Category not found' });

  let orderBy = 'm.created_at DESC';
  if (sort === 'oldest') orderBy = 'm.created_at ASC';
  else if (sort === 'views') orderBy = 'm.views DESC';
  else if (sort === 'likes') orderBy = 'm.likes DESC';
  else if (sort === 'title') orderBy = 'm.title ASC';

  const countRow = dbGet('SELECT COUNT(*) as total FROM media m WHERE m.category_id = ?', req.params.id);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const media = dbAll(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id
    WHERE m.category_id = ? ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `, req.params.id, PAGE_SIZE, offset);

  const tagMap = getMediaTagsForAll(media.map(m => m.id));
  const favoriteIds = new Set();
  if (req.session.user) {
    const favs = dbAll('SELECT media_id FROM favorites WHERE user_id = ?', req.session.user.id);
    favs.forEach(f => favoriteIds.add(f.media_id));
  }

  res.render('gallery/index', {
    title: cat.name,
    media: media.map(m => ({ ...m, tags: tagMap[m.id] || [], isFavorite: favoriteIds.has(m.id) })),
    categories: [],
    currentCategory: req.params.id,
    search: '',
    currentType: '',
    currentSort: sort || 'newest',
    currentPage,
    totalPages,
    total
  });
});

router.get('/favorites', requireAuth, (req, res) => {
  const { page } = req.query;
  const countRow = dbGet('SELECT COUNT(*) as total FROM favorites WHERE user_id = ?', req.session.user.id);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const media = dbAll(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM favorites f JOIN media m ON f.media_id = m.id
    LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id
    WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ? OFFSET ?
  `, req.session.user.id, PAGE_SIZE, offset);

  const tagMap = getMediaTagsForAll(media.map(m => m.id));

  res.render('gallery/index', {
    title: 'My Favorites',
    media: media.map(m => ({ ...m, tags: tagMap[m.id] || [], isFavorite: true })),
    categories: [],
    currentCategory: '',
    search: '',
    currentType: '',
    currentSort: 'newest',
    currentPage,
    totalPages,
    total,
    isFavoritesPage: true
  });
});

router.get('/watch-later', requireAuth, (req, res) => {
  const { page } = req.query;
  const countRow = dbGet('SELECT COUNT(*) as total FROM watch_positions WHERE user_id = ?', req.session.user.id);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const media = dbAll(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name,
           wp.position_seconds, wp.duration_seconds
    FROM watch_positions wp JOIN media m ON wp.media_id = m.id
    LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id
    WHERE wp.user_id = ? ORDER BY wp.updated_at DESC LIMIT ? OFFSET ?
  `, req.session.user.id, PAGE_SIZE, offset);

  const tagMap = getMediaTagsForAll(media.map(m => m.id));
  const favoriteIds = new Set();
  const favs = dbAll('SELECT media_id FROM favorites WHERE user_id = ?', req.session.user.id);
  favs.forEach(f => favoriteIds.add(f.media_id));

  res.render('gallery/index', {
    title: 'Continue Watching',
    media: media.map(m => ({
      ...m, tags: tagMap[m.id] || [], isFavorite: favoriteIds.has(m.id),
      progress: m.duration_seconds > 0 ? Math.round((m.position_seconds / m.duration_seconds) * 100) : 0
    })),
    categories: [],
    currentCategory: '',
    search: '',
    currentType: '',
    currentSort: 'newest',
    currentPage,
    totalPages,
    total,
    isWatchLaterPage: true
  });
});

router.get('/media/:id', requireAuth, (req, res) => {
  const item = dbGet(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id WHERE m.id = ?
  `, req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });

  dbRun('UPDATE media SET views = views + 1 WHERE id = ?', req.params.id);
  item.views = (item.views || 0) + 1;

  const liked = req.session.likedMedia && req.session.likedMedia.includes(parseInt(req.params.id));
  const isFav = dbGet('SELECT 1 FROM favorites WHERE user_id = ? AND media_id = ?', req.session.user.id, req.params.id);
  const watchPos = dbGet('SELECT * FROM watch_positions WHERE user_id = ? AND media_id = ?', req.session.user.id, req.params.id);
  const tags = getMediaTags(req.params.id);

  const prev = dbGet(`SELECT id, title, thumbnail, type FROM media WHERE id < ? AND (? IS NULL OR category_id = ?) ORDER BY id DESC LIMIT 1`,
    req.params.id, item.category_id, item.category_id);
  const next = dbGet(`SELECT id, title, thumbnail, type FROM media WHERE id > ? AND (? IS NULL OR category_id = ?) ORDER BY id ASC LIMIT 1`,
    req.params.id, item.category_id, item.category_id);

  res.render('gallery/view', {
    title: item.title, item, prev, next, liked,
    isFavorite: !!isFav, tags, watchPosition: watchPos
  });
});

router.post('/like/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!req.session.likedMedia) req.session.likedMedia = [];
  if (req.session.likedMedia.includes(id)) {
    req.session.likedMedia = req.session.likedMedia.filter(i => i !== id);
    dbRun('UPDATE media SET likes = MAX(0, likes - 1) WHERE id = ?', id);
    return res.json({ liked: false });
  } else {
    req.session.likedMedia.push(id);
    dbRun('UPDATE media SET likes = likes + 1 WHERE id = ?', id);
    return res.json({ liked: true });
  }
});

router.post('/favorite/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const existing = dbGet('SELECT 1 FROM favorites WHERE user_id = ? AND media_id = ?', req.session.user.id, id);
  if (existing) {
    dbRun('DELETE FROM favorites WHERE user_id = ? AND media_id = ?', req.session.user.id, id);
    return res.json({ favorited: false });
  } else {
    dbRun('INSERT INTO favorites (user_id, media_id) VALUES (?, ?)', req.session.user.id, id);
    return res.json({ favorited: true });
  }
});

router.post('/watch-position/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { position, duration } = req.body;
  if (typeof position !== 'number' || typeof duration !== 'number') return res.status(400).json({ error: 'Invalid data' });
  dbRun(`INSERT INTO watch_positions (user_id, media_id, position_seconds, duration_seconds, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, media_id) DO UPDATE SET position_seconds = ?, duration_seconds = ?, updated_at = datetime('now')`,
    req.session.user.id, id, position, duration, position, duration);
  res.json({ ok: true });
});

router.post('/share/:id', requireAuth, (req, res) => {
  const item = dbGet('SELECT id FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const existing = dbGet('SELECT token FROM shared_links WHERE media_id = ?', req.params.id);
  if (existing) return res.json({ url: `/s/${existing.token}` });
  const token = crypto.randomBytes(6).toString('base64url');
  dbRun('INSERT INTO shared_links (media_id, token) VALUES (?, ?)', req.params.id, token);
  res.json({ url: `/s/${token}` });
});

router.get('/s/:token', (req, res) => {
  const link = dbGet('SELECT media_id FROM shared_links WHERE token = ?', req.params.token);
  if (!link) return res.status(404).render('error', { title: 'Not Found', message: 'Share link invalid or expired' });
  const item = dbGet(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id WHERE m.id = ?
  `, link.media_id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });
  const tags = getMediaTags(link.media_id);
  res.render('gallery/view', { title: item.title, item, prev: null, next: null, liked: false, isFavorite: false, tags, watchPosition: null });
});

router.get('/download/category/:id', requireAuth, (req, res) => {
  const cat = dbGet('SELECT * FROM categories WHERE id = ?', req.params.id);
  if (!cat) return res.status(404).json({ error: 'Category not found' });
  const media = dbAll("SELECT * FROM media WHERE category_id = ? AND type = 'photo'", req.params.id);
  if (media.length === 0) return res.status(404).json({ error: 'No photos in this category' });

  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${cat.name}.zip"` });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => { throw err; });
  archive.pipe(res);
  media.forEach(item => {
    const fp = path.join(UPLOADS_DIR, item.filename);
    if (fs.existsSync(fp)) archive.file(fp, { name: item.title + path.extname(item.filename) });
  });
  archive.finalize();
});

function serveFromDisk(item, filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = item.mime_type || 'application/octet-stream';

  if (fileSize === 0) return res.status(404).render('error', { title: 'Empty', message: 'File is empty' });

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).set({ 'Content-Range': `bytes */${fileSize}` }).end();
      return;
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': 'inline'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

function proxyFromDrive(item, req, res) {
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
  if (!apiKey) return res.status(502).json({ error: 'Drive API key not configured' });

  const mimeType = item.mime_type || 'video/mp4';
  const url = `https://www.googleapis.com/drive/v3/files/${item.drive_file_id}?alt=media&key=${apiKey}`;

  const headers = { 'User-Agent': 'StreetGallery/1.0' };
  if (req.headers.range) headers['Range'] = req.headers.range;

  https.get(url, { headers }, (driveRes) => {
    if (driveRes.statusCode !== 200 && driveRes.statusCode !== 206) {
      let d = '';
      driveRes.on('data', c => d += c);
      driveRes.on('end', () => {
        console.error(`Drive proxy failed: status=${driveRes.statusCode} body=${d.slice(0, 200)}`);
        res.status(502).json({ error: 'Video unavailable', driveStatus: driveRes.statusCode, message: 'Ensure the file is shared as "Anyone with the link" on Google Drive' });
      });
      return;
    }

    const respHeaders = {
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': 'inline',
    };
    if (driveRes.headers['content-range']) respHeaders['Content-Range'] = driveRes.headers['content-range'];
    if (driveRes.headers['content-length']) respHeaders['Content-Length'] = driveRes.headers['content-length'];

    res.writeHead(driveRes.statusCode, respHeaders);
    driveRes.pipe(res);
  });
}

router.get('/stream/:id', requireAuth, (req, res) => {
  const item = dbGet('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });

  // Drive files — always stream from Drive (no local cache)
  if (item.drive_file_id) return proxyFromDrive(item, req, res);

  // Local files — serve from disk
  const filePath = path.join(UPLOADS_DIR, item.filename);
  if (fs.existsSync(filePath)) return serveFromDisk(item, filePath, req, res);

  res.status(404).render('error', { title: 'Not Found', message: 'File not found' });
});

router.get('/download/:id', requireAuth, (req, res) => {
  const item = dbGet('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });
  dbRun('UPDATE media SET downloads = downloads + 1 WHERE id = ?', req.params.id);

  // Drive files — stream directly from Drive
  if (item.drive_file_id) {
    const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
    if (!apiKey) return res.status(502).json({ error: 'Drive API key not configured' });
    const url = `https://www.googleapis.com/drive/v3/files/${item.drive_file_id}?alt=media&key=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'StreetGallery/1.0' } }, (driveRes) => {
      if (driveRes.statusCode !== 200) return res.status(502).json({ error: 'Drive proxy failed' });
      const filename = item.title + path.extname(item.filename);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', item.mime_type || 'application/octet-stream');
      driveRes.pipe(res);
    });
    return;
  }

  // Local files — serve from disk
  const filePath = path.join(UPLOADS_DIR, item.filename);
  if (fs.existsSync(filePath)) return res.download(filePath, item.title + path.extname(item.filename));

  res.status(404).render('error', { title: 'Not Found', message: 'File not found' });
});

module.exports = router;
