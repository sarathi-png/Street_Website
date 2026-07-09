const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/schema');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { generateVideoThumb, probeVideoCodec } = require('./helpers');

const config = require('../config');

const router = express.Router();

const UPLOADS_DIR = config.UPLOADS_DIR;
const THUMBS_DIR = config.THUMBS_DIR;

// In-memory import jobs for SSE progress tracking
const importJobs = {};
let importJobCounter = 0;

// Tag helpers
function getMediaTags(mediaId) {
  const tags = dbAll(`SELECT t.name FROM media_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.media_id = ?`, mediaId);
  return tags.map(t => t.name);
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

const UPLOAD_MAX_SIZE = config.UPLOAD_MAX_SIZE;
const ALLOWED_TYPES = config.ALLOWED_TYPES;

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => { cb(null, uuidv4() + path.extname(file.originalname).toLowerCase()); }
});
const upload = multer({
  storage, limits: { fileSize: UPLOAD_MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required' });
  next();
}

function driveApiGet(path, apiKey) {
  return new Promise((resolve, reject) => {
    const url = `https://www.googleapis.com/drive/v3${path}&key=${apiKey}`;
    https.get(url, { headers: { 'User-Agent': 'StreetGallery/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); if (j.error) reject(new Error(j.error.message)); else resolve(j); }
        catch (e) { reject(new Error('Drive API parse error')); }
      });
    }).on('error', reject);
  });
}

async function listDriveFolderFiles(folderId, apiKey) {
  const allFiles = [];
  let pageToken = null;
  do {
    const token = pageToken ? `&pageToken=${pageToken}` : '';
    const result = await driveApiGet(`/files?q='${folderId}'+in+parents&fields=files(id,name,mimeType,size,fileExtension,fullFileExtension)&pageSize=100${token}`, apiKey);
    (result.files || []).forEach(f => { if (!f.mimeType.startsWith('application/vnd.google-apps')) allFiles.push(f); });
    pageToken = result.nextPageToken || null;
  } while (pageToken);
  return allFiles;
}

function downloadDriveFile(fileId, destPath, apiKey) {
  return new Promise((resolve, reject) => {
    function doDownload(url, redirectsLeft) {
      const file = fs.createWriteStream(destPath);
      let aborted = false;
      function cleanup(errMsg) {
        if (aborted) return;
        aborted = true;
        try { file.close(); } catch (e) {}
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
        reject(new Error(errMsg || 'Download failed'));
      }
      https.get(url, { headers: { 'User-Agent': 'StreetGallery/1.0' }, timeout: 600000 }, (res) => {
        // Handle redirects
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && redirectsLeft > 0) {
          const loc = res.headers.location;
          if (!loc) { res.resume(); cleanup('Redirect with no location'); return; }
          res.resume();
          const cookies = res.headers['set-cookie'];
          const opts = { headers: { 'User-Agent': 'StreetGallery/1.0', 'Accept': '*/*' } };
          if (cookies) opts.headers['Cookie'] = cookies.join('; ');
          https.get(loc, opts, (r2) => {
            r2.redirectCount = redirectsLeft - 1;
            doDownloadResponse(r2, redirectsLeft - 1, file, cleanup, resolve);
          }).on('error', (e) => cleanup('Redirect error: ' + e.message));
          return;
        }
        doDownloadResponse(res, redirectsLeft, file, cleanup, resolve);
      }).on('error', (e) => cleanup('Request error: ' + e.message))
        .on('timeout', function() { this.destroy(); cleanup('Download timed out after 10 min'); });
    }

    function doDownloadResponse(res, redirectsLeft, file, cleanup, resolve) {
      if (res.statusCode === 200) {
        const ct = res.headers['content-type'] || '';
        if (ct.includes('text/html')) {
          let html = '';
          res.on('data', c => html += c);
          res.on('end', () => {
            try { file.close(); } catch (e) {}
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
            const m = html.match(/action=.*[?&]confirm=([a-zA-Z0-9_-]+)/);
            const confirmToken = m ? m[1] : 't';
            const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}`;
            doDownload(confirmUrl, redirectsLeft);
          });
          return;
        }
        res.pipe(file);
        res.on('error', (e) => cleanup('Stream error: ' + e.message));
        file.on('finish', () => { if (!aborted) resolve(); });
        file.on('error', (e) => cleanup('File write error: ' + e.message));
      } else {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if ((res.statusCode === 403 || res.statusCode === 429) && apiKey) {
            // Fallback to public URL
            try { file.close(); } catch (e) {}
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (e) {}
            const publicUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
            doDownload(publicUrl, 3);
          } else {
            cleanup(`Drive returned ${res.statusCode}: ${d.slice(0, 200)}`);
          }
        });
      }
    }

    if (apiKey) {
      const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
      doDownload(url, 0);
    } else {
      const publicUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
      doDownload(publicUrl, 3);
    }
  });
}

async function importDriveFile(fileId, title, categoryId, userId, driveFileInfo, apiKey) {
  const driveName = driveFileInfo && driveFileInfo.name ? driveFileInfo.name : 'Imported';
  const origExt = driveFileInfo && driveFileInfo.fileExtension ? '.' + driveFileInfo.fileExtension
    : (driveFileInfo && driveFileInfo.name ? path.extname(driveFileInfo.name) : '');
  const ext = origExt || '';
  const mimeType = driveFileInfo && driveFileInfo.mimeType ? driveFileInfo.mimeType : (ext === '.mp4' ? 'video/mp4' : 'image/jpeg');
  const isVideo = mimeType.startsWith('video/');
  const isAudio = mimeType.startsWith('audio/');
  const type = isVideo ? 'video' : (isAudio ? 'audio' : 'photo');
  const displayTitle = title || driveName.replace(ext, '');

  // Drive-first: never download the file or generate thumbnails on the server.
  // Playback uses Google's /preview iframe; thumbnails use the public
  // https://drive.google.com/thumbnail?id=<id> URL (no API key required).
  dbRun(`INSERT INTO media (title, type, filename, thumbnail, file_size, mime_type, drive_file_id, category_id, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    displayTitle, type, fileId, null, parseInt(driveFileInfo && driveFileInfo.size) || 0,
    mimeType, fileId, categoryId || null, userId);
}

function extractDriveId(url) {
  const patterns = [
    { re: /\/drive\/folders\/([a-zA-Z0-9_.-]+)/, type: 'folder' },
    { re: /\/file\/d\/([a-zA-Z0-9_.-]+)/, type: 'file' },
    { re: /\/d\/([a-zA-Z0-9_.-]+)/, type: 'file' },
    { re: /[?&]id=([a-zA-Z0-9_.-]+)/, type: 'file' },
    { re: /\/uc\?.*[?&]id=([a-zA-Z0-9_.-]+)/, type: 'file' }
  ];
  for (const p of patterns) {
    const m = url.match(p.re);
    if (m) return { id: m[1], type: p.type };
  }
  return null;
}

router.get('/', requireAdmin, (req, res) => {
  const stats = {
    mediaCount: dbGet('SELECT COUNT(*) as c FROM media').c,
    photoCount: dbGet("SELECT COUNT(*) as c FROM media WHERE type = 'photo'").c,
    videoCount: dbGet("SELECT COUNT(*) as c FROM media WHERE type = 'video'").c,
    audioCount: dbGet("SELECT COUNT(*) as c FROM media WHERE type = 'audio'").c,
    categoryCount: dbGet('SELECT COUNT(*) as c FROM categories').c,
    userCount: dbGet('SELECT COUNT(*) as c FROM users').c,
    totalDownloads: dbGet('SELECT COALESCE(SUM(downloads), 0) as c FROM media').c,
    totalSize: dbGet('SELECT COALESCE(SUM(file_size), 0) as c FROM media').c,
    recentMedia: dbAll(`SELECT m.*, c.name as category_name FROM media m
      LEFT JOIN categories c ON m.category_id = c.id ORDER BY m.created_at DESC LIMIT 10`),
    // Analytics data
    topMedia: dbAll(`SELECT id, title, type, views, likes, downloads FROM media
      ORDER BY views DESC LIMIT 5`),
    viewsByDay: dbAll(`SELECT date(created_at) as day, COUNT(*) as count,
      SUM(views) as total_views FROM media GROUP BY date(created_at) ORDER BY day DESC LIMIT 30`),
    mediaByCategory: dbAll(`SELECT c.name, COUNT(m.id) as count FROM categories c
      LEFT JOIN media m ON c.id = m.category_id GROUP BY c.id ORDER BY count DESC`)
  };
  res.render('admin/dashboard', { title: 'Dashboard', stats });
});

router.get('/media', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 25;
  const total = dbGet('SELECT COUNT(*) as c FROM media').c;
  const totalPages = Math.ceil(total / perPage);

  const media = dbAll(`SELECT m.*, c.name as category_name, u.display_name as uploader_name
    FROM media m LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN users u ON m.uploaded_by = u.id ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
    perPage, (page - 1) * perPage);
  const categories = dbAll('SELECT * FROM categories ORDER BY name');

  const tagsMap = {};
  media.forEach(m => { tagsMap[m.id] = getMediaTags(m.id); });

  res.render('admin/media', { title: 'Media', media, categories, tagsMap, currentPage: page, totalPages, total });
});

router.post('/media/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { title, category_id, description, tags } = req.body;
    const file = req.file;
    const isVideo = file.mimetype.startsWith('video/');
    const isAudio = file.mimetype.startsWith('audio/');
    const mediaType = isVideo ? 'video' : (isAudio ? 'audio' : 'photo');
    let thumbFilename = isAudio ? null : ('thumb_' + file.filename.replace(path.extname(file.filename), '.jpg'));

    let duration = 0;
    let videoCodec = null;
    if (isVideo || isAudio) {
      try {
        const proc = spawn(ffmpegPath, ['-i', file.path, '-show_entries', 'format=duration', '-v', 'quiet', '-of', 'csv=p=0']);
        const chunks = [];
        proc.stdout.on('data', c => chunks.push(c));
        await new Promise((resolve) => { proc.on('close', resolve); proc.on('error', resolve); });
        duration = parseFloat(Buffer.concat(chunks).toString().trim()) || 0;
        if (isVideo) videoCodec = await probeVideoCodec(file.path);
      } catch (e) {}
    }

    try {
      if (isVideo) {
        await generateVideoThumb(file.path, path.join(THUMBS_DIR, thumbFilename));
      } else if (!isAudio) {
        await sharp(file.path).resize(400, 300, { fit: 'cover' }).jpeg({ quality: 80 })
          .toFile(path.join(THUMBS_DIR, thumbFilename));
      }
    } catch (e) {
      console.error('Thumbnail generation failed:', e.message);
      if (!isAudio) thumbFilename = null;
    }

    dbRun(`INSERT INTO media (title, type, filename, thumbnail, file_size, mime_type, description, duration, category_id, uploaded_by, video_codec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      title || file.originalname.replace(path.extname(file.originalname), ''),
      mediaType, file.filename, thumbFilename, file.size, file.mimetype,
      description || '', duration, category_id || null, req.session.user.id, videoCodec);

    const newMedia = dbGet('SELECT id FROM media ORDER BY id DESC LIMIT 1');
    if (newMedia && tags) syncMediaTags(newMedia.id, tags.split(',').map(t => t.trim()));

    res.redirect('/admin/media?msg=Uploaded+successfully');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

router.post('/media/import-drive', requireAdmin, async (req, res) => {
  try {
    const { drive_url, title, category_id } = req.body;
    if (!drive_url) return res.status(400).json({ error: 'Google Drive URL required' });

    const extracted = extractDriveId(drive_url);
    if (!extracted) return res.status(400).json({ error: 'Could not extract ID from URL' });

    const apiKey = config.GOOGLE_DRIVE_API_KEY;
    if (!apiKey && extracted.type === 'folder') return res.status(400).json({ error: 'GOOGLE_DRIVE_API_KEY not set' });

    if (extracted.type === 'folder') {
      let allFiles;
      try {
        allFiles = await listDriveFolderFiles(extracted.id, apiKey);
      } catch (e) {
        return res.status(400).json({ error: 'Failed to list folder: ' + e.message });
      }
      if (allFiles.length === 0) return res.status(400).json({ error: 'No downloadable files found in this folder' });

      const jobId = ++importJobCounter;
      importJobs[jobId] = { total: allFiles.length, current: 0, errors: 0, lastError: '', done: false, message: '' };
      const userId = req.session.user.id;

      function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
      function jitter(ms) { return ms + Math.random() * 1000; }

      setImmediate(async () => {
        const CONCURRENCY = 3;
        const queue = [...allFiles];
        let active = 0;

        async function processNext() {
          while (queue.length > 0 && active < CONCURRENCY) {
            const f = queue.shift();
            active++;
            (async () => {
              let ok = false;
              const backoffs = [1000, 3000, 5000];
              for (let attempt = 0; attempt <= 2 && !ok; attempt++) {
                if (attempt > 0) await delay(jitter(backoffs[attempt - 1]));
                try {
                  await importDriveFile(f.id, title ? title + ' - ' + f.name : f.name, category_id, userId, f, apiKey);
                  ok = true;
                } catch (e) {
                  const msg = `${f.name}: ${e.message}`;
                  console.error('Failed attempt ' + (attempt + 1) + ':', msg);
                  importJobs[jobId].lastError = msg;
                }
              }
              if (!ok) importJobs[jobId].errors++;
              importJobs[jobId].current++;
              active--;
              processNext();
            })();
            await delay(200);
          }
          if (active === 0 && queue.length === 0) {
            const ok = importJobs[jobId].current - importJobs[jobId].errors;
            importJobs[jobId].done = true;
            importJobs[jobId].message = `Imported ${ok} of ${importJobs[jobId].total} files`;
            setTimeout(() => { delete importJobs[jobId]; }, 120000);
          }
        }

        processNext();
      });

      return res.json({ jobId });
    } else {
      let fileInfo = null;
      if (apiKey) {
        try { fileInfo = await driveApiGet(`/files/${extracted.id}?fields=id,name,mimeType,size,fileExtension`, apiKey); }
        catch (e) { /* non-fatal */ }
      }
      await importDriveFile(extracted.id, title || 'Imported from Drive', category_id, req.session.user.id, fileInfo, apiKey);
      return res.json({ jobId: null, message: 'Imported successfully' });
    }
  } catch (err) {
    console.error('Drive import error:', err);
    return res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

function downloadFromUrl(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'StreetGallery/1.0' }, timeout: 600000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFromUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('URL returned ' + res.statusCode));
      }
      const contentType = res.headers['content-type'] || '';
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

router.post('/media/import-url', requireAdmin, async (req, res) => {
  try {
    const { url, title, category_id, tags } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    const { data, contentType } = await downloadFromUrl(url);
    const ext = path.extname(new URL(url).pathname) || '.bin';
    const finalFilename = uuidv4() + ext;

    const mimeType = contentType || 'application/octet-stream';
    const isVideo = mimeType.startsWith('video/');
    const isAudio = mimeType.startsWith('audio/');
    const mediaType = isVideo ? 'video' : (isAudio ? 'audio' : 'photo');

    const filePath = path.join(UPLOADS_DIR, finalFilename);
    fs.writeFileSync(filePath, data);

    let thumbFilename = null;
    if (!isAudio) {
      thumbFilename = 'thumb_' + finalFilename.replace(ext, '.jpg');
      try {
        if (isVideo) {
          await generateVideoThumb(filePath, path.join(THUMBS_DIR, thumbFilename));
        } else {
          await sharp(filePath).resize(400, 300, { fit: 'cover' }).jpeg({ quality: 80 })
            .toFile(path.join(THUMBS_DIR, thumbFilename));
        }
      } catch (e) {
        console.error('URL import thumbnail failed:', e.message);
        thumbFilename = null;
      }
    }

    let duration = 0;
    let videoCodec = null;
    if (isVideo || isAudio) {
      try {
        const proc = spawn(ffmpegPath, ['-i', filePath, '-show_entries', 'format=duration', '-v', 'quiet', '-of', 'csv=p=0']);
        const chunks = [];
        proc.stdout.on('data', c => chunks.push(c));
        await new Promise((resolve) => { proc.on('close', resolve); proc.on('error', resolve); });
        duration = parseFloat(Buffer.concat(chunks).toString().trim()) || 0;
        if (isVideo) videoCodec = await probeVideoCodec(filePath);
      } catch (e) {}
    }

    dbRun(`INSERT INTO media (title, type, filename, thumbnail, file_size, mime_type, description, duration, category_id, uploaded_by, video_codec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      title || path.basename(new URL(url).pathname) || 'Imported from URL',
      mediaType, finalFilename, thumbFilename, data.length, mimeType,
      '', duration, category_id || null, req.session.user.id, videoCodec);

    const newMedia = dbGet('SELECT id FROM media ORDER BY id DESC LIMIT 1');
    if (newMedia && tags) syncMediaTags(newMedia.id, tags.split(',').map(t => t.trim()));

    res.json({ success: true, message: 'Imported successfully' });
  } catch (err) {
    console.error('URL import error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

router.get('/import-progress/:jobId', requireAdmin, (req, res) => {
  const jobId = parseInt(req.params.jobId);
  const job = importJobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let timer;
  function send() {
    if (!importJobs[jobId]) { res.write('event: error\ndata: {}\n\n'); res.end(); return; }
    const j = importJobs[jobId];
    res.write(`data: ${JSON.stringify({ current: j.current, total: j.total, errors: j.errors, lastError: j.lastError })}\n\n`);
    j.lastError = '';
    if (j.done) { res.write(`event: done\ndata: ${JSON.stringify({ message: j.message })}\n\n`); res.end(); }
    else { timer = setTimeout(send, 600); }
  }
  req.on('close', () => { clearTimeout(timer); });
  timer = setTimeout(send, 300);
});

router.post('/media/edit/:id', requireAdmin, (req, res) => {
  const { title, category_id, description, tags } = req.body;
  dbRun('UPDATE media SET title = ?, category_id = ?, description = ? WHERE id = ?', title, category_id || null, description || '', req.params.id);
  if (tags !== undefined) syncMediaTags(req.params.id, tags.split(',').map(t => t.trim()));
  res.redirect('/admin/media?msg=Media+updated');
});

router.post('/media/delete/:id', requireAdmin, (req, res) => {
  const item = dbGet('SELECT * FROM media WHERE id = ?', req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(UPLOADS_DIR, item.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  if (item.thumbnail) { const tp = path.join(THUMBS_DIR, item.thumbnail); if (fs.existsSync(tp)) fs.unlinkSync(tp); }
  dbRun('DELETE FROM media WHERE id = ?', req.params.id);
  res.redirect('/admin/media?msg=Media+deleted');
});

router.post('/media/bulk-delete', requireAdmin, (req, res) => {
  const ids = (req.body.ids || '').split(',').map(Number).filter(Boolean);
  ids.forEach(id => {
    const item = dbGet('SELECT * FROM media WHERE id = ?', id);
    if (!item) return;
    const fp = path.join(UPLOADS_DIR, item.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (item.thumbnail) { const tp = path.join(THUMBS_DIR, item.thumbnail); if (fs.existsSync(tp)) fs.unlinkSync(tp); }
    dbRun('DELETE FROM media WHERE id = ?', id);
  });
  res.redirect('/admin/media?msg=Items+deleted');
});

router.post('/media/bulk-move', requireAdmin, (req, res) => {
  const ids = (req.body.ids || '').split(',').map(Number).filter(Boolean);
  const catId = req.body.category_id || null;
  if (ids.length) dbRun(`UPDATE media SET category_id = ? WHERE id IN (${ids.join(',')})`, catId);
  res.redirect('/admin/media?msg=Items+moved');
});

router.get('/categories', requireAdmin, (req, res) => {
  const categories = dbAll(`SELECT c.*, COUNT(m.id) as media_count FROM categories c
    LEFT JOIN media m ON m.category_id = c.id GROUP BY c.id ORDER BY c.name`);
  res.render('admin/categories', { title: 'Categories', categories });
});

router.post('/categories/create', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    dbRun('INSERT INTO categories (name, description) VALUES (?, ?)', name, description || '');
    res.redirect('/admin/categories?msg=Category+created');
  } catch (err) { res.status(400).json({ error: 'Category name already exists' }); }
});

router.post('/categories/edit/:id', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  dbRun('UPDATE categories SET name = ?, description = ? WHERE id = ?', name, description || '', req.params.id);
  res.redirect('/admin/categories?msg=Category+updated');
});

router.post('/categories/delete/:id', requireAdmin, (req, res) => {
  dbRun('DELETE FROM categories WHERE id = ?', req.params.id);
  res.redirect('/admin/categories?msg=Category+deleted');
});

router.get('/users', requireAdmin, (req, res) => {
  const users = dbAll('SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at DESC');
  res.render('admin/users', { title: 'Users', users });
});

router.post('/users/create', requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    dbRun('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      username, hash, display_name || username, role || 'member');
    res.redirect('/admin/users?msg=User+created');
  } catch (err) { res.status(400).json({ error: 'Username already exists' }); }
});

router.post('/users/delete/:id', requireAdmin, (req, res) => {
  const user = dbGet('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user || user.role === 'admin') return res.status(400).json({ error: user ? 'Cannot delete admin' : 'Not found' });
  dbRun('DELETE FROM users WHERE id = ?', req.params.id);
  res.redirect('/admin/users?msg=User+deleted');
});

router.post('/users/reset-password/:id', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  dbRun('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), req.params.id);
  res.redirect('/admin/users?msg=Password+reset');
});

// ===== Thumbnail generation jobs =====
const thumbJobs = {};
let thumbJobCounter = 0;



router.get('/media/missing-thumbnails-count', requireAdmin, (req, res) => {
  // Drive thumbnails render on-demand from Google's public thumbnail URL,
  // so only count locally-stored media that genuinely lack a thumbnail.
  const count = dbGet("SELECT COUNT(*) as c FROM media WHERE type = 'video' AND thumbnail IS NULL AND drive_file_id IS NULL").c;
  res.json({ count });
});

router.post('/media/generate-drive-thumbnails', requireAdmin, async (req, res) => {
  // Drive videos don't need server-side thumbnail generation: the gallery
  // grid uses https://drive.google.com/thumbnail?id=<id>&sz=w400 directly
  // (no API key, no ffmpeg). This endpoint is kept for compatibility and
  // simply reports that no work is required.
  const count = dbGet("SELECT COUNT(*) as c FROM media WHERE type = 'video' AND thumbnail IS NULL AND drive_file_id IS NOT NULL").c;
  res.json({ jobId: null, message: `Drive thumbnails render on-demand from Google (${count} items). No generation needed.` });
});

router.get('/media/thumbnail-progress/:jobId', requireAdmin, (req, res) => {
  const jobId = parseInt(req.params.jobId);
  const job = thumbJobs[jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let timer;
  function send() {
    if (!thumbJobs[jobId]) { res.write('event: error\ndata: {}\n\n'); res.end(); return; }
    const j = thumbJobs[jobId];
    res.write(`data: ${JSON.stringify({ current: j.current, total: j.total, errors: j.errors, lastError: j.lastError })}\n\n`);
    j.lastError = '';
    if (j.done) { res.write(`event: done\ndata: ${JSON.stringify({ message: j.message })}\n\n`); res.end(); }
    else { timer = setTimeout(send, 600); }
  }
  req.on('close', () => { clearTimeout(timer); });
  timer = setTimeout(send, 300);
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File too large. Max ${config.UPLOAD_MAX_SIZE / (1024 * 1024)}MB` });
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
