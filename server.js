const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cloudinary = require('cloudinary').v2; // auto-configures from CLOUDINARY_URL env var
const dbInit = require('./db').init;

// Uploads are streamed to a temp file on disk (not held in server memory),
// so file size isn't limited by available RAM. The temp file is deleted
// right after it's forwarded to Cloudinary.
const TMP_UPLOAD_DIR = path.join(os.tmpdir(), 'indichat-uploads');
fs.mkdirSync(TMP_UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_UPLOAD_DIR),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`);
    },
  }),
  // No `limits` set — no file size cap enforced by this server.
  // Note: Cloudinary's own account plan may still cap very large files,
  // and extremely large uploads will simply take longer / depend on the
  // uploader's connection speed.
});

// Cloudinary's 'auto' resource type only reliably detects images/video.
// Anything else (zip, pdf, docs, etc.) needs to be uploaded as 'raw' explicitly.
function resourceTypeFor(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/') || mimetype.startsWith('audio/')) return 'video';
  return 'raw';
}

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
  return { id: u.id, name: u.name, phone: u.phone, avatar_url: u.avatar_url || null };
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

// Search for a user by exact phone number (to add them as a contact).
// Does NOT return a directory of everyone — only an exact phone match.
app.get('/api/users/search', authenticate, h(async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const user = await db.get('SELECT id, name, phone, avatar_url FROM users WHERE phone = $1', [phone]);
  if (!user) return res.status(404).json({ error: 'No account found with that phone number' });
  if (user.id === req.userId) return res.status(400).json({ error: "That's your own number" });

  res.json(user);
}));

app.post('/api/contacts', authenticate, h(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const target = await db.get('SELECT id, name, phone, avatar_url FROM users WHERE phone = $1', [phone]);
  if (!target) return res.status(404).json({ error: 'No account found with that phone number' });
  if (target.id === req.userId) return res.status(400).json({ error: "That's your own number" });

  await db.run(
    'INSERT INTO contacts (owner_id, contact_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [req.userId, target.id, Date.now()]
  );

  res.json(target);
}));

// Your chat list: people you've explicitly added, plus anyone you already
// have a direct message history with (so incoming messages aren't lost).
// If you've cleared a chat, it drops off this list until a new message arrives.
app.get('/api/contacts', authenticate, h(async (req, res) => {
  const contacts = await db.all(
    `SELECT DISTINCT u.id, u.name, u.phone, u.avatar_url FROM users u
     WHERE u.id != $1
     AND (
       u.id IN (SELECT contact_id FROM contacts WHERE owner_id = $1)
       OR EXISTS (
         SELECT 1 FROM messages m
         WHERE ((m.from_user = u.id AND m.to_user = $1) OR (m.from_user = $1 AND m.to_user = u.id))
         AND m.timestamp > COALESCE(
           (SELECT cleared_at FROM chat_clears WHERE owner_id = $1 AND chat_key = u.id), 0
         )
       )
     )`,
    [req.userId]
  );
  res.json(contacts);
}));

// Clear a chat for yourself only — hides message history up to now on your
// side. The other person's copy is untouched. chatKey is either the other
// user's id (direct chat) or 'group:<groupId>' (group chat).
app.post('/api/chats/:chatKey/clear', authenticate, h(async (req, res) => {
  await db.run(
    `INSERT INTO chat_clears (owner_id, chat_key, cleared_at) VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, chat_key) DO UPDATE SET cleared_at = $3`,
    [req.userId, req.params.chatKey, Date.now()]
  );
  res.json({ ok: true });
}));

// ---------- profile ----------

app.get('/api/profile', authenticate, h(async (req, res) => {
  const user = await db.get('SELECT id, name, phone, avatar_url FROM users WHERE id = $1', [req.userId]);
  res.json(user);
}));

app.put('/api/profile', authenticate, h(async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });

  const existing = await db.get('SELECT id FROM users WHERE phone = $1 AND id != $2', [phone, req.userId]);
  if (existing) return res.status(409).json({ error: 'That phone number is already in use' });

  await db.run('UPDATE users SET name = $1, phone = $2 WHERE id = $3', [name, phone, req.userId]);
  const updated = await db.get('SELECT id, name, phone, avatar_url FROM users WHERE id = $1', [req.userId]);
  res.json(updated);
}));

app.post(
  '/api/profile/avatar',
  authenticate,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!process.env.CLOUDINARY_URL) {
      fs.unlink(req.file.path, () => {});
      return res.status(500).json({ error: 'Media storage is not configured (CLOUDINARY_URL missing)' });
    }

    try {
      const result = await cloudinary.uploader.upload(req.file.path, {
        resource_type: 'image',
        transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face' }],
      });
      await db.run('UPDATE users SET avatar_url = $1 WHERE id = $2', [result.secure_url, req.userId]);
      res.json({ avatar_url: result.secure_url });
    } catch (err) {
      console.error('Avatar upload error:', err);
      res.status(502).json({ error: err.message || 'Upload to storage provider failed' });
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  })
);

app.put('/api/profile/password', authenticate, h(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const user = await db.get('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  await db.run('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId]);
  res.json({ ok: true });
}));

// ---------- media upload ----------

app.post(
  '/api/upload',
  authenticate,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  h(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!process.env.CLOUDINARY_URL) {
      fs.unlink(req.file.path, () => {});
      return res.status(500).json({ error: 'Media storage is not configured (CLOUDINARY_URL missing)' });
    }

    const mimetype = req.file.mimetype || '';
    let mediaType = 'file';
    if (mimetype.startsWith('image/')) mediaType = 'image';
    else if (mimetype.startsWith('audio/')) mediaType = 'audio';
    else if (mimetype.startsWith('video/')) mediaType = 'video';

    try {
      const result = await cloudinary.uploader.upload(req.file.path, {
        resource_type: resourceTypeFor(mimetype),
      });
      res.json({ url: result.secure_url, mediaType });
    } catch (err) {
      console.error('Cloudinary upload error:', err);
      res.status(502).json({ error: err.message || 'Upload to storage provider failed' });
    } finally {
      fs.unlink(req.file.path, () => {}); // always clean up the temp file
    }
  })
);

// ---------- direct messages ----------

app.get('/api/messages/:otherId', authenticate, h(async (req, res) => {
  const { otherId } = req.params;
  const messages = await db.all(
    `SELECT * FROM messages
     WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
     AND timestamp > COALESCE((SELECT cleared_at FROM chat_clears WHERE owner_id = $1 AND chat_key = $2), 0)
     ORDER BY timestamp ASC`,
    [req.userId, otherId]
  );
  res.json(messages);
}));

// Delete a message you sent — for everyone, since this server is the single
// source of truth for all participants (unlike device-local chat apps).
app.delete('/api/messages/:messageId', authenticate, h(async (req, res) => {
  const message = await db.get('SELECT * FROM messages WHERE id = $1', [req.params.messageId]);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.from_user !== req.userId) {
    return res.status(403).json({ error: 'You can only delete your own messages' });
  }

  await db.run(
    "UPDATE messages SET deleted = 1, text = '', media_url = NULL, media_type = NULL WHERE id = $1",
    [req.params.messageId]
  );

  if (message.group_id) {
    const members = (
      await db.all('SELECT user_id FROM group_members WHERE group_id = $1', [message.group_id])
    ).map((m) => m.user_id);
    members.forEach((uid) => {
      const sockId = onlineUsers.get(uid);
      if (sockId) io.to(sockId).emit('message_deleted', { id: message.id, groupId: message.group_id });
    });
  } else {
    [message.from_user, message.to_user].forEach((uid) => {
      const sockId = onlineUsers.get(uid);
      if (sockId) io.to(sockId).emit('message_deleted', { id: message.id, otherId: uid === message.from_user ? message.to_user : message.from_user });
    });
  }

  res.json({ ok: true });
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

  const chatKey = `group:${req.params.groupId}`;
  const messages = await db.all(
    `SELECT * FROM messages WHERE group_id = $1
     AND timestamp > COALESCE((SELECT cleared_at FROM chat_clears WHERE owner_id = $2 AND chat_key = $3), 0)
     ORDER BY timestamp ASC`,
    [req.params.groupId, req.userId, chatKey]
  );
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
  socket.on('send_message', async ({ to, text, mediaUrl, mediaType }) => {
    if (!to || (!text && !mediaUrl)) return;
    const message = {
      id: makeId(),
      from_user: socket.userId,
      to_user: to,
      group_id: null,
      text: text || '',
      timestamp: Date.now(),
      delivered: 0,
      read: 0,
      media_url: mediaUrl || null,
      media_type: mediaType || null,
    };

    const targetSocketId = onlineUsers.get(to);
    if (targetSocketId) {
      message.delivered = 1;
      io.to(targetSocketId).emit('receive_message', message);
    }

    try {
      await db.run(
        `INSERT INTO messages (id, from_user, to_user, group_id, text, timestamp, delivered, read, media_url, media_type)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, 0, $7, $8)`,
        [
          message.id,
          message.from_user,
          message.to_user,
          message.text,
          message.timestamp,
          message.delivered,
          message.media_url,
          message.media_type,
        ]
      );
      socket.emit('message_sent', message);
    } catch (err) {
      console.error('send_message error:', err);
    }
  });

  // ---- group messages ----
  socket.on('send_group_message', async ({ groupId, text, mediaUrl, mediaType }) => {
    if (!groupId || (!text && !mediaUrl)) return;
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
        text: text || '',
        timestamp: Date.now(),
        delivered: 1,
        read: 0,
        media_url: mediaUrl || null,
        media_type: mediaType || null,
      };

      await db.run(
        `INSERT INTO messages (id, from_user, to_user, group_id, text, timestamp, delivered, read, media_url, media_type)
         VALUES ($1, $2, NULL, $3, $4, $5, 1, 0, $6, $7)`,
        [
          message.id,
          message.from_user,
          message.group_id,
          message.text,
          message.timestamp,
          message.media_url,
          message.media_type,
        ]
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
