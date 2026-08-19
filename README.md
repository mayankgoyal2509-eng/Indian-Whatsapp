# IndiChat — WhatsApp-style Chat App

Node.js + Express + Socket.io backend, hosted PostgreSQL database, JWT
password auth, WhatsApp-style frontend.

## What's included
- Password auth (sign up / log in, bcrypt-hashed passwords, JWT sessions)
- Permanent hosted PostgreSQL database (data survives restarts/redeploys)
- Contacts are private, not a public directory — add someone by their phone
  number, or they appear automatically once you've exchanged messages
- 1-to-1 real-time messaging (Socket.io)
- Group chats
- Blue-tick read receipts for 1-to-1 chats
- Online/offline status + typing indicator
- Logout button

## Coming in later layers
- Media / voice message sharing
- Push notifications
- End-to-end encryption
- Voice/video calls (WebRTC)

## Local setup

**Requirements:** Node.js 18+, and a Postgres database connection string
(see "Getting a free database" below — takes 2 minutes).

1. Unzip this project, open a terminal in the folder.
2. `npm install`
3. Set your database connection string as an environment variable:
   - Windows (Command Prompt): `set DATABASE_URL=your-connection-string-here`
   - Windows (PowerShell): `$env:DATABASE_URL="your-connection-string-here"`
   - Mac/Linux: `export DATABASE_URL=your-connection-string-here`
4. `npm start`
5. Open `http://localhost:3000`

(Steps 3 needs to be run every time you open a new terminal window, since
environment variables don't persist. Alternatively use a `.env` file with
the `dotenv` package if you want it to persist automatically.)

## Getting a free database (Neon)
1. Go to neon.tech, sign up free.
2. Create a new project (any name/region).
3. On the project dashboard, copy the "Connection string" — looks like
   `postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require`
4. That's your `DATABASE_URL`.

## Deploying to Render
1. Push this project to a GitHub repo.
2. On render.com: New + → Web Service → connect your repo.
3. Build Command: `npm install` · Start Command: `npm start`
4. Add Environment Variables:
   - `JWT_SECRET` → any random string
   - `DATABASE_URL` → your Neon connection string from above
5. Deploy. Your data now survives restarts and redeploys permanently.

## Project structure
```
indian-whatsapp/
├── server.js          # Express + Socket.io + all API routes
├── db.js               # PostgreSQL connection & schema
├── package.json
└── public/
    ├── index.html        # login/register + chat UI + group modal
    ├── style.css          # WhatsApp-style styling
    └── app.js             # frontend logic
```

## Notes
- Passwords are bcrypt-hashed, never stored in plain text.
- JWT sessions stored in browser localStorage, sent as
  `Authorization: Bearer <token>` and passed to Socket.io on connect.
- Set a real `JWT_SECRET` before deploying anywhere public.

## Where to make changes next
- **Media/voice sharing** → file upload route (`multer`), store in cloud
  storage (Render's disk is ephemeral too — use S3/Cloudinary), save the
  URL in a new `messages.media_url` column.
- **Push notifications** → `web-push` npm package + a service worker.
- **E2E encryption** → ECDH key pairs generated client-side (Web Crypto
  API), server only ever stores ciphertext.
- **Calls** → WebRTC `RTCPeerConnection` with the existing Socket.io
  connection as the signaling channel.
