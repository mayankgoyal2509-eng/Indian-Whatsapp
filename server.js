const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dbInit = require('./db').init;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-in-production';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let db; // assigned once the database finishes initializing, see bottom of file

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function makeId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 8);
}

function publicUser(u) {
  return { id: u.id, name: u.name, phone: u.phone };
}

function signToken(user) {
  return jwt.sign({ id: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ---------- auth routes ----------

app.post('/api/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Name, phone and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) return res.status(409).json({ error: 'An account with this phone number already exists' });

  const user = {
    id: makeId(),
    name,
    phone,
    password_hash: bcrypt.hashSync(password, 10),
    created_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO users (id, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, user.name, user.phone, user.password_hash, user.created_at);

  res.json({ user: publicUser(user), token: signToken(user) });
});

app.post('/api/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect phone number or password' });
  }

  res.json({ user: publicUser(user), token: signToken(user) });
});

// ---------- contacts ----------

app.get('/api/users', authenticate, (req, res) => {
  const users = db.prepare('SELECT id, name, phone FROM users WHERE id != ?').all(req.userId);
  res.json(users);
});

// ---------- direct messages ----------

app.get('/api/messages/:otherId', authenticate, (req, res) => {
  const { otherId } = req.params;
  const messages = db
    .prepare(
      `SELECT * FROM messages
       WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
       ORDER BY timestamp ASC`
    )
    .all(req.userId, otherId, otherId, req.userId);
  res.json(messages);
});

// Mark all messages from `otherId` to me as read
app.post('/api/messages/:otherId/read', authenticate, (req, res) => {
  const { otherId } = req.params;
  db.prepare(
    'UPDATE messages SET read = 1 WHERE from_user = ? AND to_user = ? AND read = 0'
  ).run(otherId, req.userId);

  const targetSocketId = onlineUsers.get(otherId);
  if (targetSocketId) io.to(targetSocketId).emit('messages_read', { by: req.userId });

  res.json({ ok: true });
});

// ---------- groups ----------

app.post('/api/groups', authenticate, (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'Group name and at least one member are required' });
  }

  const groupId = makeId();
  db.prepare('INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    groupId,
    name,
    req.userId,
    Date.now()
  );

  const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
  insertMember.run(groupId, req.userId);
  memberIds.forEach((uid) => insertMember.run(groupId, uid));

  res.json({ id: groupId, name });
});

app.get('/api/groups', authenticate, (req, res) => {
  const groups = db
    .prepare(
      `SELECT g.id, g.name FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = ?`
    )
    .all(req.userId);
  res.json(groups);
});

app.get('/api/groups/:groupId/members', authenticate, (req, res) => {
  const isMember = db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(req.params.groupId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const members = db
    .prepare(
      `SELECT u.id, u.name FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = ?`
    )
    .all(req.params.groupId);
  res.json(members);
});

app.get('/api/groups/:groupId/messages', authenticate, (req, res) => {
  const isMember = db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(req.params.groupId, req.userId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const messages = db
    .prepare('SELECT * FROM messages WHERE group_id = ? ORDER BY timestamp ASC')
    .all(req.params.groupId);
  res.json(messages);
});

// ---------- real-time layer ----------

const onlineUsers = new Map(); // userId -> socketId

io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  onlineUsers.set(socket.userId, socket.id);
  io.emit('presence_update', Array.from(onlineUsers.keys()));

  // ---- direct messages ----
  socket.on('send_message', ({ to, text }) => {
    if (!to || !text) return;
    const message = {
      id: makeId(),
      from_user: socket.userId,
      to_user: to,
      group_id: null,
      text,
      timestamp: Date.now(),
      delivered: 0,
      read: 0,
    };

    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      message.delivered = 1;
      io.to(targetSocketId).emit('receive_message', message);
    }

    db.prepare(
      `INSERT INTO messages (id, from_user, to_user, group_id, text, timestamp, delivered, read)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0)`
    ).run(message.id, message.from_user, message.to_user, message.text, message.timestamp, message.delivered);

    socket.emit('message_sent', message);
  });

  // ---- group messages ----
  socket.on('send_group_message', ({ groupId, text }) => {
    if (!groupId || !text) return;
    const isMember = db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, socket.userId);
    if (!isMember) return;

    const message = {
      id: makeId(),
      from_user: socket.userId,
      to_user: null,
      group_id: groupId,
      text,
      timestamp: Date.now(),
      delivered: 1,
      read: 0,
    };

    db.prepare(
      `INSERT INTO messages (id, from_user, to_user, group_id, text, timestamp, delivered, read)
       VALUES (?, ?, NULL, ?, ?, ?, 1, 0)`
    ).run(message.id, message.from_user, message.group_id, message.text, message.timestamp);

    const members = db
      .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
      .all(groupId)
      .map((m) => m.user_id);

    members
      .filter((uid) => uid !== socket.userId)
      .forEach((uid) => {
        const sockId = onlineUsers.get(uid);
        if (sockId) io.to(sockId).emit('receive_group_message', message);
      });

    socket.emit('group_message_sent', message);
  });

  // ---- typing indicators ----
  socket.on('typing', ({ to }) => {
    const sockId = onlineUsers.get(to);
    if (sockId) io.to(sockId).emit('typing', { from: socket.userId });
  });

  socket.on('stop_typing', ({ to }) => {
    const sockId = onlineUsers.get(to);
    if (sockId) io.to(sockId).emit('stop_typing', { from: socket.userId });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.userId);
    io.emit('presence_update', Array.from(onlineUsers.keys()));
  });
});

const PORT = process.env.PORT || 3000;

dbInit().then((initializedDb) => {
  db = initializedDb;
  server.listen(PORT, () => {
    console.log(`IndiChat server running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
