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
- Photo, file, and voice note sharing (📎 attach / 🎤 record buttons),
  stored permanently via Cloudinary, no file size limit
- **Confirm-before-send** — attaching a photo or recording a voice note
  shows a preview (with playback for audio) before it actually sends
- **Delete a message** — removes it for everyone (shows "This message was
  deleted"); only the sender can delete their own messages
- **Edit a sent message** — click ✏️ on your own message within 15 minutes
  of sending (matches WhatsApp's own edit window); shows an "edited" tag
  afterward, and updates live for the other person too
- **Delete a chat** — clears the conversation on your side only; the other
  person's copy is untouched, and the chat reappears if they message again
- **Profile settings** — click your name to edit your name/phone number,
  upload a profile photo, or change your password
- **Clickable links** — URLs in messages open in one click instead of
  needing to be manually copied
- **Proper mobile layout** — on narrow screens, the contact list and chat
  view are separate full-width screens with a back button, instead of both
  being squeezed side by side
- **Date separators** in chat ("Today", "Yesterday", or the full date)
- **Upload progress ring** — see exactly how much of a large file has
  uploaded, with a circular percentage indicator
- **Drag-and-drop file sharing** on desktop — drop a file straight into an
  open chat instead of only being able to browse for it
- **Remove profile photo** — not just change it
- Fixed: switching chats quickly no longer briefly shows the wrong
  conversation's messages
- Fixed: online/offline status now self-corrects every few seconds from
  the server's live connection list, instead of only trusting push updates
  that could occasionally be missed
- **Copy any message** — tap the 📋 icon or long-press (touch/mouse-hold)
  a message to copy its text to your clipboard
- **Paste to attach** — Ctrl+V an image/file copied from elsewhere directly
  into the message box to attach it, no need to save it first
- Real file names now shown for attached documents, instead of a generic
  "Download file" label
- Compact inline upload progress (small ring + filename + %) instead of a
  large centered circle
- Fixed: media/voice uploads go back through the app server (reliable)
  instead of a direct-to-storage path that was failing in practice, while
  keeping a real progress percentage
- **Fixed a serious mobile bug**: the message input and Send button could
  disappear entirely off-screen on phones, caused by how mobile browsers
  handle full-screen height with their address bar. Fixed properly.

## Coming in later layers
- Push notifications
- End-to-end encryption
- Voice/video calls (WebRTC)
- Chat folders

## Getting free media storage (Cloudinary)
1. Go to cloudinary.com, sign up free.
2. On your dashboard, find the **"API Environment variable"** box — it
   shows something like `CLOUDINARY_URL=cloudinary://123456:AbCdEf@your-cloud-name`
3. Copy the whole thing (or just the part after the `=`).
4. Set it as an environment variable named `CLOUDINARY_URL` — same way you
   set `DATABASE_URL` and `JWT_SECRET` (locally via `set`/`export`, or on
   Render under Environment Variables).

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
