import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import "dotenv/config";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT      = process.env.PORT || 5179;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = (process.env.SMTP_USER || "").trim();
// Gmail App Passwords are shown as "abcd efgh ijkl mnop" — strip spaces so
// users can paste either form. Also trims accidental surrounding whitespace.
const SMTP_PASS = (process.env.SMTP_PASS || "").replace(/\s+/g, "");
const FROM      = process.env.MAIL_FROM || `"Jiraly" <${SMTP_USER}>`;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.warn("[server] WARNING: SMTP_HOST / SMTP_USER / SMTP_PASS not set — /api/send-invite will fail. Copy .env.example → .env and fill it in.");
}

const transporter = nodemailer.createTransport({
  host:   SMTP_HOST,
  port:   SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth:   SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

// Verify SMTP login at startup so problems show up immediately, not on first send.
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter.verify((err) => {
    if (err) console.error("[server] ❌ SMTP verification FAILED:", err.message);
    else     console.log("[server] ✅ SMTP ready — logged in as", SMTP_USER);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
const esc = (s) => (s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
const escHtml = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function buildIcs(m) {
  const dt  = new Date(`${m.date}T${m.time || "00:00"}`);
  const end = new Date(dt.getTime() + (m.duration || 30) * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const attendees = (m.attendees || []).filter(isEmail).map(e => `ATTENDEE;RSVP=TRUE:mailto:${e}`).join("\r\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jiraly//EN", "METHOD:REQUEST", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${m.id || Date.now()}@jiraly`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(dt)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc((m.description ? m.description + "\\n\\n" : "") + "Join: " + m.meetingUrl)}`,
    `LOCATION:${esc(m.meetingUrl)}`,
    `URL:${m.meetingUrl}`,
    `ORGANIZER;CN=${esc(m.host || "Organizer")}:mailto:${SMTP_USER}`,
    attendees,
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
}

function buildHtml(m, when, providerLabel) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#172B4D">
    <div style="background:#0052CC;color:#fff;padding:18px 22px;border-radius:6px 6px 0 0">
      <div style="font-size:12px;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px">Meeting invitation</div>
      <div style="font-size:20px;font-weight:600;margin-top:4px">${escHtml(m.title)}</div>
    </div>
    <div style="background:#fff;border:1px solid #DFE1E6;border-top:none;border-radius:0 0 6px 6px;padding:22px">
      <table style="font-size:14px;line-height:1.6;width:100%;border-collapse:collapse">
        <tr><td style="color:#6B778C;width:90px">When</td><td><strong>${escHtml(when)}</strong>${m.duration ? ` (${m.duration} min)` : ""}</td></tr>
        <tr><td style="color:#6B778C">Host</td><td>${escHtml(m.host || "")}</td></tr>
        <tr><td style="color:#6B778C">Platform</td><td>${escHtml(providerLabel)}</td></tr>
      </table>
      <div style="margin:22px 0">
        <a href="${escHtml(m.meetingUrl)}"
           style="display:inline-block;background:#0052CC;color:#fff;text-decoration:none;padding:11px 22px;border-radius:3px;font-weight:600;font-size:14px">
          Join meeting
        </a>
      </div>
      <div style="font-size:12px;color:#6B778C;font-family:SFMono-Regular,Menlo,monospace;background:#FAFBFC;padding:8px 10px;border:1px solid #DFE1E6;border-radius:3px;word-break:break-all">
        ${escHtml(m.meetingUrl)}
      </div>
      ${m.description ? `<div style="margin-top:18px"><div style="font-size:11px;color:#6B778C;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;margin-bottom:6px">Agenda</div><div style="font-size:14px;white-space:pre-wrap;line-height:1.5">${escHtml(m.description)}</div></div>` : ""}
      <div style="margin-top:22px;padding-top:14px;border-top:1px solid #DFE1E6;font-size:11px;color:#97A0AF">
        Sent from Jiraly · The .ics attachment will add this to your calendar.
      </div>
    </div>
  </div>`;
}

function buildText(m, when, providerLabel) {
  return [
    `You're invited to: ${m.title}`,
    ``,
    `When:     ${when}${m.duration ? ` (${m.duration} min)` : ""}`,
    `Host:     ${m.host || ""}`,
    `Platform: ${providerLabel}`,
    ``,
    `Join link:`,
    m.meetingUrl,
    ``,
    m.description ? `Agenda / Notes:\n${m.description}\n` : "",
    `— Sent from Jiraly`,
  ].filter(Boolean).join("\n");
}

// ─── Routes ───────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    smtpConfigured: !!(SMTP_HOST && SMTP_USER && SMTP_PASS),
    from: FROM,
  });
});

app.post("/api/send-invite", async (req, res) => {
  try {
    const m = req.body || {};
    if (!m.title || !m.date || !m.meetingUrl) {
      return res.status(400).json({ ok: false, error: "title, date, and meetingUrl are required" });
    }
    const recipients = (m.attendees || []).filter(isEmail);
    if (recipients.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid attendee emails" });
    }
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      return res.status(500).json({ ok: false, error: "SMTP not configured on server. Set SMTP_HOST, SMTP_USER, SMTP_PASS in .env" });
    }

    const dt = new Date(`${m.date}T${m.time || "00:00"}`);
    const when = dt.toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const providerLabel = m.providerLabel || m.provider || "Online";

    const info = await transporter.sendMail({
      from:    FROM,
      to:      recipients,
      subject: `Invitation: ${m.title} — ${when}`,
      text:    buildText(m, when, providerLabel),
      html:    buildHtml(m, when, providerLabel),
      icalEvent: {
        method:   "REQUEST",
        filename: "invite.ics",
        content:  buildIcs(m),
      },
    });

    console.log(`[server] ✉ Sent "${m.title}" → ${recipients.join(", ")} (id=${info.messageId})`);
    res.json({ ok: true, messageId: info.messageId, sentTo: recipients });
  } catch (err) {
    console.error("[send-invite] FAILED:", err);
    const msg = err?.response || err?.message || String(err) || "Unknown mail error";
    res.status(500).json({ ok: false, error: `SMTP: ${msg}`, code: err?.code });
  }
});

app.listen(PORT, () => {
  console.log(`[server] Jiraly mail API listening on http://localhost:${PORT}`);
});
