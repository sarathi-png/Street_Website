const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const DB_PATH = process.env.DATA_FILE || path.join(__dirname, '..', 'data.db');
let db = null;
let SQL = null;

async function getDb() {
  if (db) return db;
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  try { db.run('PRAGMA journal_mode = WAL'); } catch (e) {}
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbGet(sql, ...params) {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const result = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return result;
  } catch (err) {
    stmt.free(); throw err;
  }
}

function dbAll(sql, ...params) {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (err) {
    stmt.free(); throw err;
  }
}

function dbRun(sql, ...params) {
  try {
    if (params.length) db.run(sql, params); else db.run(sql);
    saveDb();
  } catch (err) {
    throw new Error(`${err.message}\nSQL: ${sql}`);
  }
}

function dbExec(sql) { db.exec(sql); saveDb(); }

async function initDb() {
  await getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('photo', 'video')),
      filename TEXT NOT NULL,
      thumbnail TEXT,
      file_size INTEGER DEFAULT 0,
      mime_type TEXT DEFAULT '',
      drive_file_id TEXT,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      uploaded_by INTEGER REFERENCES users(id),
      downloads INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_tags (
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (media_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, media_id)
    );
    CREATE TABLE IF NOT EXISTS watch_positions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      position_seconds REAL DEFAULT 0,
      duration_seconds REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, media_id)
    );
  `);
  // Add columns for existing DBs (safe if already present)
  try { db.run('ALTER TABLE media ADD COLUMN likes INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE media ADD COLUMN views INTEGER DEFAULT 0'); } catch (e) {}
  try { db.run('ALTER TABLE media ADD COLUMN drive_file_id TEXT'); } catch (e) {}
  try { db.run('ALTER TABLE media ADD COLUMN description TEXT DEFAULT ""'); } catch (e) {}
  try { db.run('ALTER TABLE media ADD COLUMN duration REAL DEFAULT 0'); } catch (e) {}
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_media_category ON media(category_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_media_type ON media(type)');
    db.run('CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_shared_token ON shared_links(token)');
    db.run('CREATE INDEX IF NOT EXISTS idx_media_views ON media(views DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_media_likes ON media(likes DESC)');
    db.run('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_watch_user ON watch_positions(user_id)');
  } catch (e) {}

  const adminStmt = db.prepare('SELECT id FROM users WHERE username = ?');
  adminStmt.bind(['admin']);
  const adminExists = adminStmt.step();
  adminStmt.free();

  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)', ['admin', hash, 'Admin', 'admin']);
    console.log('Default admin created: admin / admin123');
  }
  saveDb();
  process.on('exit', saveDb);
  process.on('SIGINT', () => { saveDb(); process.exit(); });
  process.on('SIGTERM', () => { saveDb(); process.exit(); });
  return db;
}

module.exports = { initDb, getDb, dbGet, dbAll, dbRun, dbExec, saveDb };
