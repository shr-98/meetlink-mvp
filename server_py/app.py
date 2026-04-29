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

import os
import re
import smtplib
import ssl
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

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

if not SMTP_CONFIGURED:
    print(
        "[server.py] WARNING: SMTP_HOST / SMTP_USER / SMTP_PASS not all set — "
        "/api/send-invite will fail. Copy .env.example → .env and fill it in."
    )

app = Flask(__name__)
CORS(app)

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


# ─── Entrypoint ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    verify_smtp()
    print(f"[server.py] Jiraly mail API listening on http://localhost:{PORT}")
    # debug=False so the verify_smtp output isn't duplicated by the reloader.
    app.run(host="0.0.0.0", port=PORT, debug=False)
