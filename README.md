# IndiChat — WhatsApp-style Chat App

A working real-time chat app: Node.js + Express + Socket.io backend, SQLite
database, JWT password auth, and a WhatsApp-style frontend.

## What's included (Layer 1 — done)
- Password auth (sign up / log in, bcrypt-hashed passwords, JWT sessions)
- Real SQL database (SQLite via better-sqlite3, file at `data/indichat.db`)
- 1-to-1 real-time messaging (Socket.io)
- Group chats (create a group, add members, group messaging)
- Blue-tick read receipts for 1-to-1 chats (✓ sent, ✓✓ grey delivered, ✓✓ blue read)
- Online/offline status + typing indicator

## Coming in later layers (not built yet)
- Media / voice message sharing (image, audio file uploads)
- Push notifications
- End-to-end encryption (real E2E via browser crypto, not a gimmick)
- Voice/video calls (WebRTC)
- Read receipts for group chats (per-member — more complex than 1-to-1)

## How to run it

**Requirements:** [Node.js](https://nodejs.org) 18+ installed.
`better-sqlite3` compiles a small native module on install — on most
systems (Mac, Linux, and Windows with Node's default install) this just
works. If `npm install` fails on Windows, install "Desktop development
with C++" via Visual Studio Build Tools first.

1. Unzip this project.
2. In a terminal, `cd` into the folder.
3. Install dependencies:
   ```
   npm install
   ```
4. Start the server:
   ```
   npm start
   ```
5. Open `http://localhost:3000` in your browser.
6. To test chat/groups between multiple people, open the URL in separate
   browser windows (or incognito), sign up with different phone numbers,
   and message between them.

## Project structure
```
indian-whatsapp/
├── server.js          # Express + Socket.io + all API routes
├── db.js               # SQLite schema & connection
├── package.json
├── data/
│   └── indichat.db      # auto-created SQLite database file
└── public/
    ├── index.html        # login/register + chat UI + group modal
    ├── style.css          # WhatsApp-style styling
    └── app.js             # frontend logic
```

## Notes on the auth/session model
- Passwords are hashed with bcrypt before being stored — never stored in plain text.
- On login/signup the server returns a JWT, stored in the browser's
  `localStorage` and sent as `Authorization: Bearer <token>` on API calls,
  and passed to Socket.io on connect for real-time auth.
- Change `JWT_SECRET` (set it as an environment variable) before deploying
  this anywhere public — right now it falls back to a dev default.

## Where to make changes next
- **Media/voice sharing** → add a file upload route (e.g. with `multer`),
  store files in `public/uploads/`, save the file path in `messages.text`
  or a new `messages.media_url` column.
- **Push notifications** → `web-push` npm package + a service worker in `public/`.
- **E2E encryption** → generate an ECDH key pair per user in the browser
  (Web Crypto API), exchange public keys via the server, derive a shared
  secret per conversation, encrypt/decrypt client-side so the server only
  ever stores ciphertext.
- **Calls** → WebRTC `RTCPeerConnection` with Socket.io as the signaling
  channel (already have the socket infrastructure in place).
