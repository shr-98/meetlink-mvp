# Jiraly — Project & Issue Tracker (with Meeting Mailer)

A lightweight, single-page Jira-style tracker with a built-in **Meetings** section that auto-generates conference links (Jitsi / Google Meet / Zoom / Teams) and **emails the invitation to attendees through a small Node backend**.

## Stack

| Layer    | Tech                                       |
| -------- | ------------------------------------------ |
| Frontend | React 18 + Vite (single `App.jsx`)         |
| Backend  | Express + Nodemailer (`server/index.js`)   |
| Storage  | `localStorage` (no DB)                     |

## Quick start

```bash
# 1. Install everything
npm install

# 2. Configure mail
cp .env.example .env
#   then edit .env and fill in SMTP_USER / SMTP_PASS

# 3. Run frontend + backend together
npm run dev:all
```

- Web UI: <http://localhost:5173>
- Mail API: <http://localhost:5174/api/health>

The Vite dev server proxies `/api/*` → `http://localhost:5174`, so the frontend just calls `fetch('/api/send-invite', …)`.

## SMTP setup

The backend uses **any standard SMTP provider** — pick one and put the credentials in `.env`:

### Gmail
1. Turn on 2-Step Verification: <https://myaccount.google.com/security>
2. Create an **App password**: <https://myaccount.google.com/apppasswords>
3. Use it as `SMTP_PASS` (your normal Google password will NOT work).

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
MAIL_FROM="Jiraly <you@gmail.com>"
```

### Mailtrap (best for local testing — emails are caught, never delivered)
```
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=<from your inbox>
SMTP_PASS=<from your inbox>
```

### SendGrid
```
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=<your SendGrid API key>
```

## Scripts

| Script             | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `npm run dev`      | Vite frontend only (port 5173)                              |
| `npm run server`   | Express mail backend only (port 5174)                       |
| `npm run dev:all`  | Both, in parallel (recommended)                             |
| `npm run build`    | Production frontend build                                   |
| `npm run preview`  | Preview the built frontend                                  |

## How emails work

1. User schedules a meeting with one or more attendees in the **📅 Meetings** view.
2. On save, the frontend POSTs to `/api/send-invite` with the meeting payload.
3. The backend builds an HTML + plain-text email **with a `.ics` calendar attachment** and sends it via your configured SMTP.
4. Attendees receive a real email they can RSVP from / add to their calendar.
5. If the mail server is unreachable, the UI falls back to opening a `mailto:` link in the user's local mail client.

There is also a **✉ Send invite** button on each meeting card to re-send at any time, plus **📆 Add to calendar** for a local `.ics` download.

## Project layout

```
.
├── index.html
├── package.json          ← scripts, frontend + backend deps
├── vite.config.js        ← /api proxy to localhost:5174
├── .env.example          ← copy → .env and fill in SMTP creds
├── server/
│   └── index.js          ← Express + Nodemailer mail API
└── src/
    ├── main.jsx
    └── App.jsx           ← all UI, all state
```

## First run

The first time you load the app it auto-seeds:
- 2 sample projects (`MAR`, `WEB`)
- 10 sample issues across To Do / In Progress / In Review / Done
- 3 sample meetings (today, tomorrow, in 3 days)

The first user you sign up becomes the **admin**. Subsequent sign-ups are members.
