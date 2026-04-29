# MeetLink MVP

A lightweight, no-backend meeting link manager for teams. Built with React + Vite, persisted to `localStorage`.

## Features
- **Email-based sign up / sign in** — first user auto-becomes admin
- **Create & manage meetings** — title, date/time, host, department, URL, description, tags
- **Search & filter** — full-text search + tag filters + date picker
- **Shareable links** — encode any meeting as a base64 URL parameter
- **Role-based access** — admins can edit/delete all meetings; members only their own

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev

# 3. Open http://localhost:5173
#    Sign up — the first account created becomes admin.
```

## Build for Production

```bash
npm run build
# Output in /dist — deploy to Vercel, Netlify, or any static host
```

## Project Structure

```
meetlink-mvp/
├── index.html          # HTML shell
├── vite.config.js      # Vite + React plugin config
├── package.json
└── src/
    ├── main.jsx        # React root + localStorage polyfill
    └── App.jsx         # Entire app (Auth, Dashboard, Editor, Cards)
```

## Storage

Data is stored in `localStorage` under these keys:
| Key          | Contents                        |
|--------------|---------------------------------|
| `ml:users`   | Array of registered users       |
| `ml:session` | Current logged-in user session  |
| `ml:meetings`| Array of all meeting objects    |

Passwords are hashed (djb2) before storage — never stored in plain text.

## Shareable Links

Clicking **Copy link** on any meeting card copies a URL like:
```
https://your-app.com/?ml=eyJ0aXRsZSI6...
```
The `ml` parameter is a base64-encoded JSON blob of the meeting object. Anyone with the link can decode it without logging in.

## Upgrading Beyond MVP

| Concern        | Suggested upgrade                              |
|----------------|------------------------------------------------|
| Persistence    | Node.js + PostgreSQL / Supabase                |
| Auth           | NextAuth.js, Auth0, or SAML/LDAP via Passport  |
| Email          | Nodemailer + SendGrid for link distribution    |
| Reminders      | Cron job (node-cron) + email notifications     |
| Audit log      | Server-side middleware logging access events   |
| Deployment     | Vercel (static) → Railway/Fly.io (with backend)|

## License

MIT
