const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );

  ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
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
    timestamp BIGINT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    read INTEGER NOT NULL DEFAULT 0
  );

  ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_type TEXT;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited INTEGER NOT NULL DEFAULT 0;

  -- chat_key is the other user's id for direct chats, or 'group:<id>' for groups.
  -- Lets each person clear a chat for themselves without affecting the other side.
  CREATE TABLE IF NOT EXISTS chat_clears (
    owner_id TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    cleared_at BIGINT NOT NULL,
    PRIMARY KEY (owner_id, chat_key)
  );

  CREATE TABLE IF NOT EXISTS contacts (
    owner_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (owner_id, contact_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(from_user, to_user);
  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
`;

async function init() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is not set. Add your Postgres connection string.');
  }
  await pool.query(SCHEMA);

  return {
    // sql uses $1, $2... placeholders (Postgres style)
    async get(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async run(sql, params = []) {
      await pool.query(sql, params);
    },
  };
}

module.exports = { init };
