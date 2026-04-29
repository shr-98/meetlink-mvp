# Python mail backend (Flask)

A drop-in replacement for `server/index.js`. Same routes, same port (`5179`),
same `.env` file — so the React frontend doesn't change at all.

## Routes

| Method | Path               | Purpose                                       |
| ------ | ------------------ | --------------------------------------------- |
| GET    | `/api/health`      | Returns `{ ok, smtpConfigured, from }`.       |
| POST   | `/api/send-invite` | Sends an HTML+text email with an `.ics` file. |

The POST body matches what `App.jsx` already sends:

```json
{
  "id": "abc123",
  "title": "Sprint planning",
  "date": "2026-05-04",
  "time": "14:30",
  "duration": 30,
  "host": "Alex",
  "provider": "gmeet",
  "providerLabel": "Google Meet",
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "attendees": ["a@x.com", "b@y.com"],
  "description": "Optional agenda"
}
```

## Setup

```bash
cd server_py
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Make sure the project-root `.env` has working SMTP credentials (see
`../.env.example`). The Python backend reads the **same** file as the Node one.

## Run

Use the Python backend **instead of** the Node one (they both bind to port
`5179`, so don't run both at the same time):

```bash
# from project root
npm run dev          # frontend (Vite, port 5173)

# in another terminal
cd server_py
source .venv/bin/activate
python app.py        # mail API on port 5179
```

Or, in one shot:

```bash
npm run dev:py
```

(see `package.json` — uses `concurrently` to run Vite + the Python server).

## How it sends mail

* Uses Python's stdlib `smtplib` + `email.message.EmailMessage` — no extra mail
  library required.
* Auto-detects port `465` → implicit TLS (`SMTP_SSL`); any other port →
  `STARTTLS` upgrade (gracefully skipped if the server doesn't advertise it,
  e.g. Mailtrap sandbox `2525`).
* Sends a `multipart/alternative` body containing **plain text + HTML +
  `text/calendar; method=REQUEST`** plus a downloadable `invite.ics`
  attachment — same shape Gmail / Outlook / Apple Calendar expect.
* Strips spaces from `SMTP_PASS` so a Gmail App Password copy-pasted as
  `abcd efgh ijkl mnop` works.

## Test it

```bash
# Health check (no SMTP needed for this one)
curl http://localhost:5179/api/health

# Real send
curl -X POST http://localhost:5179/api/send-invite \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"Test meeting",
    "date":"2026-05-10",
    "time":"15:00",
    "duration":30,
    "meetingUrl":"https://meet.jit.si/jiraly-test",
    "attendees":["you@example.com"],
    "host":"Me",
    "providerLabel":"Jitsi Meet"
  }'
```
