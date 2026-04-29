"""
Jiraly mail API — Python (Flask) backend.

Drop-in replacement for `server/index.js`. Exposes the exact same routes the
React frontend already calls:

    GET  /api/health        → { ok, smtpConfigured, from }
    POST /api/send-invite   → sends a real email (HTML + plain text + .ics)

Run:
    cd server_py
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    python app.py

Configuration is read from the project-root `.env` file (the same one the Node
backend uses), so SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_FROM / PORT are
shared between the two implementations.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import time
import urllib.request
import urllib.parse
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from functools import wraps
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, g, jsonify, request
from flask_cors import CORS

import db as dbmod

# ─── Config ────────────────────────────────────────────────────────────────
# Load .env from the project root (one level above this file) so the same file
# powers both the Node and Python backends.
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

PORT = int(os.getenv("PORT", "5179"))
SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "").strip()
# Gmail App Passwords are shown as "abcd efgh ijkl mnop" — strip whitespace so
# users can paste either form.
SMTP_PASS = re.sub(r"\s+", "", os.getenv("SMTP_PASS", ""))
MAIL_FROM = os.getenv("MAIL_FROM") or (f'"Jiraly" <{SMTP_USER}>' if SMTP_USER else "")

SMTP_CONFIGURED = bool(SMTP_HOST and SMTP_USER and SMTP_PASS)
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "").strip()

if not SMTP_CONFIGURED:
    print(
        "[server.py] WARNING: SMTP_HOST / SMTP_USER / SMTP_PASS not all set — "
        "/api/send-invite will fail. Copy .env.example → .env and fill it in."
    )

app = Flask(__name__)
CORS(app)
dbmod.init_db()

# ─── Auth helpers ─────────────────────────────────────────────────────────
PW_SALT = os.getenv("PW_SALT", "jiraly-default-salt-change-me")
SESSION_TTL_S = 30 * 24 * 60 * 60  # 30 days


def hash_password(password: str) -> str:
    return hashlib.sha256(f"{PW_SALT}|{password}".encode()).hexdigest()


def issue_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    conn = dbmod.get_conn()
    with dbmod._lock:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, dbmod.now_iso(), int(time.time()) + SESSION_TTL_S),
        )
        conn.commit()
    return token


def get_session_user(token: str | None) -> dict | None:
    if not token:
        return None
    conn = dbmod.get_conn()
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > ?",
        (token, int(time.time())),
    ).fetchone()
    return dbmod.user_to_api(row, public=False) if row else None


def require_auth(f):
    @wraps(f)
    def wrapper(*a, **kw):
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else None
        user = get_session_user(token)
        if not user:
            return jsonify(ok=False, error="Unauthorized"), 401
        g.user = user
        g.token = token
        return f(*a, **kw)
    return wrapper

# ─── Helpers ───────────────────────────────────────────────────────────────
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def is_email(s: str | None) -> bool:
    return bool(s and EMAIL_RE.match(s.strip()))


def esc_ics(s: str | None) -> str:
    """RFC 5545 text escaping."""
    if not s:
        return ""
    return (
        s.replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(",", "\\,")
        .replace(";", "\\;")
    )


def esc_html(s: str | None) -> str:
    if not s:
        return ""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def parse_start(date_str: str, time_str: str | None) -> datetime:
    """Parse 'YYYY-MM-DD' + 'HH:MM' into a naive datetime (matches Node side)."""
    t = (time_str or "00:00").strip() or "00:00"
    return datetime.fromisoformat(f"{date_str}T{t}")


def fmt_ics_dt(dt: datetime) -> str:
    """UTC-style basic format: 20260429T133000Z."""
    return dt.strftime("%Y%m%dT%H%M%SZ")


def build_ics(m: dict) -> str:
    start = parse_start(m["date"], m.get("time"))
    duration = int(m.get("duration") or 30)
    end = start + timedelta(minutes=duration)

    attendees_lines = [
        f"ATTENDEE;RSVP=TRUE:mailto:{e}"
        for e in (m.get("attendees") or [])
        if is_email(e)
    ]

    description = m.get("description") or ""
    desc_full = (description + "\n\n" if description else "") + "Join: " + m["meetingUrl"]

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Jiraly//EN",
        "METHOD:REQUEST",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{m.get('id') or uuid.uuid4().hex}@jiraly",
        f"DTSTAMP:{fmt_ics_dt(datetime.utcnow())}",
        f"DTSTART:{fmt_ics_dt(start)}",
        f"DTEND:{fmt_ics_dt(end)}",
        f"SUMMARY:{esc_ics(m.get('title'))}",
        f"DESCRIPTION:{esc_ics(desc_full)}",
        f"LOCATION:{esc_ics(m['meetingUrl'])}",
        f"URL:{m['meetingUrl']}",
        f"ORGANIZER;CN={esc_ics(m.get('host') or 'Organizer')}:mailto:{SMTP_USER}",
        *attendees_lines,
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines)


def build_html(m: dict, when: str, provider_label: str) -> str:
    title = esc_html(m.get("title"))
    duration = m.get("duration")
    duration_html = f" ({int(duration)} min)" if duration else ""
    host = esc_html(m.get("host") or "")
    plat = esc_html(provider_label)
    url = esc_html(m["meetingUrl"])
    desc = m.get("description")
    desc_block = (
        f'<div style="margin-top:18px">'
        f'<div style="font-size:11px;color:#6B778C;text-transform:uppercase;'
        f'letter-spacing:0.4px;font-weight:600;margin-bottom:6px">Agenda</div>'
        f'<div style="font-size:14px;white-space:pre-wrap;line-height:1.5">'
        f"{esc_html(desc)}</div></div>"
        if desc
        else ""
    )

    return f"""
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#172B4D">
    <div style="background:#0052CC;color:#fff;padding:18px 22px;border-radius:6px 6px 0 0">
      <div style="font-size:12px;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px">Meeting invitation</div>
      <div style="font-size:20px;font-weight:600;margin-top:4px">{title}</div>
    </div>
    <div style="background:#fff;border:1px solid #DFE1E6;border-top:none;border-radius:0 0 6px 6px;padding:22px">
      <table style="font-size:14px;line-height:1.6;width:100%;border-collapse:collapse">
        <tr><td style="color:#6B778C;width:90px">When</td><td><strong>{esc_html(when)}</strong>{duration_html}</td></tr>
        <tr><td style="color:#6B778C">Host</td><td>{host}</td></tr>
        <tr><td style="color:#6B778C">Platform</td><td>{plat}</td></tr>
      </table>
      <div style="margin:22px 0">
        <a href="{url}"
           style="display:inline-block;background:#0052CC;color:#fff;text-decoration:none;padding:11px 22px;border-radius:3px;font-weight:600;font-size:14px">
          Join meeting
        </a>
      </div>
      <div style="font-size:12px;color:#6B778C;font-family:SFMono-Regular,Menlo,monospace;background:#FAFBFC;padding:8px 10px;border:1px solid #DFE1E6;border-radius:3px;word-break:break-all">
        {url}
      </div>
      {desc_block}
      <div style="margin-top:22px;padding-top:14px;border-top:1px solid #DFE1E6;font-size:11px;color:#97A0AF">
        Sent from Jiraly · The .ics attachment will add this to your calendar.
      </div>
    </div>
  </div>"""


def build_text(m: dict, when: str, provider_label: str) -> str:
    duration = m.get("duration")
    duration_str = f" ({int(duration)} min)" if duration else ""
    parts = [
        f"You're invited to: {m.get('title')}",
        "",
        f"When:     {when}{duration_str}",
        f"Host:     {m.get('host') or ''}",
        f"Platform: {provider_label}",
        "",
        "Join link:",
        m["meetingUrl"],
        "",
    ]
    if m.get("description"):
        parts.append(f"Agenda / Notes:\n{m['description']}\n")
    parts.append("— Sent from Jiraly")
    return "\n".join(parts)


def parse_from(from_header: str) -> tuple[str, str]:
    """Split a `"Name" <addr@x>` style string into (name, addr)."""
    m = re.match(r'^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$', from_header)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return "", from_header.strip()


def send_email(
    *,
    to_list: list[str],
    subject: str,
    text_body: str,
    html_body: str,
    ics_body: str,
) -> str:
    """Send a multipart/alternative email with an .ics calendar invite."""
    msg = EmailMessage()
    from_name, from_addr = parse_from(MAIL_FROM)
    msg["From"] = formataddr((from_name or "Jiraly", from_addr))
    msg["To"] = ", ".join(to_list)
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain="jiraly")

    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    # Calendar invite — both inline (REQUEST) and as a downloadable attachment,
    # which is how Nodemailer's icalEvent presents it.
    msg.add_alternative(
        ics_body,
        subtype="calendar",
        params={"method": "REQUEST", "name": "invite.ics", "charset": "UTF-8"},
    )
    msg.add_attachment(
        ics_body.encode("utf-8"),
        maintype="text",
        subtype="calendar",
        filename="invite.ics",
    )

    if SMTP_PORT == 465:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=30) as s:
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg, from_addr=from_addr, to_addrs=to_list)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
            s.ehlo()
            try:
                s.starttls(context=ssl.create_default_context())
                s.ehlo()
            except smtplib.SMTPNotSupportedError:
                # Server doesn't support STARTTLS (e.g. Mailtrap sandbox 2525).
                pass
            s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg, from_addr=from_addr, to_addrs=to_list)

    return msg["Message-ID"]


# ─── Startup SMTP verification ─────────────────────────────────────────────
def verify_smtp() -> None:
    if not SMTP_CONFIGURED:
        return
    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as s:
                s.login(SMTP_USER, SMTP_PASS)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
                s.ehlo()
                try:
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                except smtplib.SMTPNotSupportedError:
                    pass
                s.login(SMTP_USER, SMTP_PASS)
        print(f"[server.py] ✅ SMTP ready — logged in as {SMTP_USER}")
    except Exception as e:  # noqa: BLE001 — we want to log & keep running
        print(f"[server.py] ❌ SMTP verification FAILED: {e}")


# ─── Routes ────────────────────────────────────────────────────────────────
@app.get("/")
def root():
    # Friendly landing page so visiting the backend directly doesn't look broken.
    # The actual app lives on the Vite dev server (port 5173).
    return (
        "<h2>Jiraly mail API</h2>"
        "<p>This is the backend. Open the app at "
        '<a href="http://localhost:5173">http://localhost:5173</a>.</p>'
        '<p>Health check: <a href="/api/health">/api/health</a></p>',
        200,
    )


@app.get("/api/health")
def health():
    # `from` is a reserved word in Python, so we build the dict literally to
    # match the JSON shape the frontend expects: { ok, smtpConfigured, from }.
    return jsonify({
        "ok": True,
        "smtpConfigured": SMTP_CONFIGURED,
        "from": MAIL_FROM,
        "googleClientId": GOOGLE_CLIENT_ID,
    })


@app.post("/api/send-invite")
def send_invite():
    m = request.get_json(silent=True) or {}

    if not m.get("title") or not m.get("date") or not m.get("meetingUrl"):
        return (
            jsonify(ok=False, error="title, date, and meetingUrl are required"),
            400,
        )

    recipients = [e for e in (m.get("attendees") or []) if is_email(e)]
    if not recipients:
        return jsonify(ok=False, error="No valid attendee emails"), 400

    if not SMTP_CONFIGURED:
        return (
            jsonify(
                ok=False,
                error="SMTP not configured on server. "
                "Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env",
            ),
            500,
        )

    try:
        start = parse_start(m["date"], m.get("time"))
    except ValueError:
        return jsonify(ok=False, error="Invalid date/time format"), 400

    when = start.strftime("%a, %b %d, %Y, %I:%M %p")
    provider_label = m.get("providerLabel") or m.get("provider") or "Online"

    try:
        message_id = send_email(
            to_list=recipients,
            subject=f"Invitation: {m['title']} — {when}",
            text_body=build_text(m, when, provider_label),
            html_body=build_html(m, when, provider_label),
            ics_body=build_ics(m),
        )
    except smtplib.SMTPAuthenticationError as e:
        print(f"[send-invite] AUTH FAILED: {e}")
        return jsonify(ok=False, error=f"SMTP auth failed: {e.smtp_error.decode(errors='ignore') if isinstance(e.smtp_error, (bytes, bytearray)) else e}", code="EAUTH"), 500
    except Exception as e:  # noqa: BLE001
        print(f"[send-invite] FAILED: {e}")
        return jsonify(ok=False, error=f"SMTP: {e}"), 500

    print(f'[server.py] ✉ Sent "{m["title"]}" → {", ".join(recipients)} (id={message_id})')
    return jsonify(ok=True, messageId=message_id, sentTo=recipients)


# ─── OTP email ─────────────────────────────────────────────────────────────
def build_otp_email(code: str, purpose: str, name: str | None) -> tuple[str, str, str]:
    """Return (subject, text_body, html_body) for the OTP email."""
    is_signup = purpose == "signup"
    title = "Verify your email" if is_signup else "Reset your password"
    intro = (
        "Welcome to Jiraly! Use the code below to finish creating your account."
        if is_signup
        else "We received a request to reset your password. Use the code below to continue."
    )
    subject = f"{code} is your Jiraly verification code"

    text = (
        f"Hi {name or 'there'},\n\n{intro}\n\n"
        f"Your verification code: {code}\n\n"
        f"This code expires in 10 minutes. If you didn't request it, you can ignore this email.\n\n"
        f"— Jiraly"
    )

    safe_name = esc_html(name or "there")
    digits_html = "".join(
        f'<span style="display:inline-block;min-width:36px;padding:10px 4px;'
        f'margin:0 3px;font-family:SFMono-Regular,Menlo,monospace;font-size:24px;'
        f'font-weight:700;color:#0052CC;background:#DEEBFF;border-radius:6px;'
        f'letter-spacing:2px">{d}</span>'
        for d in code
    )
    html = f"""
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#172B4D">
    <div style="background:#0052CC;color:#fff;padding:20px 22px;border-radius:6px 6px 0 0">
      <div style="font-size:12px;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px">Jiraly</div>
      <div style="font-size:20px;font-weight:600;margin-top:4px">{esc_html(title)}</div>
    </div>
    <div style="background:#fff;border:1px solid #DFE1E6;border-top:none;border-radius:0 0 6px 6px;padding:24px">
      <p style="margin:0 0 14px;font-size:14px;line-height:1.55">Hi {safe_name},</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#42526E">{esc_html(intro)}</p>
      <div style="text-align:center;margin:22px 0">{digits_html}</div>
      <p style="margin:0;font-size:12px;color:#6B778C;line-height:1.55">
        This code expires in <strong>10 minutes</strong>. If you didn't request it,
        you can safely ignore this email.
      </p>
      <div style="margin-top:22px;padding-top:14px;border-top:1px solid #DFE1E6;font-size:11px;color:#97A0AF">
        Sent automatically from Jiraly · Please do not reply.
      </div>
    </div>
  </div>"""
    return subject, text, html


@app.post("/api/send-otp")
def send_otp():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip()
    purpose = body.get("purpose") or "verify"
    name = body.get("name")

    if not is_email(email):
        return jsonify(ok=False, error="A valid email is required"), 400
    if purpose not in ("signup", "reset", "verify"):
        return jsonify(ok=False, error="Invalid purpose"), 400

    # Server generates the code and stores it in the DB so the client never
    # has to track session state for OTP verification.
    code = f"{secrets.randbelow(1_000_000):06d}"
    dbmod.store_otp(email, code, purpose)

    if not SMTP_CONFIGURED:
        # Surface the code so local-dev without SMTP still works.
        print(f"[server.py] 🔓 SMTP not configured — OTP for {email} ({purpose}) is {code}")
        return jsonify(ok=True, sentTo=email, devCode=code, delivered=False)

    subject, text_body, html_body = build_otp_email(code, purpose, name)

    try:
        msg = EmailMessage()
        from_name, from_addr = parse_from(MAIL_FROM)
        msg["From"] = formataddr((from_name or "Jiraly", from_addr))
        msg["To"] = email
        msg["Subject"] = subject
        msg["Message-ID"] = make_msgid(domain="jiraly")
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")

        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=30) as s:
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg, from_addr=from_addr, to_addrs=[email])
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as s:
                s.ehlo()
                try:
                    s.starttls(context=ssl.create_default_context())
                    s.ehlo()
                except smtplib.SMTPNotSupportedError:
                    pass
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg, from_addr=from_addr, to_addrs=[email])

        print(f"[server.py] 🔐 OTP ({purpose}) sent → {email}")
        return jsonify(ok=True, sentTo=email, delivered=True)
    except Exception as e:  # noqa: BLE001
        print(f"[send-otp] FAILED: {e}")
        # Code is already stored, so return it for dev fallback.
        return jsonify(ok=True, sentTo=email, devCode=code, delivered=False, error=str(e))


# ─── Auth ──────────────────────────────────────────────────────────────────
@app.post("/api/auth/signup")
def auth_signup():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    code = (body.get("code") or "").strip()

    if not name or not is_email(email) or len(password) < 8:
        return jsonify(ok=False, error="Name, valid email, and 8+ char password required"), 400
    if not dbmod.consume_otp(email, code, "signup"):
        return jsonify(ok=False, error="Invalid or expired verification code"), 400

    conn = dbmod.get_conn()
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing:
        return jsonify(ok=False, error="An account with this email already exists"), 409

    role = "admin" if conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"] == 0 else "member"
    user_id = dbmod.uid()
    with dbmod._lock:
        conn.execute(
            "INSERT INTO users (id, name, email, pw_hash, role, verified, joined_at) "
            "VALUES (?, ?, ?, ?, ?, 1, ?)",
            (user_id, name, email, hash_password(password), role, dbmod.now_iso()),
        )
        conn.commit()

    token = issue_session(user_id)
    user = dbmod.user_to_api(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone(), public=False)
    return jsonify(ok=True, token=token, user=user)


@app.post("/api/auth/signin")
def auth_signin():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    if not is_email(email) or not password:
        return jsonify(ok=False, error="Email and password required"), 400

    conn = dbmod.get_conn()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not hmac.compare_digest(row["pw_hash"], hash_password(password)):
        return jsonify(ok=False, error="Invalid email or password"), 401

    token = issue_session(row["id"])
    return jsonify(ok=True, token=token, user=dbmod.user_to_api(row, public=False))


@app.post("/api/auth/forgot")
def auth_forgot_check():
    """Return whether an account exists (so the UI can show a clean error)
    before we go through the OTP send step. Always issue an OTP so we don't
    leak account existence on the email side."""
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    if not is_email(email):
        return jsonify(ok=False, error="Valid email required"), 400
    conn = dbmod.get_conn()
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    return jsonify(ok=True, exists=bool(row))


@app.post("/api/auth/google")
def auth_google():
    """Sign in or sign up with a Google ID token (from Google Identity Services).

    The frontend sends `{ credential }` — the JWT issued by Google. We verify it
    by calling Google's tokeninfo endpoint, then create the user (signup) or
    return an existing one (signin).
    """
    body = request.get_json(silent=True) or {}
    credential = (body.get("credential") or "").strip()
    if not credential:
        return jsonify(ok=False, error="Missing Google credential"), 400

    try:
        url = "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode({"id_token": credential})
        with urllib.request.urlopen(url, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        return jsonify(ok=False, error=f"Could not verify Google token: {e}"), 401

    # Validate audience + expiry
    if GOOGLE_CLIENT_ID and payload.get("aud") != GOOGLE_CLIENT_ID:
        return jsonify(ok=False, error="Google token not issued for this app"), 401
    if int(payload.get("exp", "0")) < int(time.time()):
        return jsonify(ok=False, error="Google token expired"), 401
    if payload.get("email_verified") not in ("true", True):
        return jsonify(ok=False, error="Google account email is not verified"), 401

    email = (payload.get("email") or "").strip().lower()
    name = (payload.get("name") or payload.get("given_name") or email.split("@")[0]).strip()
    if not is_email(email):
        return jsonify(ok=False, error="Google did not return a valid email"), 401

    conn = dbmod.get_conn()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row:
        # Create a passwordless account (random hash so password sign-in fails)
        role = "admin" if conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"] == 0 else "member"
        user_id = dbmod.uid()
        with dbmod._lock:
            conn.execute(
                "INSERT INTO users (id, name, email, pw_hash, role, verified, joined_at) "
                "VALUES (?, ?, ?, ?, ?, 1, ?)",
                (user_id, name, email, hash_password(secrets.token_urlsafe(32)), role, dbmod.now_iso()),
            )
            conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()

    token = issue_session(row["id"])
    return jsonify(ok=True, token=token, user=dbmod.user_to_api(row, public=False))
def auth_forgot_check():
    """Return whether an account exists (so the UI can show a clean error)
    before we go through the OTP send step. Always issue an OTP so we don't
    leak account existence on the email side."""
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    if not is_email(email):
        return jsonify(ok=False, error="Valid email required"), 400
    conn = dbmod.get_conn()
    row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    return jsonify(ok=True, exists=bool(row))


@app.post("/api/auth/reset")
def auth_reset():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    code = (body.get("code") or "").strip()
    password = body.get("password") or ""

    if not is_email(email) or len(password) < 8:
        return jsonify(ok=False, error="Email and 8+ char password required"), 400
    if not dbmod.consume_otp(email, code, "reset"):
        return jsonify(ok=False, error="Invalid or expired verification code"), 400

    conn = dbmod.get_conn()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row:
        return jsonify(ok=False, error="Account not found"), 404
    with dbmod._lock:
        conn.execute("UPDATE users SET pw_hash = ? WHERE id = ?", (hash_password(password), row["id"]))
        conn.commit()
    token = issue_session(row["id"])
    return jsonify(ok=True, token=token, user=dbmod.user_to_api(row, public=False))


@app.post("/api/auth/signout")
@require_auth
def auth_signout():
    conn = dbmod.get_conn()
    with dbmod._lock:
        conn.execute("DELETE FROM sessions WHERE token = ?", (g.token,))
        conn.commit()
    return jsonify(ok=True)


@app.get("/api/me")
@require_auth
def me():
    return jsonify(ok=True, user=g.user)


# ─── Users ─────────────────────────────────────────────────────────────────
@app.get("/api/users")
@require_auth
def list_users():
    conn = dbmod.get_conn()
    rows = conn.execute("SELECT * FROM users ORDER BY joined_at ASC").fetchall()
    return jsonify(ok=True, users=[dbmod.user_to_api(r) for r in rows])


# ─── Projects ──────────────────────────────────────────────────────────────
@app.get("/api/projects")
@require_auth
def list_projects():
    conn = dbmod.get_conn()
    rows = conn.execute("SELECT * FROM projects ORDER BY created_at ASC").fetchall()
    return jsonify(ok=True, projects=[dbmod.project_to_api(r) for r in rows])


@app.post("/api/projects")
@require_auth
def create_project():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    key = (body.get("key") or "").strip().upper()
    if not name or not re.fullmatch(r"[A-Z]{2,10}", key):
        return jsonify(ok=False, error="Name and 2-10 letter uppercase key required"), 400

    conn = dbmod.get_conn()
    if conn.execute("SELECT id FROM projects WHERE key = ?", (key,)).fetchone():
        return jsonify(ok=False, error=f"Project key {key} already exists"), 409

    pid = dbmod.uid()
    with dbmod._lock:
        conn.execute(
            "INSERT INTO projects (id, name, key, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            (pid, name, key, g.user["email"], dbmod.now_iso()),
        )
        conn.commit()
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    return jsonify(ok=True, project=dbmod.project_to_api(row))


@app.delete("/api/projects/<pid>")
@require_auth
def delete_project(pid):
    conn = dbmod.get_conn()
    with dbmod._lock:
        conn.execute("DELETE FROM projects WHERE id = ?", (pid,))
        conn.commit()
    return jsonify(ok=True)


# ─── Issues ────────────────────────────────────────────────────────────────
def _issue_with_comments(conn, issue_id):
    irow = conn.execute("SELECT * FROM issues WHERE id = ?", (issue_id,)).fetchone()
    if not irow:
        return None
    issue = dbmod.issue_to_api(irow)
    crows = conn.execute(
        "SELECT * FROM comments WHERE issue_id = ? ORDER BY at ASC", (issue_id,)
    ).fetchall()
    issue["comments"] = [dbmod.comment_to_api(r) for r in crows]
    return issue


@app.get("/api/issues")
@require_auth
def list_issues():
    project_id = request.args.get("projectId")
    conn = dbmod.get_conn()
    if project_id:
        rows = conn.execute(
            "SELECT * FROM issues WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM issues ORDER BY created_at DESC").fetchall()
    issues = []
    for r in rows:
        issue = dbmod.issue_to_api(r)
        crows = conn.execute(
            "SELECT * FROM comments WHERE issue_id = ? ORDER BY at ASC", (r["id"],)
        ).fetchall()
        issue["comments"] = [dbmod.comment_to_api(c) for c in crows]
        issues.append(issue)
    return jsonify(ok=True, issues=issues)


VALID_TYPES = {"task", "bug", "story", "epic"}
VALID_STATUSES = {"todo", "in_progress", "in_review", "done"}
VALID_PRIORITIES = {"highest", "high", "medium", "low", "lowest"}


@app.post("/api/issues")
@require_auth
def create_issue():
    body = request.get_json(silent=True) or {}
    pid = body.get("projectId")
    title = (body.get("title") or "").strip()
    if not pid or not title:
        return jsonify(ok=False, error="projectId and title are required"), 400

    conn = dbmod.get_conn()
    proj = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    if not proj:
        return jsonify(ok=False, error="Project not found"), 404

    with dbmod._lock:
        seq = proj["next_seq"]
        conn.execute("UPDATE projects SET next_seq = next_seq + 1 WHERE id = ?", (pid,))
        issue_id = dbmod.uid()
        issue_key = f"{proj['key']}-{seq}"
        ts = dbmod.now_iso()
        conn.execute(
            "INSERT INTO issues (id, project_id, issue_key, title, description, type, status, "
            "priority, assignee, reporter, due_date, labels, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                issue_id, pid, issue_key, title,
                body.get("description") or "",
                body.get("type") if body.get("type") in VALID_TYPES else "task",
                body.get("status") if body.get("status") in VALID_STATUSES else "todo",
                body.get("priority") if body.get("priority") in VALID_PRIORITIES else "medium",
                body.get("assignee"),
                g.user["email"],
                body.get("dueDate"),
                json.dumps(body.get("labels") or []),
                ts, ts,
            ),
        )
        conn.commit()
    return jsonify(ok=True, issue=_issue_with_comments(conn, issue_id))


@app.patch("/api/issues/<iid>")
@require_auth
def update_issue(iid):
    body = request.get_json(silent=True) or {}
    fields = []
    values = []
    mapping = {
        "title": "title", "description": "description",
        "type": "type", "status": "status", "priority": "priority",
        "assignee": "assignee", "dueDate": "due_date",
    }
    for api_key, col in mapping.items():
        if api_key in body:
            fields.append(f"{col} = ?")
            values.append(body[api_key])
    if "labels" in body:
        fields.append("labels = ?")
        values.append(json.dumps(body["labels"] or []))
    if not fields:
        return jsonify(ok=False, error="No updatable fields supplied"), 400
    fields.append("updated_at = ?")
    values.append(dbmod.now_iso())
    values.append(iid)
    conn = dbmod.get_conn()
    with dbmod._lock:
        cur = conn.execute(f"UPDATE issues SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    if cur.rowcount == 0:
        return jsonify(ok=False, error="Issue not found"), 404
    return jsonify(ok=True, issue=_issue_with_comments(conn, iid))


@app.delete("/api/issues/<iid>")
@require_auth
def delete_issue(iid):
    conn = dbmod.get_conn()
    with dbmod._lock:
        conn.execute("DELETE FROM issues WHERE id = ?", (iid,))
        conn.commit()
    return jsonify(ok=True)


@app.post("/api/issues/<iid>/comments")
@require_auth
def add_comment(iid):
    body = request.get_json(silent=True) or {}
    text = (body.get("body") or "").strip()
    if not text:
        return jsonify(ok=False, error="Comment body required"), 400
    conn = dbmod.get_conn()
    if not conn.execute("SELECT id FROM issues WHERE id = ?", (iid,)).fetchone():
        return jsonify(ok=False, error="Issue not found"), 404
    cid = dbmod.uid()
    with dbmod._lock:
        conn.execute(
            "INSERT INTO comments (id, issue_id, author, body, at) VALUES (?, ?, ?, ?, ?)",
            (cid, iid, g.user["email"], text, dbmod.now_iso()),
        )
        conn.execute("UPDATE issues SET updated_at = ? WHERE id = ?",
                     (dbmod.now_iso(), iid))
        conn.commit()
    return jsonify(ok=True, issue=_issue_with_comments(conn, iid))


# ─── Meetings ──────────────────────────────────────────────────────────────
@app.get("/api/meetings")
@require_auth
def list_meetings():
    conn = dbmod.get_conn()
    rows = conn.execute("SELECT * FROM meetings ORDER BY date ASC, time ASC").fetchall()
    return jsonify(ok=True, meetings=[dbmod.meeting_to_api(r) for r in rows])


@app.post("/api/meetings")
@require_auth
def create_meeting():
    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    date = (body.get("date") or "").strip()
    url = (body.get("meetingUrl") or "").strip()
    if not title or not date or not url:
        return jsonify(ok=False, error="title, date and meetingUrl are required"), 400

    mid = dbmod.uid()
    ts = dbmod.now_iso()
    conn = dbmod.get_conn()
    with dbmod._lock:
        conn.execute(
            "INSERT INTO meetings (id, title, description, host, provider, meeting_url, "
            "date, time, duration, attendees, created_by, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                mid, title, body.get("description") or "",
                body.get("host") or g.user["name"],
                body.get("provider") or "jitsi",
                url, date, body.get("time") or "",
                int(body.get("duration") or 30),
                json.dumps(body.get("attendees") or []),
                g.user["email"], ts, ts,
            ),
        )
        conn.commit()
    row = conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
    return jsonify(ok=True, meeting=dbmod.meeting_to_api(row))


@app.patch("/api/meetings/<mid>")
@require_auth
def update_meeting(mid):
    body = request.get_json(silent=True) or {}
    fields, values = [], []
    mapping = {
        "title": "title", "description": "description", "host": "host",
        "provider": "provider", "meetingUrl": "meeting_url",
        "date": "date", "time": "time", "duration": "duration",
    }
    for k, col in mapping.items():
        if k in body:
            fields.append(f"{col} = ?")
            values.append(body[k])
    if "attendees" in body:
        fields.append("attendees = ?")
        values.append(json.dumps(body["attendees"] or []))
    if not fields:
        return jsonify(ok=False, error="No updatable fields"), 400
    fields.append("updated_at = ?")
    values.append(dbmod.now_iso())
    values.append(mid)
    conn = dbmod.get_conn()
    with dbmod._lock:
        cur = conn.execute(f"UPDATE meetings SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    if cur.rowcount == 0:
        return jsonify(ok=False, error="Meeting not found"), 404
    row = conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
    return jsonify(ok=True, meeting=dbmod.meeting_to_api(row))


@app.delete("/api/meetings/<mid>")
@require_auth
def delete_meeting(mid):
    conn = dbmod.get_conn()
    with dbmod._lock:
        conn.execute("DELETE FROM meetings WHERE id = ?", (mid,))
        conn.commit()
    return jsonify(ok=True)


# ─── Dashboard summary ─────────────────────────────────────────────────────
@app.get("/api/dashboard")
@require_auth
def dashboard():
    conn = dbmod.get_conn()
    counts = {
        "projects": conn.execute("SELECT COUNT(*) c FROM projects").fetchone()["c"],
        "issues":   conn.execute("SELECT COUNT(*) c FROM issues").fetchone()["c"],
        "meetings": conn.execute("SELECT COUNT(*) c FROM meetings").fetchone()["c"],
        "users":    conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"],
    }
    by_status = {
        r["status"]: r["c"] for r in conn.execute(
            "SELECT status, COUNT(*) c FROM issues GROUP BY status"
        ).fetchall()
    }
    my_open = conn.execute(
        "SELECT COUNT(*) c FROM issues WHERE assignee = ? AND status != 'done'",
        (g.user["email"],),
    ).fetchone()["c"]
    upcoming = conn.execute(
        "SELECT * FROM meetings WHERE date >= date('now') ORDER BY date ASC, time ASC LIMIT 5"
    ).fetchall()
    my_issues = conn.execute(
        "SELECT i.*, p.key AS project_key, p.name AS project_name "
        "FROM issues i LEFT JOIN projects p ON p.id = i.project_id "
        "WHERE i.assignee = ? AND i.status != 'done' "
        "ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date ASC LIMIT 8",
        (g.user["email"],),
    ).fetchall()
    recent_issues = conn.execute(
        "SELECT i.*, p.key AS project_key, p.name AS project_name "
        "FROM issues i LEFT JOIN projects p ON p.id = i.project_id "
        "ORDER BY i.updated_at DESC LIMIT 8"
    ).fetchall()

    def issue_card(r):
        d = dbmod.issue_to_api(r)
        d["projectKey"] = r["project_key"]
        d["projectName"] = r["project_name"]
        return d

    by_priority = {
        r["priority"]: r["c"] for r in conn.execute(
            "SELECT priority, COUNT(*) c FROM issues WHERE status != 'done' GROUP BY priority"
        ).fetchall()
    }

    return jsonify(
        ok=True,
        counts=counts,
        byStatus=by_status,
        byPriority=by_priority,
        myOpen=my_open,
        upcomingMeetings=[dbmod.meeting_to_api(r) for r in upcoming],
        myIssues=[issue_card(r) for r in my_issues],
        recentIssues=[issue_card(r) for r in recent_issues],
    )


# ─── Notifications ─────────────────────────────────────────────────────────
# Notifications are derived live from the database so the user always sees
# fresh signals without needing a separate notifications table.
@app.get("/api/notifications")
@require_auth
def notifications():
    conn = dbmod.get_conn()
    me_email = g.user["email"]
    today = datetime.utcnow().date()
    items = []

    # 1) Issues assigned to me, overdue or due soon
    rows = conn.execute(
        "SELECT i.*, p.key AS project_key FROM issues i "
        "LEFT JOIN projects p ON p.id = i.project_id "
        "WHERE i.assignee = ? AND i.status != 'done' AND i.due_date IS NOT NULL "
        "ORDER BY i.due_date ASC LIMIT 20",
        (me_email,),
    ).fetchall()
    for r in rows:
        try:
            due = datetime.fromisoformat(r["due_date"]).date()
        except Exception:
            continue
        days = (due - today).days
        if days < 0:
            kind, title = "overdue", f"{r['issue_key']} is overdue"
            body = f"\"{r['title']}\" was due {-days} day(s) ago"
        elif days <= 2:
            kind = "due_soon"
            title = f"{r['issue_key']} due " + ("today" if days == 0 else f"in {days} day(s)")
            body = r["title"]
        else:
            continue
        items.append({
            "id": f"due-{r['id']}",
            "kind": kind,
            "title": title,
            "body": body,
            "at": r["updated_at"],
            "link": {"type": "issue", "id": r["id"], "projectId": r["project_id"]},
        })

    # 2) Upcoming meetings within 24h where I'm host or attendee
    mrows = conn.execute(
        "SELECT * FROM meetings WHERE date >= date('now') AND date <= date('now', '+1 day') "
        "ORDER BY date ASC, time ASC"
    ).fetchall()
    for r in mrows:
        m = dbmod.meeting_to_api(r)
        attendees = m.get("attendees") or []
        if me_email not in attendees and r["created_by"] != me_email:
            continue
        when = m.get("date") + (f" {m['time']}" if m.get("time") else "")
        items.append({
            "id": f"mtg-{r['id']}",
            "kind": "meeting",
            "title": f"Meeting soon: {m['title']}",
            "body": f"{when} · {m.get('host') or ''}",
            "at": r["updated_at"],
            "link": {"type": "meeting", "id": r["id"]},
        })

    # 3) Recent comments on issues I reported or am assigned to (not by me)
    crows = conn.execute(
        "SELECT c.*, i.issue_key, i.title AS issue_title, i.project_id "
        "FROM comments c JOIN issues i ON i.id = c.issue_id "
        "WHERE c.author != ? AND (i.reporter = ? OR i.assignee = ?) "
        "ORDER BY c.at DESC LIMIT 10",
        (me_email, me_email, me_email),
    ).fetchall()
    for r in crows:
        items.append({
            "id": f"cm-{r['id']}",
            "kind": "comment",
            "title": f"{r['author']} commented on {r['issue_key']}",
            "body": (r["body"] or "")[:140],
            "at": r["at"],
            "link": {"type": "issue", "id": r["issue_id"], "projectId": r["project_id"]},
        })

    items.sort(key=lambda x: x.get("at") or "", reverse=True)
    return jsonify(ok=True, notifications=items[:30], unread=len(items))


# ─── Entrypoint ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    verify_smtp()
    print(f"[server.py] Jiraly mail API listening on http://localhost:{PORT}")
    # debug=False so the verify_smtp output isn't duplicated by the reloader.
    app.run(host="0.0.0.0", port=PORT, debug=False)
