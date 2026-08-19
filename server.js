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

// wraps an async route handler so thrown errors become 500s instead of crashing the process
function h(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });
}

// ---------- auth routes ----------

app.post('/api/register', h(async (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Name, phone and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const existing = await db.get('SELECT id FROM users WHERE phone = $1', [phone]);
  if (existing) return res.status(409).json({ error: 'An account with this phone number already exists' });

  const user = {
    id: makeId(),
    name,
    phone,
    password_hash: bcrypt.hashSync(password, 10),
    created_at: Date.now(),
  };
  await db.run(
    'INSERT INTO users (id, name, phone, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
    [user.id, user.name, user.phone, user.password_hash, user.created_at]
  );

  res.json({ user: publicUser(user), token: signToken(user) });
}));

app.post('/api/login', h(async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password are required' });

  const user = await db.get('SELECT * FROM users WHERE phone = $1', [phone]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect phone number or password' });
  }

  res.json({ user: publicUser(user), token: signToken(user) });
}));

// ---------- contacts ----------

app.get('/api/users', authenticate, h(async (req, res) => {
  const users = await db.all('SELECT id, name, phone FROM users WHERE id != $1', [req.userId]);
  res.json(users);
}));

// ---------- direct messages ----------

app.get('/api/messages/:otherId', authenticate, h(async (req, res) => {
  const { otherId } = req.params;
  const messages = await db.all(
    `SELECT * FROM messages
     WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
     ORDER BY timestamp ASC`,
    [req.userId, otherId]
  );
  res.json(messages);
}));

// Mark all messages from `otherId` to me as read
app.post('/api/messages/:otherId/read', authenticate, h(async (req, res) => {
  const { otherId } = req.params;
  await db.run(
    'UPDATE messages SET read = 1 WHERE from_user = $1 AND to_user = $2 AND read = 0',
    [otherId, req.userId]
  );

  const targetSocketId = onlineUsers.get(otherId);
  if (targetSocketId) io.to(targetSocketId).emit('messages_read', { by: req.userId });

  res.json({ ok: true });
}));

// ---------- groups ----------

app.post('/api/groups', authenticate, h(async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'Group name and at least one member are required' });
  }

  const groupId = makeId();
  await db.run('INSERT INTO groups (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)', [
    groupId,
    name,
    req.userId,
    Date.now(),
  ]);

  const allMemberIds = [req.userId, ...memberIds];
  for (const uid of allMemberIds) {
    await db.run(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, uid]
    );
  }

  res.json({ id: groupId, name });
}));

app.get('/api/groups', authenticate, h(async (req, res) => {
  const groups = await db.all(
    `SELECT g.id, g.name FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = $1`,
    [req.userId]
  );
  res.json(groups);
}));

app.get('/api/groups/:groupId/members', authenticate, h(async (req, res) => {
  const isMember = await db.get(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [req.params.groupId, req.userId]
  );
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const members = await db.all(
    `SELECT u.id, u.name FROM users u
     JOIN group_members gm ON gm.user_id = u.id
     WHERE gm.group_id = $1`,
    [req.params.groupId]
  );
  res.json(members);
}));

app.get('/api/groups/:groupId/messages', authenticate, h(async (req, res) => {
  const isMember = await db.get(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [req.params.groupId, req.userId]
  );
  if (!isMember) return res.status(403).json({ error: 'Not a member of this group' });

  const messages = await db.all('SELECT * FROM messages WHERE group_id = $1 ORDER BY timestamp ASC', [
    req.params.groupId,
  ]);
  res.json(messages);
}));

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
  socket.on('send_message', async ({ to, text }) => {
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

    try {
      await db.run(
        `INSERT INTO messages (id, from_user, to_user, group_id, text, timestamp, delivered, read)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, 0)`,
        [message.id, message.from_user, message.to_user, message.text, message.timestamp, message.delivered]
      );
      socket.emit('message_sent', message);
    } catch (err) {
      console.error('send_message error:', err);
    }
  });

  // ---- group messages ----
  socket.on('send_group_message', async ({ groupId, text }) => {
    if (!groupId || !text) return;
    try {
      const isMember = await db.get(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, socket.userId]
      );
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

      await db.run(
        `INSERT INTO messages (id, from_user, to_user, group_id, text, timestamp, delivered, read)
         VALUES ($1, $2, NULL, $3, $4, $5, 1, 0)`,
        [message.id, message.from_user, message.group_id, message.text, message.timestamp]
      );

      const members = (await db.all('SELECT user_id FROM group_members WHERE group_id = $1', [groupId])).map(
        (m) => m.user_id
      );

      members
        .filter((uid) => uid !== socket.userId)
        .forEach((uid) => {
          const sockId = onlineUsers.get(uid);
          if (sockId) io.to(sockId).emit('receive_group_message', message);
        });

      socket.emit('group_message_sent', message);
    } catch (err) {
      console.error('send_group_message error:', err);
    }
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

dbInit()
  .then((initializedDb) => {
    db = initializedDb;
    server.listen(PORT, () => {
      console.log(`IndiChat server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
