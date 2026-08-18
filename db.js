const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'indichat.sqlite');

let sqlDb = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT,
    group_id TEXT,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    read INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(from_user, to_user);
  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
`;

function persist() {
  const data = sqlDb.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// Mimics the better-sqlite3 prepare().run()/.get()/.all() API so the rest
// of the app can use familiar syntax, backed by sql.js underneath.
function prepare(sql) {
  return {
    run(...params) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      stmt.step();
      stmt.free();
      persist();
    },
    get(...params) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      let result;
      if (stmt.step()) result = stmt.getAsObject();
      stmt.free();
      return result;
    },
    all(...params) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
  };
}

async function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE)) {
    sqlDb = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    sqlDb = new SQL.Database();
  }

  sqlDb.exec(SCHEMA);
  persist();

  return { prepare };
}

module.exports = { init };
