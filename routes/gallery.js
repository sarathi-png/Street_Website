const express = require('express');
const { dbGet, dbAll, dbRun, rebuildFtsSearch } = require('../db/schema');
const path = require('path');
const fs = require('fs');
const https = require('https');
const archiver = require('archiver');
const crypto = require('crypto');
const { generateVideoThumb, probeVideoCodec } = require('./helpers');

const router = express.Router();
const PAGE_SIZE = 24;

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
const THUMBS_DIR = process.env.THUMBNAILS_DIR || path.join(__dirname, '..', 'thumbnails');

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
  const { category, search, type, sort, page, tag } = req.query;
  let joinClauses = '';
  let whereClauses = [];
  let params = [];

  if (category) { whereClauses.push('m.category_id = ?'); params.push(category); }
  if (search) {
    rebuildFtsSearch();
    // Escape FTS5 special characters and use prefix search
    const sanitized = search.replace(/['"]/g, '').replace(/[*^$~(){}[\]\\]/g, ' ').trim();
    if (sanitized.length > 0) {
      const ftsTerm = sanitized.split(/\s+/).map(w => w + '*').join(' ');
      joinClauses += ' JOIN media_fts f ON m.id = f.rowid';
      whereClauses.push('media_fts MATCH ?');
      params.push(ftsTerm);
    } else {
      whereClauses.push('(m.title LIKE ? OR m.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
  }
  if (type === 'photo' || type === 'video' || type === 'audio') { whereClauses.push('m.type = ?'); params.push(type); }
  if (tag) {
    joinClauses = ' JOIN media_tags mt ON m.id = mt.media_id JOIN tags t ON mt.tag_id = t.id';
    whereClauses.push('t.name = ?'); params.push(tag.toLowerCase());
  }

  const thisDay = req.query.thisday === '1';
  if (thisDay) {
    whereClauses.push("strftime('%m-%d', m.created_at) = strftime('%m-%d', 'now')");
  }

  const where = whereClauses.length ? ' WHERE ' + whereClauses.join(' AND ') : '';

  let orderBy = 'm.created_at DESC';
  if (sort === 'oldest') orderBy = 'm.created_at ASC';
  else if (sort === 'views') orderBy = 'm.views DESC';
  else if (sort === 'likes') orderBy = 'm.likes DESC';
  else if (sort === 'title') orderBy = 'm.title ASC';

  const countRow = dbGet(`SELECT COUNT(*) as total FROM media m${joinClauses}${where}`, ...params);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const media = dbAll(
    `SELECT DISTINCT m.*, c.name as category_name, u.display_name as uploader_name
     FROM media m${joinClauses} LEFT JOIN categories c ON m.category_id = c.id
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
    title: tag ? 'Tag: ' + tag : (thisDay ? 'On This Day' : 'Gallery'),
    media: media.map(m => ({ ...m, tags: tagMap[m.id] || [], isFavorite: favoriteIds.has(m.id) })),
    categories: dbAll('SELECT * FROM categories ORDER BY name'),
    currentCategory: category || '',
    search: search || '',
    currentType: type || '',
    currentSort: sort || 'newest',
    currentPage,
    totalPages,
    total,
    currentTag: tag || '',
    thisDayActive: thisDay
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

router.get('/map', requireAuth, (req, res) => {
  const media = dbAll(`SELECT m.id, m.title, m.type, m.thumbnail, m.filename, m.latitude, m.longitude,
    c.name as category_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    WHERE m.latitude IS NOT NULL AND m.longitude IS NOT NULL
    ORDER BY m.created_at DESC`);
  res.render('gallery/map', { title: 'Photo Map', media });
});

router.get('/user/:id', requireAuth, (req, res) => {
  const user = dbGet('SELECT id, username, display_name, created_at FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'User not found' });

  const { page } = req.query;
  const countRow = dbGet('SELECT COUNT(*) as total FROM media WHERE uploaded_by = ?', req.params.id);
  const total = countRow ? countRow.total : 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.max(1, parseInt(page) || 1);
  const offset = (currentPage - 1) * PAGE_SIZE;

  const media = dbAll(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id
    WHERE m.uploaded_by = ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `, req.params.id, PAGE_SIZE, offset);

  const tagMap = getMediaTagsForAll(media.map(m => m.id));
  const favoriteIds = new Set();
  if (req.session.user) {
    const favs = dbAll('SELECT media_id FROM favorites WHERE user_id = ?', req.session.user.id);
    favs.forEach(f => favoriteIds.add(f.media_id));
  }

  res.render('gallery/index', {
    title: user.display_name + "'s Uploads",
    media: media.map(m => ({ ...m, tags: tagMap[m.id] || [], isFavorite: favoriteIds.has(m.id) })),
    categories: [],
    currentCategory: '',
    search: '',
    currentType: '',
    currentSort: 'newest',
    currentPage,
    totalPages,
    total,
    isProfilePage: true,
    profileUser: user
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

// === Comment routes ===
router.get('/comments/:mediaId', (req, res) => {
  const comments = dbAll(`SELECT c.*, u.display_name as user_name
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.media_id = ? ORDER BY c.created_at ASC`, req.params.mediaId);
  // Build threaded structure
  const byId = {};
  const roots = [];
  comments.forEach(c => { byId[c.id] = { ...c, replies: [] }; });
  comments.forEach(c => {
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(byId[c.id]);
    else roots.push(byId[c.id]);
  });
  res.json(roots);
});

router.post('/comment/:mediaId', requireAuth, (req, res) => {
  const { body, parent_id } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Comment body required' });
  const item = dbGet('SELECT id FROM media WHERE id = ?', req.params.mediaId);
  if (!item) return res.status(404).json({ error: 'Media not found' });
  dbRun('INSERT INTO comments (media_id, user_id, body, parent_id) VALUES (?, ?, ?, ?)',
    req.params.mediaId, req.session.user.id, body.trim(), parent_id || null);
  const comment = dbGet(`SELECT c.*, u.display_name as user_name
    FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = (SELECT MAX(id) FROM comments)`);
  res.json(comment);
});

router.post('/comment/:id/delete', requireAuth, (req, res) => {
  const comment = dbGet('SELECT * FROM comments WHERE id = ? AND user_id = ?', req.params.id, req.session.user.id);
  if (!comment && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
  dbRun('DELETE FROM comments WHERE id = ?', req.params.id);
  res.json({ success: true });
});
// === End comment routes ===

router.post('/share/:id', requireAuth, (req, res) => {
  const item = dbGet('SELECT id FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const existing = dbGet('SELECT token FROM shared_links WHERE media_id = ?', req.params.id);
  if (existing) return res.json({ url: `/s/${existing.token}` });
  const token = crypto.randomBytes(6).toString('base64url');
  const expiresIn = parseInt(req.body.expires_in) || 0;
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 86400000).toISOString() : null;
  dbRun('INSERT INTO shared_links (media_id, token, expires_at) VALUES (?, ?, ?)', req.params.id, token, expiresAt);
  res.json({ url: `/s/${token}` });
});

router.get('/s/:token', (req, res) => {
  const link = dbGet('SELECT media_id, expires_at FROM shared_links WHERE token = ?', req.params.token);
  if (!link) return res.status(404).render('error', { title: 'Not Found', message: 'Share link invalid or expired' });
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    dbRun('DELETE FROM shared_links WHERE token = ?', req.params.token);
    return res.status(410).render('error', { title: 'Expired', message: 'This share link has expired' });
  }
  const item = dbGet(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id WHERE m.id = ?
  `, link.media_id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });
  const tags = getMediaTags(link.media_id);
  res.render('gallery/view', { title: item.title, item, prev: null, next: null, liked: false, isFavorite: false, tags, watchPosition: null });
});

// === Album routes ===
router.get('/albums', requireAuth, (req, res) => {
  const albums = dbAll(`SELECT a.*, u.display_name as owner_name,
    (SELECT COUNT(*) FROM album_items WHERE album_id = a.id) as item_count
    FROM albums a JOIN users u ON a.user_id = u.id
    WHERE a.user_id = ? OR EXISTS (SELECT 1 FROM album_items ai JOIN media m ON ai.media_id = m.id WHERE ai.album_id = a.id AND m.uploaded_by = ?)
    ORDER BY a.created_at DESC`, req.session.user.id, req.session.user.id);
  if (req.query.format === 'json') return res.json(albums);
  res.render('gallery/albums', { title: 'Albums', albums, userId: req.session.user.id });
});

router.get('/album/:id', requireAuth, (req, res) => {
  const album = dbGet('SELECT a.*, u.display_name as owner_name FROM albums a JOIN users u ON a.user_id = u.id WHERE a.id = ?', req.params.id);
  if (!album) return res.status(404).render('error', { title: 'Not Found', message: 'Album not found' });

  const media = dbAll(`
    SELECT m.*, c.name as category_name, u.display_name as uploader_name, ai.sort_order
    FROM album_items ai JOIN media m ON ai.media_id = m.id
    LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id
    WHERE ai.album_id = ? ORDER BY ai.sort_order, ai.added_at DESC
  `, req.params.id);

  const tagMap = getMediaTagsForAll(media.map(item => item.id));
  const favoriteIds = new Set();
  if (req.session.user) {
    const favs = dbAll('SELECT media_id FROM favorites WHERE user_id = ?', req.session.user.id);
    favs.forEach(f => favoriteIds.add(f.media_id));
  }

  res.render('gallery/index', {
    title: album.name,
    media: media.map(item => ({ ...item, tags: tagMap[item.id] || [], isFavorite: favoriteIds.has(item.id) })),
    categories: [],
    currentCategory: '',
    search: '',
    currentType: '',
    currentSort: 'newest',
    currentPage: 1,
    totalPages: 1,
    total: media.length,
    isAlbumPage: true,
    album: album
  });
});

router.post('/album/create', requireAuth, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Album name required' });
  dbRun('INSERT INTO albums (name, description, user_id) VALUES (?, ?, ?)',
    name.trim(), (description || '').trim(), req.session.user.id);
  res.json({ success: true, id: dbGet('SELECT MAX(id) as id FROM albums').id });
});

router.post('/album/:id/add', requireAuth, (req, res) => {
  const album = dbGet('SELECT * FROM albums WHERE id = ?', req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  const mediaId = parseInt(req.body.media_id);
  if (!mediaId) return res.status(400).json({ error: 'Media ID required' });
  dbRun('INSERT OR IGNORE INTO album_items (album_id, media_id) VALUES (?, ?)', req.params.id, mediaId);
  res.json({ success: true });
});

router.post('/album/:id/remove', requireAuth, (req, res) => {
  const album = dbGet('SELECT * FROM albums WHERE id = ? AND user_id = ?', req.params.id, req.session.user.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  dbRun('DELETE FROM album_items WHERE album_id = ? AND media_id = ?', req.params.id, parseInt(req.body.media_id));
  res.json({ success: true });
});

router.post('/album/:id/delete', requireAuth, (req, res) => {
  const album = dbGet('SELECT * FROM albums WHERE id = ? AND user_id = ?', req.params.id, req.session.user.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });
  dbRun('DELETE FROM albums WHERE id = ?', req.params.id);
  res.json({ success: true });
});
// === End album routes ===

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

function fetchDriveFile(fileId, destPath, apiKey, cb) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
  const file = fs.createWriteStream(destPath);
  let aborted = false;
  function done(err) {
    if (aborted) return;
    aborted = true;
    file.close();
    cb(err);
  }
  https.get(url, { headers: { 'User-Agent': 'StreetGallery/1.0' }, timeout: 600000 }, (driveRes) => {
    if (driveRes.statusCode === 403 || driveRes.statusCode === 429) {
      driveRes.resume();
      file.close();
      try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
      fetchDriveFilePublic(fileId, destPath, cb);
      return;
    }
    if (driveRes.statusCode !== 200) {
      let d = '';
      driveRes.on('data', c => d += c);
      driveRes.on('end', () => done(new Error(`Drive API returned ${driveRes.statusCode}`)));
      return;
    }
    driveRes.pipe(file);
    driveRes.on('error', done);
    file.on('finish', () => done(null));
    file.on('error', done);
  }).on('error', done);
}

function fetchDriveFilePublic(fileId, destPath, cb) {
  const file = fs.createWriteStream(destPath);
  let aborted = false;
  function done(err) {
    if (aborted) return;
    aborted = true; try { file.close(); } catch (e) {}
    if (err) try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
    cb(err);
  }

  function tryDownload(url, redirectsLeft) {
    https.get(url, { headers: { 'User-Agent': 'StreetGallery/1.0' }, timeout: 600000 }, (resp) => {
      // Handle redirects
      if ((resp.statusCode === 301 || resp.statusCode === 302 || resp.statusCode === 303) && redirectsLeft > 0) {
        const loc = resp.headers.location;
        if (!loc) { resp.resume(); done(new Error('Redirect with no location')); return; }
        resp.resume();
        const cookies = resp.headers['set-cookie'];
        const opts = { headers: { 'User-Agent': 'StreetGallery/1.0', 'Accept': '*/*' } };
        if (cookies) opts.headers['Cookie'] = cookies.join('; ');
        https.get(loc, opts, (r2) => tryDownloadResponse(r2, redirectsLeft - 1)).on('error', done);
        return;
      }
      tryDownloadResponse(resp, redirectsLeft);
    }).on('error', done);
  }

  function tryDownloadResponse(resp, redirectsLeft) {
    if (resp.statusCode !== 200) { resp.resume(); done(new Error('Public URL returned ' + resp.statusCode)); return; }

    const ct = resp.headers['content-type'] || '';
    // Google Drive returns HTML for virus scan warning — detect and auto-confirm
    if (ct.includes('text/html')) {
      let html = '';
      resp.on('data', c => html += c);
      resp.on('end', () => {
        // Try to extract confirm token from the warning form
        const m = html.match(/action=.*[?&]confirm=([a-zA-Z0-9_-]+)/);
        const confirmToken = m ? m[1] : 't';
        const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}`;
        tryDownload(confirmUrl, redirectsLeft);
      });
      return;
    }

    resp.pipe(file);
    resp.on('error', done);
    file.on('finish', () => done(null));
    file.on('error', done);
  }

  const firstUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`; // &confirm=t often bypasses the warning
  tryDownload(firstUrl, 3);
}

router.get('/stream/:id', requireAuth, (req, res) => {
  const item = dbGet('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });

  const filePath = path.join(UPLOADS_DIR, item.filename);

  // Serve from disk if cached and valid
  if (fs.existsSync(filePath)) {
    // Detect corrupted cache (Drive HTML warning page saved as binary)
    const sniff = Buffer.alloc(64);
    try {
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, sniff, 0, 64, 0);
      fs.closeSync(fd);
    } catch (e) {}
    if (sniff.toString('utf8', 0, 5).toLowerCase() === '<html') {
      fs.unlinkSync(filePath);
    } else {
      return serveFromDisk(item, filePath, req, res);
    }
  }

  // Not cached and not a Drive file — 404
  if (!item.drive_file_id) return res.status(404).render('error', { title: 'Not Found', message: 'File not found' });

  // Fetch from Drive, cache locally, then serve from disk
  const tmpPath = filePath + '.downloading';
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;

  const onFetched = (err) => {
    if (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      return res.status(502).json({ error: 'Video unavailable', message: 'Could not fetch from Drive. Try again later.' });
    }
    try { fs.renameSync(tmpPath, filePath); } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) {}
      return res.status(502).json({ error: 'Video unavailable' });
    }
    // Generate thumbnail async after caching (non-blocking)
    if (!item.thumbnail) {
      const thumbFilename = 'thumb_' + item.id + '.jpg';
      generateVideoThumb(filePath, path.join(THUMBS_DIR, thumbFilename)).then(() => {
        probeVideoCodec(filePath).then((codec) => {
          dbRun('UPDATE media SET thumbnail = ?, video_codec = ? WHERE id = ?', thumbFilename, codec, item.id);
        }).catch(() => {});
      }).catch(() => {});
    }
    serveFromDisk(item, filePath, req, res);
  };

  if (apiKey) {
    fetchDriveFile(item.drive_file_id, tmpPath, apiKey, onFetched);
  } else {
    fetchDriveFilePublic(item.drive_file_id, tmpPath, onFetched);
  }
});

router.get('/download/:id', requireAuth, (req, res) => {
  const item = dbGet('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).render('error', { title: 'Not Found', message: 'Media not found' });
  dbRun('UPDATE media SET downloads = downloads + 1 WHERE id = ?', req.params.id);

  const filePath = path.join(UPLOADS_DIR, item.filename);
  const filename = item.title + path.extname(item.filename);

  // Already cached locally
  if (fs.existsSync(filePath)) return res.download(filePath, filename);

  // Not cached and not a Drive file — 404
  if (!item.drive_file_id) return res.status(404).render('error', { title: 'Not Found', message: 'File not found' });

  // Fetch from Drive, cache, then serve
  const tmpPath = filePath + '.downloading';
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY;

  const onFetched = (err) => {
    if (err) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
      return res.status(502).json({ error: 'Download unavailable', message: 'Could not fetch from Drive. Try again later.' });
    }
    try { fs.renameSync(tmpPath, filePath); } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e2) {}
      return res.status(502).json({ error: 'Download unavailable' });
    }
    res.download(filePath, filename);
  };

  if (apiKey) {
    fetchDriveFile(item.drive_file_id, tmpPath, apiKey, onFetched);
  } else {
    fetchDriveFilePublic(item.drive_file_id, tmpPath, onFetched);
  }
});

module.exports = router;
