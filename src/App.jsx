import { useState, useEffect, useMemo, useRef } from "react";

// ─── Storage (window.storage API, persists across sessions) ──────────────────
const db = {
  async get(key) {
    try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; }
    catch { return null; }
  },
  async set(key, val) {
    try { await window.storage.set(key, JSON.stringify(val)); } catch {}
  },
};
const KEYS = {
  USERS:    "jr:users",
  SESSION:  "jr:session",
  PROJECTS: "jr:projects",
  ISSUES:   "jr:issues",
  ACTIVE:   "jr:active",
  MEETINGS: "jr:meetings",
  SEEDED:   "jr:seeded",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pwHash = (s) => { let h = 0; for (let c of s) h = Math.imul(31, h) + c.charCodeAt(0) | 0; return h.toString(36); };
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const now = () => new Date().toISOString();
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Generate a shareable, unique meeting link for a chosen provider.
const MEETING_PROVIDERS = [
  { id: "jitsi",  label: "Jitsi Meet",   build: (slug) => `https://meet.jit.si/${slug}` },
  { id: "gmeet",  label: "Google Meet",  build: (slug) => {
      const s = slug.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12).padEnd(10, "x");
      return `https://meet.google.com/${s.slice(0,3)}-${s.slice(3,7)}-${s.slice(7,10)}`;
    } },
  { id: "zoom",   label: "Zoom",         build: () => `https://zoom.us/j/${Math.floor(1e10 + Math.random() * 9e10)}` },
  { id: "teams",  label: "MS Teams",     build: (slug) => `https://teams.microsoft.com/l/meetup-join/${slug}-${uid()}` },
];
const PROVIDER_BY_ID = Object.fromEntries(MEETING_PROVIDERS.map(p => [p.id, p]));
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "meeting";
const generateMeetingLink = (providerId, title) => {
  const p = PROVIDER_BY_ID[providerId] || MEETING_PROVIDERS[0];
  const slug = `${slugify(title)}-${Math.random().toString(36).slice(2, 7)}`;
  return p.build(slug);
};

// Build a mailto: invite that opens the user's email client pre-filled.
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
const buildMailtoInvite = (m, fromName) => {
  const dt = new Date(`${m.date}T${m.time || "00:00"}`);
  const when = dt.toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const provider = (PROVIDER_BY_ID[m.provider] || MEETING_PROVIDERS[0]).label;
  const emails = (m.attendees || []).filter(isEmail);
  const subject = `Invitation: ${m.title} — ${when}`;
  const body = [
    `You're invited to: ${m.title}`,
    ``,
    `When:     ${when}${m.duration ? ` (${m.duration} min)` : ""}`,
    `Host:     ${m.host || fromName || ""}`,
    `Platform: ${provider}`,
    ``,
    `Join link:`,
    m.meetingUrl,
    ``,
    m.description ? `Agenda / Notes:\n${m.description}\n` : "",
    `— Sent from Jiraly`,
  ].filter(Boolean).join("\n");
  return `mailto:${encodeURIComponent(emails.join(","))}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};
// Build a downloadable .ics calendar file (works with Gmail, Outlook, Apple Calendar)
const buildIcs = (m) => {
  const dt = new Date(`${m.date}T${m.time || "00:00"}`);
  const end = new Date(dt.getTime() + (m.duration || 30) * 60000);
  const fmt = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const esc = (s) => (s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const attendees = (m.attendees || []).filter(isEmail).map(e => `ATTENDEE;RSVP=TRUE:mailto:${e}`).join("\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jiraly//EN", "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${m.id}@jiraly`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(dt)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(m.title)}`,
    `DESCRIPTION:${esc((m.description ? m.description + "\\n\\n" : "") + "Join: " + m.meetingUrl)}`,
    `LOCATION:${esc(m.meetingUrl)}`,
    `URL:${m.meetingUrl}`,
    attendees,
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");
};
const downloadIcs = (m) => {
  const blob = new Blob([buildIcs(m)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${slugify(m.title)}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ─── Backend mail API ────────────────────────────────────────────────────────
// Calls the Node/Express + Nodemailer server at /api/send-invite (proxied
// through Vite to http://localhost:5174 in dev).
const API_BASE = "/api";
async function sendInviteEmails(meeting) {
  const providerLabel = (PROVIDER_BY_ID[meeting.provider] || MEETING_PROVIDERS[0]).label;
  const res = await fetch(`${API_BASE}/send-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...meeting, providerLabel }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Mail server returned ${res.status}`);
  }
  return data;
}
async function checkMailServer() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (!res.ok) return { reachable: false };
    return { reachable: true, ...(await res.json()) };
  } catch {
    return { reachable: false };
  }
}

// ─── Domain constants (Jira-style) ───────────────────────────────────────────
const STATUSES = [
  { id: "todo",        label: "To Do",        color: "#42526E", bg: "#DFE1E6" },
  { id: "in_progress", label: "In Progress",  color: "#0747A6", bg: "#DEEBFF" },
  { id: "in_review",   label: "In Review",    color: "#5243AA", bg: "#EAE6FF" },
  { id: "done",        label: "Done",         color: "#006644", bg: "#E3FCEF" },
];
const STATUS_BY_ID = Object.fromEntries(STATUSES.map(s => [s.id, s]));

const PRIORITIES = [
  { id: "highest", label: "Highest", icon: "↑↑", color: "#CD1316" },
  { id: "high",    label: "High",    icon: "↑",  color: "#E97F33" },
  { id: "medium",  label: "Medium",  icon: "=",  color: "#E2A03F" },
  { id: "low",     label: "Low",     icon: "↓",  color: "#2684FF" },
  { id: "lowest",  label: "Lowest",  icon: "↓↓", color: "#57A55A" },
];
const PRIO_BY_ID = Object.fromEntries(PRIORITIES.map(p => [p.id, p]));

const TYPES = [
  { id: "task",  label: "Task",  icon: "✓", color: "#4BADE8" },
  { id: "bug",   label: "Bug",   icon: "●", color: "#E5493A" },
  { id: "story", label: "Story", icon: "◆", color: "#65BA43" },
  { id: "epic",  label: "Epic",  icon: "⚡", color: "#904EE2" },
];
const TYPE_BY_ID = Object.fromEntries(TYPES.map(t => [t.id, t]));

// ─── Design tokens (Atlassian-inspired) ──────────────────────────────────────
const C = {
  primary:    "#0052CC",
  primaryDk:  "#0747A6",
  primaryLt:  "#DEEBFF",
  text:       "#172B4D",
  text2:      "#42526E",
  text3:      "#6B778C",
  border:     "#DFE1E6",
  borderDk:   "#C1C7D0",
  bg:         "#FFFFFF",
  bg2:        "#F4F5F7",
  bg3:        "#FAFBFC",
  danger:     "#DE350B",
  dangerBg:   "#FFEBE6",
  success:    "#006644",
  successBg:  "#E3FCEF",
};
const F = {
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  mono: "'SF Mono', Menlo, Consolas, monospace",
};

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady]       = useState(false);
  const [session, setSession]   = useState(null);
  const [users, setUsers]       = useState([]);
  const [projects, setProjects] = useState([]);
  const [issues, setIssues]     = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [view, setView]         = useState("board"); // board | backlog | meetings
  const [openIssue, setOpenIssue] = useState(null);
  const [showProjModal, setShowProjModal] = useState(false);
  const [editingIssue, setEditingIssue] = useState(null);
  const [editingMeeting, setEditingMeeting] = useState(null);
  const [toast, setToast]       = useState(null);

  useEffect(() => {
    (async () => {
      const [sess, us, ps, is, ms, act, seeded] = await Promise.all([
        db.get(KEYS.SESSION),
        db.get(KEYS.USERS),
        db.get(KEYS.PROJECTS),
        db.get(KEYS.ISSUES),
        db.get(KEYS.MEETINGS),
        db.get(KEYS.ACTIVE),
        db.get(KEYS.SEEDED),
      ]);
      let pp = ps || [], ii = is || [], mm = ms || [];
      if (!seeded && pp.length === 0) {
        const seed = buildSeedData();
        pp = seed.projects; ii = seed.issues; mm = seed.meetings;
        await Promise.all([
          db.set(KEYS.PROJECTS, pp),
          db.set(KEYS.ISSUES, ii),
          db.set(KEYS.MEETINGS, mm),
          db.set(KEYS.SEEDED, true),
        ]);
      }
      setSession(sess); setUsers(us || []); setProjects(pp); setIssues(ii); setMeetings(mm);
      setActiveId(act || (pp[0]?.id ?? null));
      setReady(true);
    })();
  }, []);

  const flash = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  const login  = async (sess) => { setSession(sess); await db.set(KEYS.SESSION, sess); };
  const logout = async () => { setSession(null); await db.set(KEYS.SESSION, null); };

  const saveUsers    = async (l) => { setUsers(l); await db.set(KEYS.USERS, l); };
  const saveProjects = async (l) => { setProjects(l); await db.set(KEYS.PROJECTS, l); };
  const saveIssues   = async (l) => { setIssues(l); await db.set(KEYS.ISSUES, l); };
  const saveMeetings = async (l) => { setMeetings(l); await db.set(KEYS.MEETINGS, l); };
  const saveActive   = async (id) => { setActiveId(id); await db.set(KEYS.ACTIVE, id); };

  const activeProject = projects.find(p => p.id === activeId);
  const projectIssues = useMemo(
    () => issues.filter(i => i.projectId === activeId),
    [issues, activeId]
  );

  const nextKey = (project) => {
    const used = issues.filter(i => i.projectId === project.id).length;
    return `${project.key}-${used + 1}`;
  };

  const createProject = async ({ name, key }) => {
    const proj = { id: uid(), name, key: key.toUpperCase(), createdBy: session.email, createdAt: now() };
    await saveProjects([...projects, proj]);
    await saveActive(proj.id);
    setShowProjModal(false);
    flash(`Project ${proj.key} created`);
  };

  const saveIssue = async (data) => {
    if (data.id) {
      const updated = issues.map(i => i.id === data.id ? { ...i, ...data, updatedAt: now() } : i);
      await saveIssues(updated);
      if (openIssue?.id === data.id) setOpenIssue(updated.find(i => i.id === data.id));
      flash("Issue updated");
    } else {
      const proj = projects.find(p => p.id === data.projectId);
      const newIssue = {
        ...data,
        id: uid(),
        key: nextKey(proj),
        reporter: session.email,
        comments: [],
        createdAt: now(),
        updatedAt: now(),
      };
      await saveIssues([...issues, newIssue]);
      flash(`${newIssue.key} created`);
    }
    setEditingIssue(null);
  };

  const deleteIssue = async (id) => {
    await saveIssues(issues.filter(i => i.id !== id));
    setOpenIssue(null);
    flash("Issue deleted", "danger");
  };

  const moveIssue = async (id, statusId) => {
    const updated = issues.map(i => i.id === id ? { ...i, status: statusId, updatedAt: now() } : i);
    await saveIssues(updated);
    if (openIssue?.id === id) setOpenIssue(updated.find(i => i.id === id));
  };

  const addComment = async (issueId, body) => {
    const updated = issues.map(i => {
      if (i.id !== issueId) return i;
      const comments = [...(i.comments || []), { id: uid(), author: session.email, body, at: now() }];
      return { ...i, comments, updatedAt: now() };
    });
    await saveIssues(updated);
    setOpenIssue(updated.find(i => i.id === issueId));
  };

  const saveMeeting = async (data) => {
    if (data.id) {
      const updated = meetings.map(m => m.id === data.id ? { ...m, ...data, updatedAt: now() } : m);
      await saveMeetings(updated);
      flash("Meeting updated");
      setEditingMeeting(null);
      return updated.find(m => m.id === data.id);
    }
    const link = data.meetingUrl?.trim() || generateMeetingLink(data.provider, data.title);
    const m = {
      ...data, id: uid(), meetingUrl: link,
      createdBy: session.email, createdAt: now(), updatedAt: now(),
    };
    await saveMeetings([...meetings, m]);
    flash("Meeting scheduled — link generated");
    setEditingMeeting(null);

    // Send invitation emails via the backend (Nodemailer/SMTP).
    const recipients = (m.attendees || []).filter(isEmail);
    if (recipients.length > 0) {
      try {
        const r = await sendInviteEmails(m);
        flash(`✉ Invite sent to ${r.sentTo?.length ?? recipients.length} attendee(s)`);
      } catch (err) {
        flash(`Mail server unreachable — opening your email client instead`, "danger");
        setTimeout(() => { window.location.href = buildMailtoInvite(m, session.name); }, 400);
        console.warn("[Jiraly] sendInviteEmails failed:", err.message);
      }
    }
    return m;
  };

  const deleteMeeting = async (id) => {
    await saveMeetings(meetings.filter(m => m.id !== id));
    flash("Meeting removed", "danger");
  };

  if (!ready) return <Splash />;
  if (!session) return <AuthScreen onLogin={login} users={users} saveUsers={saveUsers} />;

  return (
    <>
      <GlobalStyle />
      <div style={{ fontFamily: F.sans, color: C.text, minHeight: "100vh", display: "flex", background: C.bg2 }}>
        <Sidebar
          projects={projects}
          activeId={activeId}
          onPick={saveActive}
          onNewProject={() => setShowProjModal(true)}
          view={view}
          setView={setView}
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar
            session={session}
            project={activeProject}
            view={view}
            onNewIssue={() => activeProject && setEditingIssue({ projectId: activeProject.id })}
            onNewMeeting={() => setEditingMeeting({})}
            onLogout={logout}
          />

          {view === "meetings" ? (
            <Meetings
              meetings={meetings}
              users={users}
              session={session}
              onNew={() => setEditingMeeting({})}
              onEdit={(m) => setEditingMeeting(m)}
              onDelete={deleteMeeting}
              onCopy={(url) => { navigator.clipboard?.writeText(url); flash("Link copied"); }}
              onSend={async (m) => {
                const recipients = (m.attendees || []).filter(isEmail);
                if (recipients.length === 0) { flash("No valid attendee emails", "danger"); return; }
                try {
                  const r = await sendInviteEmails(m);
                  flash(`✉ Invite sent to ${r.sentTo?.length ?? recipients.length} attendee(s)`);
                } catch (err) {
                  flash(`Mail server error: ${err.message}`, "danger");
                }
              }}
            />
          ) : !activeProject ? (
            <EmptyProjects onNew={() => setShowProjModal(true)} />
          ) : view === "board" ? (
            <Board
              project={activeProject}
              issues={projectIssues}
              users={users}
              onMove={moveIssue}
              onOpen={setOpenIssue}
              onNewInColumn={(statusId) => setEditingIssue({ projectId: activeProject.id, status: statusId })}
            />
          ) : (
            <Backlog
              project={activeProject}
              issues={projectIssues}
              users={users}
              onOpen={setOpenIssue}
              onMove={moveIssue}
            />
          )}
        </div>

        {toast && (
          <div style={{
            position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 1000,
            padding: "10px 18px", borderRadius: 6, fontSize: 13, fontWeight: 500,
            background: toast.type === "danger" ? C.dangerBg : C.successBg,
            color: toast.type === "danger" ? C.danger : C.success,
            border: `1px solid ${toast.type === "danger" ? "#FFBDAD" : "#ABF5D1"}`,
            boxShadow: "0 4px 12px rgba(9, 30, 66, 0.15)",
          }}>{toast.msg}</div>
        )}

        {showProjModal && (
          <ProjectModal onClose={() => setShowProjModal(false)} onCreate={createProject} existing={projects} />
        )}

        {editingIssue && activeProject && (
          <IssueModal
            issue={editingIssue}
            project={activeProject}
            users={users}
            onSave={saveIssue}
            onClose={() => setEditingIssue(null)}
          />
        )}

        {openIssue && (
          <IssueDetail
            issue={openIssue}
            project={projects.find(p => p.id === openIssue.projectId)}
            users={users}
            session={session}
            onClose={() => setOpenIssue(null)}
            onEdit={() => { setEditingIssue(openIssue); setOpenIssue(null); }}
            onDelete={() => deleteIssue(openIssue.id)}
            onMove={(s) => moveIssue(openIssue.id, s)}
            onComment={(b) => addComment(openIssue.id, b)}
          />
        )}

        {editingMeeting && (
          <MeetingModal
            meeting={editingMeeting}
            users={users}
            session={session}
            onSave={saveMeeting}
            onClose={() => setEditingMeeting(null)}
          />
        )}
      </div>
    </>
  );
}

// ─── GlobalStyle ─────────────────────────────────────────────────────────────
function GlobalStyle() {
  return <style>{`
    body { background: ${C.bg2}; }
    button { font-family: inherit; }
    input, textarea, select { font-family: inherit; outline: none; }
    input:focus, textarea:focus, select:focus { border-color: ${C.primary} !important; box-shadow: 0 0 0 1px ${C.primary}; }
    *::-webkit-scrollbar { width: 10px; height: 10px; }
    *::-webkit-scrollbar-thumb { background: ${C.borderDk}; border-radius: 5px; }
    *::-webkit-scrollbar-track { background: transparent; }
    .jr-card { transition: box-shadow 0.12s, transform 0.12s; }
    .jr-card:hover { box-shadow: 0 4px 8px -2px rgba(9,30,66,0.25); }
    .jr-card.dragging { opacity: 0.5; transform: rotate(2deg); }
    .jr-col.over { background: ${C.primaryLt} !important; }
    .jr-btn-primary:hover { background: ${C.primaryDk} !important; }
    .jr-btn-ghost:hover { background: ${C.bg2} !important; }
    .jr-row:hover { background: ${C.bg3} !important; }
    .jr-sb-item:hover { background: rgba(255,255,255,0.08); }
    .jr-sb-item.active { background: ${C.primary} !important; color: #fff !important; }
  `}</style>;
}

function Splash() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: F.sans, color: C.text3, fontSize: 14 }}>
      Loading…
    </div>
  );
}

// ─── AuthScreen ──────────────────────────────────────────────────────────────
function AuthScreen({ onLogin, users, saveUsers }) {
  const [tab, setTab]     = useState("login");
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass]   = useState("");
  const [err, setErr]     = useState("");

  const submit = async () => {
    setErr("");
    if (tab === "signup") {
      if (!name.trim() || !email.trim() || !pass) return setErr("All fields are required");
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return setErr("Enter a valid email");
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return setErr("Email already registered");
      const user = {
        id: uid(),
        name: name.trim(),
        email: email.toLowerCase().trim(),
        ph: pwHash(pass),
        role: users.length === 0 ? "admin" : "member",
        joinedAt: now(),
      };
      await saveUsers([...users, user]);
      const { ph, ...sess } = user;
      onLogin(sess);
    } else {
      if (!email || !pass) return setErr("Email and password required");
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.ph === pwHash(pass));
      if (!user) return setErr("Invalid email or password");
      const { ph, ...sess } = user;
      onLogin(sess);
    }
  };

  return (
    <>
      <GlobalStyle />
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: F.sans, background: C.bg2 }}>
        <div style={{ width: "100%", maxWidth: 400 }}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <Logo size={40} />
            <div style={{ marginTop: 12, fontSize: 22, fontWeight: 600, color: C.text }}>Jiraly</div>
            <div style={{ fontSize: 13, color: C.text3, marginTop: 4 }}>Plan, track, and ship your team's work</div>
          </div>

          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 24, boxShadow: "0 1px 1px rgba(9,30,66,0.08)" }}>
            <div style={{ display: "flex", background: C.bg2, borderRadius: 4, padding: 3, marginBottom: 20 }}>
              {[["login","Sign in"],["signup","Sign up"]].map(([t, label]) => (
                <button key={t} onClick={() => { setTab(t); setErr(""); }}
                  style={{ flex: 1, padding: "7px 0", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 13, fontWeight: 500,
                    background: tab === t ? C.bg : "transparent",
                    color: tab === t ? C.text : C.text3,
                    boxShadow: tab === t ? "0 1px 2px rgba(9,30,66,0.15)" : "none" }}>
                  {label}
                </button>
              ))}
            </div>

            {tab === "signup" && <Field label="Full name"><input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Alex Rivera" /></Field>}
            <Field label="Email"><input type="email" style={inputStyle} value={email} onChange={e => setEmail(e.target.value)} placeholder="alex@company.com" /></Field>
            <Field label="Password"><input type="password" style={inputStyle} value={pass} onChange={e => setPass(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} placeholder="••••••••" /></Field>

            {err && <div style={{ fontSize: 13, color: C.danger, background: C.dangerBg, padding: "8px 12px", borderRadius: 3, marginBottom: 12 }}>{err}</div>}

            <button onClick={submit} className="jr-btn-primary"
              style={{ width: "100%", padding: "9px 0", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontWeight: 500, fontSize: 14, cursor: "pointer" }}>
              {tab === "login" ? "Sign in" : "Create account"}
            </button>
          </div>

          <p style={{ textAlign: "center", marginTop: 14, fontSize: 11, color: C.text3, fontFamily: F.mono }}>
            Data stored locally in this browser
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────
function Sidebar({ projects, activeId, onPick, onNewProject, view, setView }) {
  return (
    <aside style={{ width: 240, background: "#0747A6", color: "#fff", display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.12)", display: "flex", alignItems: "center", gap: 10 }}>
        <Logo size={28} light />
        <span style={{ fontSize: 17, fontWeight: 600 }}>Jiraly</span>
      </div>

      <div style={{ padding: "14px 12px 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.65)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ paddingLeft: 6 }}>Projects</span>
        <button onClick={onNewProject} title="New project"
          style={{ background: "transparent", border: "none", color: "#fff", fontSize: 18, cursor: "pointer", padding: "0 6px", lineHeight: 1 }}>+</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
        {projects.length === 0 && (
          <div style={{ padding: "8px 10px", fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
            No projects yet. Create one to start.
          </div>
        )}
        {projects.map(p => (
          <button key={p.id} onClick={() => onPick(p.id)}
            className={`jr-sb-item ${p.id === activeId ? "active" : ""}`}
            style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "8px 10px", background: "transparent", border: "none", color: "#fff", borderRadius: 4, cursor: "pointer", textAlign: "left", marginBottom: 2, fontSize: 13 }}>
            <span style={{ width: 22, height: 22, borderRadius: 4, background: stringColor(p.key), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
              {p.key.slice(0, 2)}
            </span>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
          </button>
        ))}
      </div>

      {projects.length > 0 && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.65)", padding: "0 6px 6px" }}>View</div>
          {[
            { id: "board",    label: "Board",    icon: "▦" },
            { id: "backlog",  label: "Backlog",  icon: "≡" },
            { id: "meetings", label: "Meetings", icon: "📅" },
          ].map(v => (
            <button key={v.id} onClick={() => setView(v.id)}
              className={`jr-sb-item ${view === v.id ? "active" : ""}`}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, padding: "7px 10px", background: "transparent", border: "none", color: "#fff", borderRadius: 4, cursor: "pointer", textAlign: "left", marginBottom: 2, fontSize: 13 }}>
              <span style={{ width: 18, textAlign: "center" }}>{v.icon}</span>
              <span>{v.label}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

// ─── TopBar ──────────────────────────────────────────────────────────────────
function TopBar({ session, project, view, onNewIssue, onNewMeeting, onLogout }) {
  const isMeetings = view === "meetings";
  return (
    <header style={{ background: C.bg, borderBottom: `1px solid ${C.border}`, padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
      <div style={{ fontSize: 14, color: C.text3 }}>
        {isMeetings ? <span style={{ color: C.text, fontWeight: 500 }}>Meetings</span>
          : project ? (<>Projects / <span style={{ color: C.text, fontWeight: 500 }}>{project.name}</span></>)
          : "Welcome"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {isMeetings ? (
          <button onClick={onNewMeeting} className="jr-btn-primary"
            style={{ padding: "7px 14px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            + Schedule meeting
          </button>
        ) : project && (
          <button onClick={onNewIssue} className="jr-btn-primary"
            style={{ padding: "7px 14px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            + Create issue
          </button>
        )}
        <Avatar email={session.email} name={session.name} size={28} />
        <span style={{ fontSize: 13, color: C.text2 }}>{session.name}</span>
        <button onClick={onLogout} className="jr-btn-ghost"
          style={{ padding: "6px 12px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 3, color: C.text2, fontSize: 12, cursor: "pointer" }}>
          Sign out
        </button>
      </div>
    </header>
  );
}

// ─── Board (Kanban with drag & drop) ─────────────────────────────────────────
function Board({ project, issues, users, onMove, onOpen, onNewInColumn }) {
  const [search, setSearch]       = useState("");
  const [filterAssignee, setFA]   = useState("");
  const [filterType, setFT]       = useState("");
  const [dragId, setDragId]       = useState(null);
  const [overCol, setOverCol]     = useState(null);

  const filtered = useMemo(() => issues.filter(i => {
    const q = search.toLowerCase();
    const s = !search || [i.title, i.key, i.description].some(v => (v || "").toLowerCase().includes(q));
    const a = !filterAssignee || (filterAssignee === "__unassigned" ? !i.assignee : i.assignee === filterAssignee);
    const t = !filterType || i.type === filterType;
    return s && a && t;
  }), [issues, search, filterAssignee, filterType]);

  const grouped = useMemo(() => {
    const g = Object.fromEntries(STATUSES.map(s => [s.id, []]));
    filtered.forEach(i => { (g[i.status] || g.todo).push(i); });
    return g;
  }, [filtered]);

  return (
    <div style={{ padding: "20px 24px", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: C.text, margin: 0 }}>{project.name} board</h1>
        <BoardFilters
          search={search} setSearch={setSearch}
          filterAssignee={filterAssignee} setFA={setFA}
          filterType={filterType} setFT={setFT}
          users={users}
        />
      </div>

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: `repeat(${STATUSES.length}, minmax(260px, 1fr))`, gap: 12, minHeight: 0 }}>
        {STATUSES.map(col => (
          <div key={col.id}
            className={`jr-col ${overCol === col.id ? "over" : ""}`}
            onDragOver={e => { e.preventDefault(); setOverCol(col.id); }}
            onDragLeave={() => setOverCol(c => c === col.id ? null : c)}
            onDrop={() => { if (dragId) onMove(dragId, col.id); setDragId(null); setOverCol(null); }}
            style={{ background: C.bg2, borderRadius: 4, padding: 8, display: "flex", flexDirection: "column", minHeight: 0, border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 8px 8px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: 0.4 }}>
                {col.label} <span style={{ color: C.text3, fontWeight: 400, marginLeft: 4 }}>{grouped[col.id].length}</span>
              </div>
              <button onClick={() => onNewInColumn(col.id)} title="Add issue"
                style={{ background: "transparent", border: "none", color: C.text3, fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>+</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "0 2px" }}>
              {grouped[col.id].map(issue => (
                <IssueCard
                  key={issue.id} issue={issue} users={users}
                  isDragging={dragId === issue.id}
                  onDragStart={() => setDragId(issue.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => onOpen(issue)}
                />
              ))}
              {grouped[col.id].length === 0 && (
                <div style={{ padding: 16, textAlign: "center", fontSize: 12, color: C.text3, fontStyle: "italic" }}>
                  Drop issues here
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardFilters({ search, setSearch, filterAssignee, setFA, filterType, setFT, users }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search issues…"
        style={{ ...inputStyle, width: 200, padding: "6px 10px", fontSize: 13 }} />
      <select value={filterType} onChange={e => setFT(e.target.value)} style={{ ...inputStyle, width: "auto", padding: "6px 10px", fontSize: 13 }}>
        <option value="">All types</option>
        {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <select value={filterAssignee} onChange={e => setFA(e.target.value)} style={{ ...inputStyle, width: "auto", padding: "6px 10px", fontSize: 13 }}>
        <option value="">All assignees</option>
        <option value="__unassigned">Unassigned</option>
        {users.map(u => <option key={u.id} value={u.email}>{u.name}</option>)}
      </select>
    </div>
  );
}

function IssueCard({ issue, users, isDragging, onDragStart, onDragEnd, onClick }) {
  const type = TYPE_BY_ID[issue.type] || TYPES[0];
  const prio = PRIO_BY_ID[issue.priority] || PRIORITIES[2];
  const assignee = users.find(u => u.email === issue.assignee);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`jr-card ${isDragging ? "dragging" : ""}`}
      style={{
        background: C.bg, borderRadius: 3, padding: "10px 12px", border: `1px solid ${C.border}`,
        boxShadow: "0 1px 1px rgba(9,30,66,0.08)", cursor: "pointer", userSelect: "none",
      }}>
      <div style={{ fontSize: 14, color: C.text, marginBottom: 8, lineHeight: 1.35 }}>{issue.title}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span title={type.label} style={{ width: 16, height: 16, borderRadius: 3, background: type.color, color: "#fff", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
            {type.icon}
          </span>
          <span title={`${prio.label} priority`} style={{ color: prio.color, fontSize: 13, fontWeight: 700 }}>{prio.icon}</span>
          <span style={{ fontSize: 12, color: C.text3, fontFamily: F.mono }}>{issue.key}</span>
        </div>
        {assignee
          ? <Avatar email={assignee.email} name={assignee.name} size={22} />
          : <span style={{ width: 22, height: 22, borderRadius: "50%", border: `1px dashed ${C.borderDk}`, display: "inline-block" }} />
        }
      </div>
    </div>
  );
}

// ─── Backlog (list view) ─────────────────────────────────────────────────────
function Backlog({ project, issues, users, onOpen, onMove }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return issues
      .filter(i => !search || [i.title, i.key].some(v => (v || "").toLowerCase().includes(q)))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [issues, search]);

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: C.text, margin: 0 }}>{project.name} backlog</h1>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          style={{ ...inputStyle, width: 240, padding: "6px 10px", fontSize: 13 }} />
      </div>

      <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 130px 120px 36px 100px", gap: 10, padding: "8px 14px", background: C.bg3, borderBottom: `1px solid ${C.border}`, fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: 0.4 }}>
          <span>Type</span><span>Key</span><span>Summary</span><span>Status</span><span>Priority</span><span></span><span>Updated</span>
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: C.text3, fontSize: 13 }}>No issues yet. Create one from the top bar.</div>
        ) : filtered.map(issue => {
          const type = TYPE_BY_ID[issue.type] || TYPES[0];
          const prio = PRIO_BY_ID[issue.priority] || PRIORITIES[2];
          const assignee = users.find(u => u.email === issue.assignee);
          const st = STATUS_BY_ID[issue.status] || STATUSES[0];
          return (
            <div key={issue.id} className="jr-row" onClick={() => onOpen(issue)}
              style={{ display: "grid", gridTemplateColumns: "32px 100px 1fr 130px 120px 36px 100px", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${C.border}`, cursor: "pointer", alignItems: "center", fontSize: 13 }}>
              <span title={type.label} style={{ width: 18, height: 18, borderRadius: 3, background: type.color, color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{type.icon}</span>
              <span style={{ fontFamily: F.mono, color: C.text3, fontSize: 12 }}>{issue.key}</span>
              <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</span>
              <span onClick={e => e.stopPropagation()}>
                <select value={issue.status} onChange={e => onMove(issue.id, e.target.value)}
                  style={{ padding: "3px 6px", fontSize: 11, fontWeight: 600, border: "none", borderRadius: 3, background: st.bg, color: st.color, cursor: "pointer" }}>
                  {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label.toUpperCase()}</option>)}
                </select>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, color: prio.color, fontSize: 12 }}>
                <span style={{ fontWeight: 700 }}>{prio.icon}</span>{prio.label}
              </span>
              <span>
                {assignee
                  ? <Avatar email={assignee.email} name={assignee.name} size={22} />
                  : <span style={{ width: 22, height: 22, borderRadius: "50%", border: `1px dashed ${C.borderDk}`, display: "inline-block" }} />
                }
              </span>
              <span style={{ fontSize: 11, color: C.text3 }}>{relativeTime(issue.updatedAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Issue detail (slide-over) ───────────────────────────────────────────────
function IssueDetail({ issue, project, users, session, onClose, onEdit, onDelete, onMove, onComment }) {
  const [comment, setComment] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const type = TYPE_BY_ID[issue.type] || TYPES[0];
  const prio = PRIO_BY_ID[issue.priority] || PRIORITIES[2];
  const st   = STATUS_BY_ID[issue.status] || STATUSES[0];
  const assignee = users.find(u => u.email === issue.assignee);
  const reporter = users.find(u => u.email === issue.reporter);
  const canEdit  = session.role === "admin" || issue.reporter === session.email;

  const send = () => {
    const t = comment.trim();
    if (!t) return;
    onComment(t); setComment("");
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(9,30,66,0.4)", zIndex: 100 }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(720px, 95vw)", background: C.bg, zIndex: 101, boxShadow: "-8px 0 24px rgba(9,30,66,0.2)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text3 }}>
            <span title={type.label} style={{ width: 18, height: 18, borderRadius: 3, background: type.color, color: "#fff", fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{type.icon}</span>
            <span style={{ fontFamily: F.mono }}>{project?.key} / {issue.key}</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {canEdit && <button onClick={onEdit} className="jr-btn-ghost" style={btnGhost}>Edit</button>}
            {canEdit && (confirmDel
              ? <button onClick={onDelete} style={{ ...btnGhost, background: C.dangerBg, color: C.danger, borderColor: "#FFBDAD" }}>Confirm delete?</button>
              : <button onClick={() => setConfirmDel(true)} className="jr-btn-ghost" style={{ ...btnGhost, color: C.danger }}>Delete</button>
            )}
            <button onClick={onClose} className="jr-btn-ghost" style={btnGhost}>✕</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "grid", gridTemplateColumns: "1fr 220px", gap: 24 }}>
          <div>
            <h2 style={{ fontSize: 22, fontWeight: 500, color: C.text, margin: "0 0 18px" }}>{issue.title}</h2>

            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>Description</div>
              <div style={{ fontSize: 14, color: issue.description ? C.text : C.text3, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                {issue.description || "No description provided."}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.4 }}>
                Activity ({(issue.comments || []).length})
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                <Avatar email={session.email} name={session.name} size={32} />
                <div style={{ flex: 1 }}>
                  <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment…"
                    rows={2} style={{ ...inputStyle, marginBottom: 6, resize: "vertical" }} />
                  {comment.trim() && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={send} className="jr-btn-primary" style={{ padding: "6px 14px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>Save</button>
                      <button onClick={() => setComment("")} className="jr-btn-ghost" style={btnGhost}>Cancel</button>
                    </div>
                  )}
                </div>
              </div>
              {(issue.comments || []).slice().reverse().map(c => {
                const u = users.find(x => x.email === c.author);
                return (
                  <div key={c.id} style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                    <Avatar email={c.author} name={u?.name || c.author} size={32} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, marginBottom: 2 }}>
                        <strong style={{ color: C.text }}>{u?.name || c.author}</strong>
                        <span style={{ color: C.text3, marginLeft: 8, fontSize: 12 }}>{relativeTime(c.at)}</span>
                      </div>
                      <div style={{ fontSize: 13, color: C.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{c.body}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <aside style={{ borderLeft: `1px solid ${C.border}`, paddingLeft: 18 }}>
            <div style={{ marginBottom: 14 }}>
              <DetailLabel>Status</DetailLabel>
              <select value={issue.status} onChange={e => onMove(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", fontSize: 12, fontWeight: 600, background: st.bg, color: st.color, border: "none", borderRadius: 3, cursor: "pointer" }}>
                {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label.toUpperCase()}</option>)}
              </select>
            </div>
            <DetailRow label="Assignee" value={
              assignee
                ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Avatar email={assignee.email} name={assignee.name} size={24} /> {assignee.name}</span>
                : <span style={{ color: C.text3 }}>Unassigned</span>
            } />
            <DetailRow label="Reporter" value={
              reporter
                ? <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Avatar email={reporter.email} name={reporter.name} size={24} /> {reporter.name}</span>
                : <span style={{ color: C.text3 }}>{issue.reporter}</span>
            } />
            <DetailRow label="Priority" value={<span style={{ color: prio.color, fontWeight: 600 }}>{prio.icon} {prio.label}</span>} />
            <DetailRow label="Type" value={<span style={{ color: type.color, fontWeight: 600 }}>{type.icon} {type.label}</span>} />
            {issue.dueDate && <DetailRow label="Due date" value={new Date(issue.dueDate).toLocaleDateString()} />}
            {issue.labels?.length > 0 && (
              <DetailRow label="Labels" value={
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {issue.labels.map(l => <span key={l} style={{ background: C.bg2, color: C.text2, fontSize: 11, padding: "2px 7px", borderRadius: 3 }}>{l}</span>)}
                </div>
              } />
            )}
            <div style={{ marginTop: 18, fontSize: 11, color: C.text3, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
              <div>Created {relativeTime(issue.createdAt)}</div>
              <div>Updated {relativeTime(issue.updatedAt)}</div>
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function DetailLabel({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 }}>{children}</div>;
}
function DetailRow({ label, value }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <DetailLabel>{label}</DetailLabel>
      <div style={{ fontSize: 13, color: C.text }}>{value}</div>
    </div>
  );
}

// ─── Issue create / edit modal ──────────────────────────────────────────────
function IssueModal({ issue, project, users, onSave, onClose }) {
  const isEdit = !!issue.id;
  const [form, setForm] = useState({
    id:          issue.id || null,
    projectId:   issue.projectId,
    title:       issue.title || "",
    description: issue.description || "",
    type:        issue.type || "task",
    priority:    issue.priority || "medium",
    status:      issue.status || "todo",
    assignee:    issue.assignee || "",
    dueDate:     issue.dueDate || "",
    labels:      issue.labels || [],
  });
  const [labelInput, setLabelInput] = useState("");
  const [err, setErr] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.title.trim()) return setErr("Summary is required");
    onSave({ ...form, title: form.title.trim(), description: form.description.trim() });
  };

  const addLabel = () => {
    const t = labelInput.trim();
    if (!t || form.labels.includes(t)) return;
    set("labels", [...form.labels, t]);
    setLabelInput("");
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(9,30,66,0.5)", zIndex: 200 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 201, width: "min(620px, 95vw)", maxHeight: "90vh", background: C.bg, borderRadius: 6, boxShadow: "0 8px 32px rgba(9,30,66,0.32)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>
            {isEdit ? `Edit ${issue.key || "issue"}` : `Create issue in ${project.name}`}
          </div>
          <button onClick={onClose} className="jr-btn-ghost" style={btnGhost}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Issue type *">
              <select value={form.type} onChange={e => set("type", e.target.value)} style={inputStyle}>
                {TYPES.map(t => <option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select value={form.status} onChange={e => set("status", e.target.value)} style={inputStyle}>
                {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Summary *">
            <input value={form.title} onChange={e => set("title", e.target.value)} placeholder="What needs to be done?" style={inputStyle} autoFocus />
          </Field>

          <Field label="Description">
            <textarea value={form.description} onChange={e => set("description", e.target.value)} rows={4}
              placeholder="Add more details, acceptance criteria, links…" style={{ ...inputStyle, resize: "vertical" }} />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Assignee">
              <select value={form.assignee} onChange={e => set("assignee", e.target.value)} style={inputStyle}>
                <option value="">Unassigned</option>
                {users.map(u => <option key={u.id} value={u.email}>{u.name}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={e => set("priority", e.target.value)} style={inputStyle}>
                {PRIORITIES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Due date">
            <input type="date" value={form.dueDate} onChange={e => set("dueDate", e.target.value)} style={inputStyle} />
          </Field>

          <Field label="Labels">
            <div style={{ display: "flex", gap: 6, marginBottom: form.labels.length ? 8 : 0 }}>
              <input value={labelInput} onChange={e => setLabelInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addLabel(); } }}
                placeholder="Add label and press Enter" style={inputStyle} />
              <button type="button" onClick={addLabel} className="jr-btn-ghost" style={btnGhost}>Add</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {form.labels.map(l => (
                <span key={l} style={{ background: C.bg2, color: C.text2, fontSize: 12, padding: "3px 8px", borderRadius: 3, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {l}
                  <button onClick={() => set("labels", form.labels.filter(x => x !== l))}
                    style={{ background: "transparent", border: "none", cursor: "pointer", color: C.text3, fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              ))}
            </div>
          </Field>

          {err && <div style={{ fontSize: 13, color: C.danger, background: C.dangerBg, padding: "8px 12px", borderRadius: 3, marginTop: 8 }}>{err}</div>}
        </div>

        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} className="jr-btn-ghost" style={btnGhost}>Cancel</button>
          <button onClick={submit} className="jr-btn-primary"
            style={{ padding: "8px 18px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            {isEdit ? "Save changes" : "Create"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Project create modal ───────────────────────────────────────────────────
function ProjectModal({ onClose, onCreate, existing }) {
  const [name, setName] = useState("");
  const [key, setKey]   = useState("");
  const [err, setErr]   = useState("");
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) {
      const auto = name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase();
      setKey(auto);
    }
  }, [name]);

  const submit = () => {
    if (!name.trim()) return setErr("Name is required");
    if (!/^[A-Z]{2,6}$/.test(key)) return setErr("Key must be 2-6 uppercase letters");
    if (existing.find(p => p.key === key)) return setErr("Key already in use");
    onCreate({ name: name.trim(), key });
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(9,30,66,0.5)", zIndex: 200 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 201, width: "min(440px, 95vw)", background: C.bg, borderRadius: 6, padding: 24, boxShadow: "0 8px 32px rgba(9,30,66,0.32)" }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 16 }}>Create project</div>
        <Field label="Project name *">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Mobile App Redesign" style={inputStyle} />
        </Field>
        <Field label="Key *">
          <input value={key} onChange={e => { touched.current = true; setKey(e.target.value.toUpperCase()); }}
            placeholder="MAR" style={{ ...inputStyle, fontFamily: F.mono, textTransform: "uppercase" }} />
          <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Used as prefix for issue IDs (e.g. {key || "KEY"}-1)</div>
        </Field>
        {err && <div style={{ fontSize: 13, color: C.danger, background: C.dangerBg, padding: "8px 12px", borderRadius: 3, marginBottom: 8 }}>{err}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <button onClick={onClose} className="jr-btn-ghost" style={btnGhost}>Cancel</button>
          <button onClick={submit} className="jr-btn-primary"
            style={{ padding: "8px 18px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            Create
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyProjects({ onNew }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div style={{ width: 56, height: 56, borderRadius: 8, background: C.primaryLt, color: C.primary, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 24, fontWeight: 700 }}>▦</div>
        <h2 style={{ fontSize: 18, color: C.text, margin: "0 0 6px" }}>Welcome to Jiraly</h2>
        <p style={{ fontSize: 13, color: C.text3, marginBottom: 18, lineHeight: 1.5 }}>
          Create your first project to start tracking issues, organize work in a kanban board, and ship together.
        </p>
        <button onClick={onNew} className="jr-btn-primary"
          style={{ padding: "9px 20px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
          + Create project
        </button>
      </div>
    </div>
  );
}

// ─── Shared primitives ──────────────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "8px 10px", background: C.bg,
  border: `1px solid ${C.borderDk}`, borderRadius: 3,
  color: C.text, fontSize: 14,
};
const btnGhost = {
  padding: "7px 12px", background: "transparent", border: `1px solid ${C.border}`,
  borderRadius: 3, color: C.text2, fontSize: 13, cursor: "pointer",
};

function Logo({ size = 32, light = false }) {
  return (
    <div style={{ width: size, height: size, background: light ? "rgba(255,255,255,0.18)" : C.primary, borderRadius: Math.round(size * 0.2), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 16 16" fill="none">
        <path d="M8 1L3 4v5c0 3 2.5 5 5 6 2.5-1 5-3 5-6V4L8 1z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M6 8l1.5 1.5L10 7" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </div>
  );
}

function Avatar({ email, name, size = 28 }) {
  const initials = (name || email || "?").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase()).join("");
  return (
    <span title={name || email}
      style={{ width: size, height: size, borderRadius: "50%", background: stringColor(email || name || "?"), color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.4), fontWeight: 600, flexShrink: 0 }}>
      {initials}
    </span>
  );
}

function stringColor(s) {
  const palette = ["#0052CC","#00875A","#5243AA","#DE350B","#FF8B00","#0747A6","#008DA6","#403294","#974F0C"];
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function relativeTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

// ─── Meetings view ───────────────────────────────────────────────────────────
function Meetings({ meetings, users, session, onNew, onEdit, onDelete, onCopy, onSend }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("upcoming"); // upcoming | past | all
  const [confirmId, setConfirmId] = useState(null);

  const sorted = useMemo(() => {
    const nowDate = new Date();
    const q = search.toLowerCase();
    return meetings
      .filter(m => !search || [m.title, m.description, m.host].some(v => (v || "").toLowerCase().includes(q)))
      .filter(m => {
        if (filter === "all") return true;
        const dt = new Date(`${m.date}T${m.time || "00:00"}`);
        return filter === "upcoming" ? dt >= nowDate : dt < nowDate;
      })
      .sort((a, b) => new Date(`${a.date}T${a.time || "00:00"}`) - new Date(`${b.date}T${b.time || "00:00"}`));
  }, [meetings, search, filter]);

  const upcomingCount = meetings.filter(m => new Date(`${m.date}T${m.time || "00:00"}`) >= new Date()).length;

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: C.text, margin: 0 }}>Meetings</h1>
          <p style={{ fontSize: 13, color: C.text3, margin: "4px 0 0" }}>{upcomingCount} upcoming · {meetings.length} total</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3, padding: 2 }}>
            {[["upcoming", "Upcoming"], ["past", "Past"], ["all", "All"]].map(([id, label]) => (
              <button key={id} onClick={() => setFilter(id)}
                style={{ padding: "5px 12px", border: "none", borderRadius: 2, fontSize: 12, fontWeight: 500, cursor: "pointer",
                  background: filter === id ? C.primaryLt : "transparent",
                  color: filter === id ? C.primary : C.text2 }}>
                {label}
              </button>
            ))}
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            style={{ ...inputStyle, width: 220, padding: "6px 10px", fontSize: 13 }} />
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 6, padding: 48, textAlign: "center", marginTop: 18 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>📅</div>
          <div style={{ fontSize: 15, color: C.text, fontWeight: 500, marginBottom: 4 }}>No meetings {filter !== "all" ? filter : "yet"}</div>
          <div style={{ fontSize: 13, color: C.text3, marginBottom: 16 }}>Schedule a meeting and a join link will be generated automatically.</div>
          <button onClick={onNew} className="jr-btn-primary"
            style={{ padding: "8px 16px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            + Schedule meeting
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {sorted.map(m => {
            const dt = new Date(`${m.date}T${m.time || "00:00"}`);
            const isPast  = dt < new Date();
            const isToday = m.date === new Date().toISOString().slice(0, 10);
            const accent  = isToday ? "#FF8B00" : isPast ? C.borderDk : C.primary;
            const provider = PROVIDER_BY_ID[m.provider] || MEETING_PROVIDERS[0];
            const canEdit = session.role === "admin" || m.createdBy === session.email;
            return (
              <div key={m.id} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4, borderLeft: `3px solid ${accent}`, padding: "14px 16px" }}>
                <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{m.title}</span>
                      {isToday && <span style={{ fontSize: 10, background: "#FFF0B3", color: "#974F0C", padding: "2px 7px", borderRadius: 3, fontWeight: 600 }}>TODAY</span>}
                      {isPast && <span style={{ fontSize: 10, background: C.bg2, color: C.text3, padding: "2px 7px", borderRadius: 3, fontWeight: 600 }}>PAST</span>}
                      <span style={{ fontSize: 10, background: C.primaryLt, color: C.primary, padding: "2px 7px", borderRadius: 3, fontWeight: 600 }}>{provider.label.toUpperCase()}</span>
                    </div>
                    <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.text2, flexWrap: "wrap", marginBottom: m.description ? 6 : 8 }}>
                      <span style={{ fontFamily: F.mono }}>
                        {dt.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                        {m.time && ` · ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                        {m.duration ? ` · ${m.duration}m` : ""}
                      </span>
                      <span>Host: {m.host}</span>
                      {m.attendees?.length > 0 && <span>{m.attendees.length} attendee{m.attendees.length !== 1 ? "s" : ""}</span>}
                    </div>
                    {m.description && <div style={{ fontSize: 13, color: C.text2, lineHeight: 1.5, marginBottom: 8, whiteSpace: "pre-wrap" }}>{m.description}</div>}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.text3, fontFamily: F.mono, background: C.bg3, border: `1px solid ${C.border}`, padding: "6px 10px", borderRadius: 3, wordBreak: "break-all" }}>
                      🔗 {m.meetingUrl}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer"
                      style={{ padding: "7px 14px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 12, fontWeight: 500, textDecoration: "none" }}>
                      Join ↗
                    </a>
                    <button onClick={() => onCopy(m.meetingUrl)} className="jr-btn-ghost" style={btnGhost}>Copy link</button>
                    {(m.attendees || []).filter(isEmail).length > 0 && (
                      <button onClick={() => onSend(m)} className="jr-btn-ghost"
                        style={{ ...btnGhost, background: C.primaryLt, color: C.primary, borderColor: "#B3D4FF" }}
                        title={`Send invite via mail server to ${(m.attendees || []).filter(isEmail).length} attendee(s)`}>
                        ✉ Send invite
                      </button>
                    )}
                    <a href={buildMailtoInvite(m, session.name)} className="jr-btn-ghost" style={{ ...btnGhost, textDecoration: "none", display: "inline-block" }}
                       title="Open in your local email client (fallback)">
                      ✉ Mailto
                    </a>
                    <button onClick={() => downloadIcs(m)} className="jr-btn-ghost" style={btnGhost} title="Download .ics calendar file">
                      📆 Add to calendar
                    </button>
                    {canEdit && <button onClick={() => onEdit(m)} className="jr-btn-ghost" style={btnGhost}>Edit</button>}
                    {canEdit && (confirmId === m.id
                      ? <button onClick={() => { onDelete(m.id); setConfirmId(null); }}
                          style={{ ...btnGhost, background: C.dangerBg, color: C.danger, borderColor: "#FFBDAD" }}>Confirm?</button>
                      : <button onClick={() => setConfirmId(m.id)} className="jr-btn-ghost" style={{ ...btnGhost, color: C.danger }}>Delete</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── MeetingModal (create / edit, auto-generates link) ───────────────────────
function MeetingModal({ meeting, users, session, onSave, onClose }) {
  const isEdit = !!meeting.id;
  const [form, setForm] = useState({
    id:          meeting.id || null,
    title:       meeting.title || "",
    description: meeting.description || "",
    date:        meeting.date || addDays(0),
    time:        meeting.time || "10:00",
    duration:    meeting.duration || 30,
    host:        meeting.host || session.name,
    provider:    meeting.provider || "jitsi",
    meetingUrl:  meeting.meetingUrl || "",
    attendees:   meeting.attendees || [],
    autoLink:    meeting.id ? false : true,
  });
  const [attInput, setAttInput] = useState("");
  const [err, setErr] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const previewLink = useMemo(() => {
    if (!form.autoLink) return form.meetingUrl;
    return generateMeetingLink(form.provider, form.title || "team-meeting");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.provider, form.title, form.autoLink]);

  const submit = () => {
    if (!form.title.trim()) return setErr("Title is required");
    if (!form.date) return setErr("Date is required");
    if (!form.autoLink && !/^https?:\/\/.+/.test(form.meetingUrl.trim()))
      return setErr("Provide a valid meeting URL or enable auto-generated link");
    // Pull in any email still typed in the input box but not yet "added".
    const pending = attInput.trim();
    const finalAttendees = pending && !form.attendees.includes(pending)
      ? [...form.attendees, pending]
      : form.attendees;
    const payload = {
      ...form,
      title: form.title.trim(),
      description: form.description.trim(),
      attendees: finalAttendees,
    };
    if (form.autoLink) payload.meetingUrl = previewLink;
    onSave(payload);
  };

  const addAttendee = (raw) => {
    const v = (typeof raw === "string" ? raw : attInput).trim();
    if (!v) return false;
    if (form.attendees.includes(v)) { setAttInput(""); return true; }
    set("attendees", [...form.attendees, v]);
    setAttInput("");
    return true;
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(9,30,66,0.5)", zIndex: 200 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 201, width: "min(620px, 95vw)", maxHeight: "92vh", background: C.bg, borderRadius: 6, boxShadow: "0 8px 32px rgba(9,30,66,0.32)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>
            {isEdit ? "Edit meeting" : "Schedule meeting"}
          </div>
          <button onClick={onClose} className="jr-btn-ghost" style={btnGhost}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <Field label="Title *">
            <input autoFocus value={form.title} onChange={e => set("title", e.target.value)}
              placeholder="Sprint planning, design review…" style={inputStyle} />
          </Field>

          <Field label="Description">
            <textarea value={form.description} onChange={e => set("description", e.target.value)} rows={3}
              placeholder="Agenda, links, context…" style={{ ...inputStyle, resize: "vertical" }} />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Date *">
              <input type="date" value={form.date} onChange={e => set("date", e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Time">
              <input type="time" value={form.time} onChange={e => set("time", e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Duration (min)">
              <input type="number" min="5" step="5" value={form.duration}
                onChange={e => set("duration", parseInt(e.target.value) || 30)} style={inputStyle} />
            </Field>
          </div>

          <Field label="Host">
            <input value={form.host} onChange={e => set("host", e.target.value)} style={inputStyle} />
          </Field>

          <Field label="Meeting provider">
            <select value={form.provider} onChange={e => set("provider", e.target.value)} style={inputStyle}>
              {MEETING_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Field>

          <div style={{ background: C.bg3, border: `1px solid ${C.border}`, borderRadius: 4, padding: 12, marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text, cursor: "pointer", marginBottom: form.autoLink ? 8 : 8 }}>
              <input type="checkbox" checked={form.autoLink} onChange={e => set("autoLink", e.target.checked)} />
              <span style={{ fontWeight: 500 }}>Auto-generate meeting link</span>
            </label>
            {form.autoLink ? (
              <div style={{ fontSize: 12, color: C.text3, fontFamily: F.mono, background: C.bg, border: `1px solid ${C.border}`, padding: "8px 10px", borderRadius: 3, wordBreak: "break-all" }}>
                🔗 {previewLink}
              </div>
            ) : (
              <input value={form.meetingUrl} onChange={e => set("meetingUrl", e.target.value)}
                placeholder="https://zoom.us/j/... or https://meet.google.com/..."
                style={{ ...inputStyle, fontFamily: F.mono, fontSize: 13 }} />
            )}
          </div>

          <Field label="Attendees">
            <div style={{ display: "flex", gap: 6, marginBottom: form.attendees.length ? 8 : 0 }}>
              <input value={attInput} onChange={e => setAttInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addAttendee(); } }}
                onBlur={() => addAttendee()}
                placeholder="email@example.com — press Enter to add" type="email" style={inputStyle} list="att-suggest" />
              <datalist id="att-suggest">
                {users.map(u => <option key={u.id} value={u.email}>{u.name}</option>)}
              </datalist>
              <button type="button" onClick={addAttendee} className="jr-btn-ghost" style={btnGhost}>Add</button>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {form.attendees.map(a => {
                const valid = isEmail(a);
                return (
                  <span key={a} title={valid ? "" : "Not a valid email — won't receive invite"}
                    style={{ background: valid ? C.primaryLt : "#FFF0B3", color: valid ? C.primaryDk : "#974F0C",
                      fontSize: 12, padding: "3px 8px", borderRadius: 3, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {valid ? "✉" : "⚠"} {a}
                    <button onClick={() => set("attendees", form.attendees.filter(x => x !== a))}
                      style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                );
              })}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: C.text3, lineHeight: 1.5 }}>
              On save, an invitation email is sent automatically from the configured mail server to every valid attendee — with the join link and a calendar attachment.
            </div>
          </Field>

          {err && <div style={{ fontSize: 13, color: C.danger, background: C.dangerBg, padding: "8px 12px", borderRadius: 3, marginTop: 4 }}>{err}</div>}
        </div>

        <div style={{ padding: "12px 24px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} className="jr-btn-ghost" style={btnGhost}>Cancel</button>
          <button onClick={submit} className="jr-btn-primary"
            style={{ padding: "8px 18px", background: C.primary, border: "none", borderRadius: 3, color: "#fff", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
            {isEdit ? "Save changes" : "Schedule & generate link"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Seed sample data (first-run demo content) ───────────────────────────────
function buildSeedData() {
  const p1 = { id: uid(), name: "Mobile App Redesign", key: "MAR", createdBy: "demo@jiraly.app", createdAt: now() };
  const p2 = { id: uid(), name: "Marketing Website",   key: "WEB", createdBy: "demo@jiraly.app", createdAt: now() };

  const mk = (proj, idx, over) => ({
    id: uid(), projectId: proj.id, key: `${proj.key}-${idx}`,
    type: "task", priority: "medium", status: "todo",
    title: "", description: "", assignee: "", reporter: "demo@jiraly.app",
    dueDate: "", labels: [], comments: [],
    createdAt: now(), updatedAt: now(),
    ...over,
  });

  const issues = [
    mk(p1, 1, { title: "Design new onboarding flow",         type: "story", status: "in_progress", priority: "high",    labels: ["onboarding","ux"] }),
    mk(p1, 2, { title: "Crash on iOS 17 when opening chat",  type: "bug",   status: "todo",        priority: "highest", labels: ["ios","crash"] }),
    mk(p1, 3, { title: "Migrate auth to OAuth 2.1",          type: "epic",  status: "in_review",   priority: "high",    labels: ["auth","backend"] }),
    mk(p1, 4, { title: "Add dark-mode toggle in settings",   type: "task",  status: "todo",        priority: "low",     labels: ["ui"] }),
    mk(p1, 5, { title: "Push notification opt-in screen",    type: "story", status: "done",        priority: "medium",  labels: ["notifications"] }),
    mk(p1, 6, { title: "Refactor profile screen state",      type: "task",  status: "in_progress", priority: "medium",  labels: ["refactor"] }),
    mk(p2, 1, { title: "Launch pricing page A/B test",       type: "task",  status: "in_progress", priority: "high",    labels: ["growth"] }),
    mk(p2, 2, { title: "Fix broken footer links",            type: "bug",   status: "todo",        priority: "low",     labels: ["bugfix"] }),
    mk(p2, 3, { title: "SEO meta-tag audit",                 type: "task",  status: "in_review",   priority: "medium",  labels: ["seo"] }),
    mk(p2, 4, { title: "Customer story: Acme Inc.",          type: "story", status: "done",        priority: "medium",  labels: ["content"] }),
  ];

  const meetings = [
    {
      id: uid(), title: "Weekly Sprint Planning",
      description: "Review last sprint, commit to next sprint goals.",
      date: addDays(1), time: "10:00", duration: 60, host: "Demo Admin",
      provider: "jitsi", meetingUrl: generateMeetingLink("jitsi", "sprint-planning"),
      attendees: ["alex@jiraly.app", "sam@jiraly.app"],
      createdBy: "demo@jiraly.app", createdAt: now(), updatedAt: now(),
    },
    {
      id: uid(), title: "Design Review — Onboarding",
      description: "Walk through new onboarding flow Figma prototype.",
      date: addDays(3), time: "14:30", duration: 45, host: "Demo Admin",
      provider: "gmeet", meetingUrl: generateMeetingLink("gmeet", "design-review"),
      attendees: [],
      createdBy: "demo@jiraly.app", createdAt: now(), updatedAt: now(),
    },
    {
      id: uid(), title: "Engineering Sync",
      description: "Cross-team technical sync.",
      date: addDays(0), time: "16:00", duration: 30, host: "Demo Admin",
      provider: "zoom", meetingUrl: generateMeetingLink("zoom", "eng-sync"),
      attendees: [],
      createdBy: "demo@jiraly.app", createdAt: now(), updatedAt: now(),
    },
  ];

  return { projects: [p1, p2], issues, meetings };
}
