import { useState, useEffect, useMemo, useRef } from "react";

// ─── Storage (localStorage with safe fallback) ────────────────────────────
const safeStorage = (() => {
  try {
    const k = "__jr_test__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
})();
const db = {
  async get(key) {
    try { const v = safeStorage.getItem(key); return v ? JSON.parse(v) : null; }
    catch { return null; }
  },
  async set(key, val) {
    try {
      if (val === null || val === undefined) safeStorage.removeItem(key);
      else safeStorage.setItem(key, JSON.stringify(val));
    } catch {}
  },
};
const KEYS = {
  USERS:    "jr:users",
  SESSION:  "jr:session",
  TOKEN:    "jr:token",
  PROJECTS: "jr:projects",
  ISSUES:   "jr:issues",
  ACTIVE:   "jr:active",
  MEETINGS: "jr:meetings",
  SEEDED:   "jr:seeded",
};

// ─── REST API client ──────────────────────────────────────────────────────
// Talks to the Flask backend at /api/*. Stores the auth token in localStorage.
// All methods throw on non-OK responses so callers can show errors.
const api = (() => {
  let token = safeStorage.getItem(KEYS.TOKEN) || null;
  const setToken = (t) => {
    token = t;
    if (t) safeStorage.setItem(KEYS.TOKEN, t);
    else   safeStorage.removeItem(KEYS.TOKEN);
  };
  const headers = () => ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });
  const call = async (path, opts = {}) => {
    const res = await fetch(`/api${path}`, { headers: headers(), ...opts });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
  return {
    getToken: () => token, setToken,
    health: () => call("/health"),
    me: () => call("/me"),
    sendOtp: (payload) => call("/send-otp", { method: "POST", body: JSON.stringify(payload) }),
    signup: (payload) => call("/auth/signup", { method: "POST", body: JSON.stringify(payload) }),
    signin: (payload) => call("/auth/signin", { method: "POST", body: JSON.stringify(payload) }),
    google: (credential) => call("/auth/google", { method: "POST", body: JSON.stringify({ credential }) }),
    forgot: (payload) => call("/auth/forgot", { method: "POST", body: JSON.stringify(payload) }),
    reset:  (payload) => call("/auth/reset",  { method: "POST", body: JSON.stringify(payload) }),
    signout: () => call("/auth/signout", { method: "POST" }),
    listUsers:    () => call("/users"),
    listProjects: () => call("/projects"),
    createProject: (p) => call("/projects", { method: "POST", body: JSON.stringify(p) }),
    deleteProject: (id) => call(`/projects/${id}`, { method: "DELETE" }),
    listIssues:   (projectId) => call(`/issues${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
    createIssue:  (i) => call("/issues", { method: "POST", body: JSON.stringify(i) }),
    updateIssue:  (id, patch) => call(`/issues/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteIssue:  (id) => call(`/issues/${id}`, { method: "DELETE" }),
    addComment:   (id, body) => call(`/issues/${id}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
    listMeetings: () => call("/meetings"),
    createMeeting: (m) => call("/meetings", { method: "POST", body: JSON.stringify(m) }),
    updateMeeting: (id, patch) => call(`/meetings/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteMeeting: (id) => call(`/meetings/${id}`, { method: "DELETE" }),
    dashboard: () => call("/dashboard"),
    notifications: () => call("/notifications"),
    sendInvite: (m) => call("/send-invite", { method: "POST", body: JSON.stringify(m) }),
  };
})();

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
// Uses the shared `api` client so the request carries the auth token and
// flows through Vite's /api proxy to the Flask backend on :5179.
async function sendInviteEmails(meeting) {
  const providerLabel = (PROVIDER_BY_ID[meeting.provider] || MEETING_PROVIDERS[0]).label;
  return api.sendInvite({ ...meeting, providerLabel });
}
async function checkMailServer() {
  try { return { reachable: true, ...(await api.health()) }; }
  catch { return { reachable: false }; }
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
  const [view, setView]         = useState("board"); // board | backlog | meetings | dash | recent | starred | apps
  const [openIssue, setOpenIssue] = useState(null);
  const [showProjModal, setShowProjModal] = useState(false);
  const [editingIssue, setEditingIssue] = useState(null);
  const [editingMeeting, setEditingMeeting] = useState(null);
  const [toast, setToast]       = useState(null);
  const [starred, setStarred]   = useState(() => {
    try { return new Set(JSON.parse(safeStorage.getItem("jr:starred") || "[]")); }
    catch { return new Set(); }
  });
  const [recents, setRecents]   = useState(() => {
    try { return JSON.parse(safeStorage.getItem("jr:recents") || "[]"); }
    catch { return []; }
  });

  const toggleStar = (projectId) => {
    setStarred(prev => {
      const next = new Set(prev);
      next.has(projectId) ? next.delete(projectId) : next.add(projectId);
      safeStorage.setItem("jr:starred", JSON.stringify([...next]));
      return next;
    });
  };
  const trackRecent = (projectId) => {
    setRecents(prev => {
      const next = [projectId, ...prev.filter(id => id !== projectId)].slice(0, 10);
      safeStorage.setItem("jr:recents", JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    (async () => {
      // Restore session from token (if any), then pull all data from the API.
      let me = null;
      if (api.getToken()) {
        try { me = (await api.me()).user; }
        catch { api.setToken(null); }
      }
      if (!me) { setReady(true); return; }

      try {
        const [u, p, i, m] = await Promise.all([
          api.listUsers(),
          api.listProjects(),
          api.listIssues(),
          api.listMeetings(),
        ]);
        setSession(me);
        setUsers(u.users || []);
        setProjects(p.projects || []);
        setIssues(i.issues || []);
        setMeetings(m.meetings || []);
        const savedActive = await db.get(KEYS.ACTIVE);
        setActiveId(savedActive || (p.projects?.[0]?.id ?? null));
      } catch (err) {
        console.warn("[Jiraly] initial load failed:", err.message);
      }
      setReady(true);
    })();
  }, []);

  const flash = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  };

  // After auth, hydrate the workspace from the server.
  const login = async ({ token, user }) => {
    api.setToken(token);
    setSession(user);
    try {
      const [u, p, i, m] = await Promise.all([
        api.listUsers(), api.listProjects(), api.listIssues(), api.listMeetings(),
      ]);
      setUsers(u.users || []);
      setProjects(p.projects || []);
      setIssues(i.issues || []);
      setMeetings(m.meetings || []);
      const savedActive = await db.get(KEYS.ACTIVE);
      setActiveId(savedActive || (p.projects?.[0]?.id ?? null));
    } catch (err) {
      flash(`Couldn't load workspace: ${err.message}`, "danger");
    }
  };

  const logout = async () => {
    try { await api.signout(); } catch {}
    api.setToken(null);
    setSession(null);
    setUsers([]); setProjects([]); setIssues([]); setMeetings([]);
    setActiveId(null);
  };

  const saveActive = async (id) => {
    setActiveId(id);
    await db.set(KEYS.ACTIVE, id);
    if (id) trackRecent(id);
  };

  const activeProject = projects.find(p => p.id === activeId);
  const projectIssues = useMemo(
    () => issues.filter(i => i.projectId === activeId),
    [issues, activeId]
  );

  const createProject = async ({ name, key }) => {
    try {
      const { project } = await api.createProject({ name, key });
      setProjects(ps => [...ps, project]);
      await saveActive(project.id);
      setShowProjModal(false);
      flash(`Project ${project.key} created`);
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  const saveIssue = async (data) => {
    try {
      if (data.id) {
        const { issue } = await api.updateIssue(data.id, data);
        setIssues(list => list.map(i => i.id === issue.id ? issue : i));
        if (openIssue?.id === issue.id) setOpenIssue(issue);
        flash("Issue updated");
      } else {
        const { issue } = await api.createIssue(data);
        setIssues(list => [...list, issue]);
        flash(`${issue.key} created`);
      }
      setEditingIssue(null);
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  const deleteIssue = async (id) => {
    try {
      await api.deleteIssue(id);
      setIssues(list => list.filter(i => i.id !== id));
      setOpenIssue(null);
      flash("Issue deleted", "danger");
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  const moveIssue = async (id, statusId) => {
    // Optimistic update for instant drag feedback.
    setIssues(list => list.map(i => i.id === id ? { ...i, status: statusId } : i));
    try {
      const { issue } = await api.updateIssue(id, { status: statusId });
      setIssues(list => list.map(i => i.id === issue.id ? issue : i));
      if (openIssue?.id === id) setOpenIssue(issue);
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  const addComment = async (issueId, body) => {
    try {
      const { issue } = await api.addComment(issueId, body);
      setIssues(list => list.map(i => i.id === issue.id ? issue : i));
      setOpenIssue(issue);
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  const saveMeeting = async (data) => {
    try {
      const link = data.meetingUrl?.trim() || generateMeetingLink(data.provider, data.title);
      const payload = { ...data, meetingUrl: link };
      let meeting;
      if (data.id) {
        meeting = (await api.updateMeeting(data.id, payload)).meeting;
        setMeetings(list => list.map(m => m.id === meeting.id ? meeting : m));
        flash("Meeting updated");
      } else {
        meeting = (await api.createMeeting(payload)).meeting;
        setMeetings(list => [...list, meeting]);
        flash("Meeting scheduled — link generated");
      }
      setEditingMeeting(null);

      const recipients = (meeting.attendees || []).filter(isEmail);
      if (!data.id && recipients.length > 0) {
        try {
          const r = await sendInviteEmails(meeting);
          flash(`✉ Invite sent to ${r.sentTo?.length ?? recipients.length} attendee(s)`);
        } catch (err) {
          flash(`Mail server unreachable — opening your email client instead`, "danger");
          setTimeout(() => { window.location.href = buildMailtoInvite(meeting, session.name); }, 400);
        }
      }
      return meeting;
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  const deleteMeeting = async (id) => {
    try {
      await api.deleteMeeting(id);
      setMeetings(list => list.filter(m => m.id !== id));
      flash("Meeting removed", "danger");
    } catch (err) {
      flash(err.message, "danger");
    }
  };

  if (!ready) return <Splash />;
  if (!session) return <AuthScreen onLogin={login} />;

  const onCreate = () => {
    if (view === "meetings") setEditingMeeting({});
    else if (activeProject) setEditingIssue({ projectId: activeProject.id });
    else setShowProjModal(true);
  };

  const openIssueById = (id) => {
    const i = issues.find(x => x.id === id);
    if (i) { setView("board"); setOpenIssue(i); }
  };

  return (
    <>
      <GlobalStyle />
      <div style={{ fontFamily: F.sans, color: C.text, minHeight: "100vh", display: "flex", flexDirection: "column", background: C.bg2 }}>
        <TopHeader
          session={session}
          onCreate={onCreate}
          onLogout={logout}
          onOpenIssue={openIssueById}
          onPickProject={saveActive}
          setView={setView}
        />

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <Sidebar
            projects={projects}
            activeId={activeId}
            onPick={saveActive}
            onNewProject={() => setShowProjModal(true)}
            view={view}
            setView={setView}
            starred={starred}
            onToggleStar={toggleStar}
          />

          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: C.bg }}>
            {!["dash", "recent", "starred", "apps"].includes(view) && (
              <ProjectHeader
                project={activeProject}
                view={view}
                setView={setView}
              />
            )}

            <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
            {view === "dash" ? (
              <Dashboard
                session={session}
                onPickProject={saveActive}
                onOpenIssue={openIssueById}
                setView={setView}
              />
            ) : view === "recent" ? (
              <RecentView
                projects={projects}
                issues={issues}
                recents={recents}
                onPickProject={(id) => { saveActive(id); setView("board"); }}
                onOpenIssue={openIssueById}
              />
            ) : view === "starred" ? (
              <StarredView
                projects={projects}
                starred={starred}
                onToggleStar={toggleStar}
                onPickProject={(id) => { saveActive(id); setView("board"); }}
              />
            ) : view === "apps" ? (
              <AppsView setView={setView} hasProject={!!activeProject} />
            ) : view === "meetings" ? (
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
          </div>
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
    .jr-btn-primary:hover:not(:disabled) { background: ${C.primaryDk} !important; }
    .jr-btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
    .jr-btn-ghost:hover { background: ${C.bg2} !important; }
    .jr-row:hover { background: ${C.bg3} !important; }
    .jr-sb-item:hover { background: ${C.bg2}; }
    .jr-sb-item.active { background: ${C.primaryLt} !important; color: ${C.primaryDk} !important; font-weight: 600; }
    .jr-sb-item {
      display: flex; width: 100%; align-items: center; gap: 10px;
      padding: 7px 10px; background: transparent; border: none;
      color: ${C.text2}; border-radius: 4px; cursor: pointer;
      text-align: left; margin-bottom: 1px; font-size: 13.5px; font-weight: 500;
    }
    /* Top header */
    .jr-icon-btn {
      width: 32px; height: 32px; display: inline-flex; align-items: center;
      justify-content: center; background: transparent; border: none;
      border-radius: 4px; cursor: pointer; color: ${C.text2}; padding: 0;
      position: relative;
    }
    .jr-icon-btn:hover { background: ${C.bg2}; color: ${C.text}; }
    .jr-dash-row {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 8px 4px; border: none; background: transparent;
      border-bottom: 1px solid ${C.border}; cursor: pointer; text-align: left;
      color: inherit; font: inherit;
    }
    .jr-dash-row:last-child { border-bottom: none; }
    .jr-dash-row:hover { background: ${C.bg2}; }
    .jr-icon-btn-sm {
      width: 22px; height: 22px; display: inline-flex; align-items: center;
      justify-content: center; background: transparent; border: none;
      border-radius: 3px; cursor: pointer; color: ${C.text2}; padding: 0;
      font-size: 16px; line-height: 1;
    }
    .jr-icon-btn-sm:hover { background: ${C.bg2}; color: ${C.text}; }
    .jr-search {
      flex: 1; max-width: 720px; display: flex; align-items: center; gap: 8px;
      background: ${C.bg2}; border: 1px solid transparent; border-radius: 4px;
      padding: 0 10px; height: 34px; color: ${C.text3};
      transition: background 0.12s, border-color 0.12s;
    }
    .jr-search:focus-within {
      background: ${C.bg}; border-color: ${C.primary};
      box-shadow: 0 0 0 1px ${C.primary};
    }
    .jr-search input {
      flex: 1; border: none; background: transparent; outline: none;
      font-size: 13.5px; color: ${C.text}; padding: 6px 0;
    }
    .jr-search input:focus { box-shadow: none !important; border: none !important; }
    .jr-menu-item {
      display: block; width: 100%; text-align: left;
      padding: 9px 14px; background: transparent; border: none;
      cursor: pointer; font-size: 13px; color: ${C.text};
    }
    .jr-menu-item:hover { background: ${C.bg2}; }
    /* Board */
    .jr-col-modern {
      background: ${C.bg2}; border-radius: 4px; padding: 6px;
      display: flex; flex-direction: column; min-height: 0;
      transition: background 0.12s;
    }
    .jr-col-modern.over { background: ${C.primaryLt}; }
    .jr-col-add {
      background: transparent; border: none; cursor: pointer; color: ${C.text3};
      font-size: 13px; padding: 10px 8px; text-align: left; border-radius: 3px;
      display: flex; align-items: center; gap: 6px; margin-top: 4px;
    }
    .jr-col-add:hover { background: rgba(9,30,66,0.08); color: ${C.text}; }
    .jr-count-pill {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; padding: 0 6px; border-radius: 9px;
      background: rgba(9,30,66,0.1); color: ${C.text2};
      font-size: 11px; font-weight: 600;
    }
    /* Mobile */
    @media (max-width: 768px) {
      .jr-sidebar { display: none; }
      .jr-search { max-width: none; }
    }

    /* ─── Auth screen ─── */
    .jr-auth-shell { display: grid; grid-template-columns: 1fr; min-height: 100vh; }
    .jr-auth-aside { display: none; }
    .jr-auth-main { display: flex; align-items: center; justify-content: center; padding: 32px 20px; }
    .jr-auth-card { width: 100%; max-width: 420px; }
    @media (min-width: 900px) {
      .jr-auth-shell { grid-template-columns: 1.05fr 1fr; }
      .jr-auth-aside {
        display: flex; flex-direction: column; justify-content: space-between;
        padding: 48px; color: #fff;
        background: linear-gradient(135deg, #0747A6 0%, #0052CC 55%, #2684FF 100%);
        position: relative; overflow: hidden;
      }
      .jr-auth-aside::after {
        content: ""; position: absolute; right: -120px; bottom: -120px;
        width: 380px; height: 380px; border-radius: 50%;
        background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.18), transparent 70%);
      }
    }
    .jr-link-btn {
      background: none; border: none; padding: 0; color: ${C.primary};
      font-size: 13px; font-weight: 500; cursor: pointer;
    }
    .jr-link-btn:hover { text-decoration: underline; }
    .jr-otp-input {
      width: 44px; height: 52px; text-align: center; font-size: 22px;
      font-weight: 600; font-family: ${F.mono}; color: ${C.text};
      border: 1.5px solid ${C.borderDk}; border-radius: 6px; background: ${C.bg};
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .jr-otp-input:focus { border-color: ${C.primary}; box-shadow: 0 0 0 3px ${C.primaryLt}; }
    @media (max-width: 420px) { .jr-otp-input { width: 38px; height: 46px; font-size: 19px; } }
    .jr-strength-bar { display: flex; gap: 4px; margin-top: 6px; }
    .jr-strength-bar > div { flex: 1; height: 4px; border-radius: 2px; background: ${C.border}; transition: background 0.18s; }
    .jr-input-wrap { position: relative; }
    .jr-input-wrap .jr-eye {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; color: ${C.text3};
      padding: 4px 6px; font-size: 12px; font-weight: 600;
    }
    .jr-input-wrap .jr-eye:hover { color: ${C.primary}; }
    .jr-step-dots { display: flex; gap: 6px; justify-content: center; margin-bottom: 18px; }
    .jr-step-dots > span {
      width: 22px; height: 4px; border-radius: 2px; background: ${C.border};
      transition: background 0.2s;
    }
    .jr-step-dots > span.active { background: ${C.primary}; }
    .jr-step-dots > span.done { background: ${C.success}; }

    /* Google sign-in */
    .jr-auth-or {
      display: flex; align-items: center; gap: 10px;
      color: ${C.text3}; font-size: 12px; margin: 14px 0;
    }
    .jr-auth-or::before, .jr-auth-or::after {
      content: ""; flex: 1; height: 1px; background: ${C.border};
    }
    .jr-btn-google {
      width: 100%; display: flex; align-items: center; justify-content: center;
      gap: 10px; background: ${C.bg}; color: ${C.text}; font-size: 14px;
      font-weight: 500; padding: 10px 14px; border: 1px solid ${C.borderDk};
      border-radius: 6px; cursor: pointer; transition: background 0.12s;
    }
    .jr-btn-google:hover:not(:disabled) { background: ${C.bgAlt || "#F4F5F7"}; }
    .jr-btn-google:disabled { cursor: not-allowed; opacity: 0.6; }
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
// Three flows in one screen, Atlassian-style:
//   • signin  — email + password
//   • signup  — name → email → password (with strength meter) → 6-digit OTP
//   • forgot  — email → 6-digit OTP → new password
// OTP codes are emailed via the backend (/api/send-otp). If the backend is
// unreachable (e.g. SMTP not configured), we surface the code in-app so the
// user can still complete the flow during local testing.

const OTP_TTL_MS = 10 * 60 * 1000;     // 10 min
const RESEND_COOLDOWN_S = 30;
const OTP_LEN = 6;
const newOtp = () => String(Math.floor(100000 + Math.random() * 900000));

function passwordScore(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8)  s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}
const STRENGTH_LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLORS = ["#DE350B", "#E97F33", "#E2A03F", "#2684FF", "#00875A"];

async function sendOtpEmail({ email, purpose, name }) {
  // Server generates and stores the code, then attempts email delivery.
  // Returns { delivered, devCode? } so the UI can keep working when SMTP
  // is misconfigured during local testing.
  try {
    const data = await api.sendOtp({ email, purpose, name });
    return { delivered: !!data.delivered, devCode: data.devCode || null };
  } catch (e) {
    return { delivered: false, error: e.message || String(e) };
  }
}

// ─── Google Identity Services button ─────────────────────────────────────────
// Loads the GIS script once, renders a Google-branded button, and forwards the
// returned ID token to `onCredential`. The Google Client ID is read from
// `VITE_GOOGLE_CLIENT_ID` at build time, with a server-side fallback via
// `/api/health` for the dev server.
let _gisScriptPromise = null;
function loadGoogleScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.google?.accounts?.id) return Promise.resolve();
  if (_gisScriptPromise) return _gisScriptPromise;
  _gisScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
  return _gisScriptPromise;
}

function GoogleAuthButton({ label = "Continue with Google", onCredential, onError, disabled }) {
  const containerRef = useRef(null);
  const [clientId, setClientId] = useState(
    (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || ""
  );
  const [status, setStatus] = useState(clientId ? "loading" : "needs-id");

  // If no build-time client ID, try fetching from the backend health endpoint.
  useEffect(() => {
    if (clientId) return;
    let alive = true;
    api.health()
      .then(h => { if (alive && h.googleClientId) { setClientId(h.googleClientId); setStatus("loading"); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !containerRef.current) return;
    let cancelled = false;
    loadGoogleScript().then(() => {
      if (cancelled || !containerRef.current) return;
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response?.credential) onCredential?.(response.credential);
          },
          ux_mode: "popup",
          auto_select: false,
        });
        containerRef.current.innerHTML = "";
        window.google.accounts.id.renderButton(containerRef.current, {
          theme: "outline",
          size: "large",
          type: "standard",
          text: label.toLowerCase().includes("sign up") ? "signup_with" : "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: containerRef.current.offsetWidth || 320,
        });
        setStatus("ready");
      } catch (e) {
        setStatus("error");
        onError?.("Could not initialise Google sign-in");
      }
    }).catch(() => {
      setStatus("error");
      onError?.("Could not load Google sign-in. Check your network.");
    });
    return () => { cancelled = true; };
  }, [clientId, label, onCredential, onError]);

  if (status === "needs-id") {
    return (
      <button
        type="button"
        disabled
        className="jr-btn-google"
        title="Set GOOGLE_CLIENT_ID in your .env to enable Google sign-in"
      >
        <GoogleIcon />
        <span>{label} (not configured)</span>
      </button>
    );
  }

  return (
    <div style={{ position: "relative", marginBottom: 6, opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      <div ref={containerRef} style={{ display: "flex", justifyContent: "center", minHeight: 40 }} />
      {status === "loading" && (
        <div style={{ fontSize: 12, color: C.text3, textAlign: "center", marginTop: 6 }}>Loading Google…</div>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.7-1.57 2.69-3.88 2.69-6.62z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.34A9 9 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.66 9c0-.59.1-1.16.29-1.7V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.34z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.96l2.99 2.34C4.66 5.17 6.65 3.58 9 3.58z"/>
    </svg>
  );
}

function AuthScreen({ onLogin }) {
  const [mode, setMode]   = useState("signin");           // signin | signup | forgot
  const [step, setStep]   = useState(1);
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass]   = useState("");
  const [pass2, setPass2] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [err, setErr]     = useState("");
  const [info, setInfo]   = useState("");
  const [busy, setBusy]   = useState(false);
  const [otp, setOtp]     = useState(Array(OTP_LEN).fill(""));
  const [pending, setPending] = useState(null);            // { expiresAt, purpose, devCode? }
  const [cooldown, setCooldown] = useState(0);
  const otpRefs = useRef([]);

  // Resend cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown(c => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const reset = (nextMode = "signin") => {
    setMode(nextMode); setStep(1);
    setName(""); setPass(""); setPass2("");
    setOtp(Array(OTP_LEN).fill("")); setPending(null);
    setErr(""); setInfo(""); setBusy(false); setCooldown(0);
  };

  const switchMode = (m) => { reset(m); };

  const issueOtp = async (purpose, addressedTo) => {
    setBusy(true); setErr(""); setInfo("");
    const result = await sendOtpEmail({
      email: addressedTo, purpose, name: name || undefined,
    });
    setBusy(false);
    setCooldown(RESEND_COOLDOWN_S);
    setPending({ expiresAt: Date.now() + OTP_TTL_MS, purpose, devCode: result.devCode });
    if (result.delivered) {
      setInfo(`We emailed a 6-digit code to ${addressedTo}. It expires in 10 minutes.`);
    } else if (result.devCode) {
      setInfo(`Email delivery unavailable — use code ${result.devCode} to continue.`);
    } else {
      setErr(result.error || "Couldn't send verification email. Check the server.");
    }
  };

  const enteredOtp = () => otp.join("");

  // ── Sign-in submit ────────────────────────────────────────────────────────
  const submitSignin = async () => {
    setErr(""); setBusy(true);
    try {
      const data = await api.signin({ email: email.trim().toLowerCase(), password: pass });
      onLogin(data);
    } catch (e) {
      setErr(e.message || "Sign-in failed");
    } finally { setBusy(false); }
  };

  // ── Google sign-in / sign-up ──────────────────────────────────────────────
  const handleGoogleCredential = async (credential) => {
    setErr(""); setInfo(""); setBusy(true);
    try {
      const data = await api.google(credential);
      onLogin(data);
    } catch (e) {
      setErr(e.message || "Google sign-in failed");
    } finally { setBusy(false); }
  };

  // ── Sign-up flow ──────────────────────────────────────────────────────────
  const beginSignup = async () => {
    setErr("");
    if (!name.trim()) return setErr("Please enter your full name");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setErr("Enter a valid email address");
    if (passwordScore(pass) < 2) return setErr("Choose a stronger password (8+ chars, mix of letters & numbers)");
    if (pass !== pass2) return setErr("Passwords don't match");
    await issueOtp("signup", email.trim().toLowerCase());
    setStep(2);
  };

  const finishSignup = async () => {
    const code = enteredOtp();
    if (code.length !== OTP_LEN) return setErr(`Enter the ${OTP_LEN}-digit code`);
    setErr(""); setBusy(true);
    try {
      const data = await api.signup({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password: pass,
        code,
      });
      onLogin(data);
    } catch (e) {
      setErr(e.message || "Verification failed");
    } finally { setBusy(false); }
  };

  // ── Forgot-password flow ──────────────────────────────────────────────────
  const beginForgot = async () => {
    setErr(""); setBusy(true);
    const target = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) { setBusy(false); return setErr("Enter a valid email address"); }
    try {
      const check = await api.forgot({ email: target });
      if (!check.exists) { setBusy(false); return setErr("No account found with that email"); }
    } catch (e) { setBusy(false); return setErr(e.message || "Couldn't reach server"); }
    setBusy(false);
    await issueOtp("reset", target);
    setStep(2);
  };

  const confirmForgotOtp = () => {
    setErr("");
    if (enteredOtp().length !== OTP_LEN) return setErr(`Enter the ${OTP_LEN}-digit code`);
    setStep(3);
  };

  const finishForgot = async () => {
    setErr("");
    if (passwordScore(pass) < 2) return setErr("Choose a stronger password");
    if (pass !== pass2) return setErr("Passwords don't match");
    setBusy(true);
    try {
      const data = await api.reset({
        email: email.trim().toLowerCase(),
        code: enteredOtp(),
        password: pass,
      });
      onLogin(data);
    } catch (e) {
      setErr(e.message || "Reset failed");
    } finally { setBusy(false); }
  };

  // ── OTP digit handlers ────────────────────────────────────────────────────
  const setOtpDigit = (i, v) => {
    const ch = (v || "").replace(/\D/g, "").slice(-1);
    setOtp(prev => { const n = [...prev]; n[i] = ch; return n; });
    if (ch && i < OTP_LEN - 1) otpRefs.current[i + 1]?.focus();
  };
  const onOtpKey = (i, e) => {
    if (e.key === "Backspace" && !otp[i] && i > 0) otpRefs.current[i - 1]?.focus();
    else if (e.key === "ArrowLeft" && i > 0) otpRefs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < OTP_LEN - 1) otpRefs.current[i + 1]?.focus();
    else if (e.key === "Enter") {
      if (mode === "signup") finishSignup();
      else if (mode === "forgot") confirmForgotOtp();
    }
  };
  const onOtpPaste = (e) => {
    const text = (e.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, OTP_LEN);
    if (!text) return;
    e.preventDefault();
    const arr = Array(OTP_LEN).fill("");
    for (let i = 0; i < text.length; i++) arr[i] = text[i];
    setOtp(arr);
    otpRefs.current[Math.min(text.length, OTP_LEN - 1)]?.focus();
  };

  const resendOtp = async () => {
    if (cooldown > 0 || !pending) return;
    setOtp(Array(OTP_LEN).fill(""));
    await issueOtp(pending.purpose, email.trim().toLowerCase());
  };

  // ── Render helpers ────────────────────────────────────────────────────────
  const score = passwordScore(pass);
  const headerForMode = {
    signin: { title: "Sign in to Jiraly",   sub: "Welcome back — enter your details below." },
    signup: { title: "Create your account", sub: "Plan, track, and ship work with your team." },
    forgot: { title: "Reset your password", sub: "We'll email you a verification code." },
  }[mode];

  const totalSteps = mode === "forgot" ? 3 : mode === "signup" ? 2 : 1;

  return (
    <>
      <GlobalStyle />
      <div className="jr-auth-shell" style={{ fontFamily: F.sans, color: C.text, background: C.bg2 }}>
        {/* Brand panel (desktop only) */}
        <aside className="jr-auth-aside">
          <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative", zIndex: 1 }}>
            <Logo size={36} light />
            <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: 0.2 }}>Jiraly</span>
          </div>
          <div style={{ position: "relative", zIndex: 1, maxWidth: 460 }}>
            <div style={{ fontSize: 13, opacity: 0.85, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>
              Project & meeting management
            </div>
            <h1 style={{ fontSize: 34, lineHeight: 1.2, fontWeight: 700, margin: "0 0 16px" }}>
              Plan sprints. Run meetings.<br />Ship faster.
            </h1>
            <p style={{ fontSize: 15, lineHeight: 1.55, opacity: 0.92, margin: 0 }}>
              A Jira-style tracker with built-in meeting scheduling — generate Google Meet,
              Zoom, Teams, or Jitsi links and email calendar invites in one click.
            </p>
            <div style={{ display: "flex", gap: 22, marginTop: 28, flexWrap: "wrap" }}>
              {[
                ["✓", "Kanban & backlog"],
                ["✉", "Email + .ics invites"],
                ["🔒", "Verified accounts"],
              ].map(([ico, label]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: 0.95 }}>
                  <span style={{ width: 26, height: 26, borderRadius: "50%", background: "rgba(255,255,255,0.18)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{ico}</span>
                  {label}
                </div>
              ))}
            </div>
          </div>
          <div style={{ position: "relative", zIndex: 1, fontSize: 12, opacity: 0.7 }}>
            © {new Date().getFullYear()} Jiraly · Local-first MVP
          </div>
        </aside>

        {/* Form panel */}
        <main className="jr-auth-main">
          <div className="jr-auth-card">
            {/* Mobile-only logo */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 22 }} className="jr-auth-mobile-logo">
              <Logo size={32} />
              <span style={{ fontSize: 18, fontWeight: 600 }}>Jiraly</span>
            </div>

            <div style={{ marginBottom: 18 }}>
              <h2 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: C.text }}>{headerForMode.title}</h2>
              <p style={{ margin: "6px 0 0", fontSize: 14, color: C.text3 }}>{headerForMode.sub}</p>
            </div>

            {totalSteps > 1 && (
              <div className="jr-step-dots" aria-hidden>
                {Array.from({ length: totalSteps }).map((_, i) => (
                  <span key={i} className={i + 1 === step ? "active" : i + 1 < step ? "done" : ""} />
                ))}
              </div>
            )}

            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: 24, boxShadow: "0 1px 2px rgba(9,30,66,0.08)" }}>
              {/* ── SIGN IN ─────────────────────────────────────────────── */}
              {mode === "signin" && (
                <>
                  <GoogleAuthButton
                    label="Continue with Google"
                    onCredential={handleGoogleCredential}
                    onError={(m) => setErr(m)}
                    disabled={busy}
                  />
                  <div className="jr-auth-or"><span>or continue with email</span></div>

                  <Field label="Email">
                    <input type="email" autoComplete="email" autoFocus style={inputStyle}
                      value={email} onChange={e => setEmail(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && submitSignin()}
                      placeholder="you@company.com" />
                  </Field>
                  <Field label={
                    <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Password</span>
                      <button type="button" className="jr-link-btn" onClick={() => switchMode("forgot")}>Forgot password?</button>
                    </span>
                  }>
                    <PasswordInput value={pass} setValue={setPass} show={showPw} setShow={setShowPw}
                      autoComplete="current-password"
                      onEnter={submitSignin} placeholder="Enter your password" />
                  </Field>

                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.text2, marginBottom: 14, cursor: "pointer" }}>
                    <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                    Remember me on this device
                  </label>

                  <ErrorInfo err={err} info={info} />

                  <button onClick={submitSignin} className="jr-btn-primary" disabled={busy}
                    style={primaryBtnStyle}>Sign in</button>

                  <Divider />
                  <div style={switchRowStyle}>
                    New to Jiraly?{" "}
                    <button className="jr-link-btn" onClick={() => switchMode("signup")}>Create an account</button>
                  </div>
                </>
              )}

              {/* ── SIGN UP — STEP 1: details ───────────────────────────── */}
              {mode === "signup" && step === 1 && (
                <>
                  <GoogleAuthButton
                    label="Sign up with Google"
                    onCredential={handleGoogleCredential}
                    onError={(m) => setErr(m)}
                    disabled={busy}
                  />
                  <div className="jr-auth-or"><span>or sign up with email</span></div>

                  <Field label="Full name">
                    <input autoFocus style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="Alex Rivera" />
                  </Field>
                  <Field label="Work email">
                    <input type="email" autoComplete="email" style={inputStyle}
                      value={email} onChange={e => setEmail(e.target.value)}
                      placeholder="alex@company.com" />
                  </Field>
                  <Field label="Password">
                    <PasswordInput value={pass} setValue={setPass} show={showPw} setShow={setShowPw}
                      autoComplete="new-password" placeholder="At least 8 characters" />
                    <div className="jr-strength-bar" aria-hidden>
                      {[0,1,2,3].map(i => (
                        <div key={i} style={{ background: i < score ? STRENGTH_COLORS[score] : C.border }} />
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: pass ? STRENGTH_COLORS[score] : C.text3, marginTop: 4, fontWeight: 500 }}>
                      {pass ? STRENGTH_LABELS[score] : "Use 8+ characters with letters, numbers & symbols"}
                    </div>
                  </Field>
                  <Field label="Confirm password">
                    <PasswordInput value={pass2} setValue={setPass2} show={showPw} setShow={setShowPw}
                      autoComplete="new-password" onEnter={beginSignup}
                      placeholder="Re-enter password" />
                  </Field>

                  <ErrorInfo err={err} info={info} />

                  <button onClick={beginSignup} className="jr-btn-primary" disabled={busy}
                    style={primaryBtnStyle}>
                    {busy ? "Sending code…" : "Continue"}
                  </button>

                  <p style={{ fontSize: 11, color: C.text3, textAlign: "center", marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
                    By continuing, you agree to receive a one-time verification code at {email || "your email"}.
                  </p>

                  <Divider />
                  <div style={switchRowStyle}>
                    Already have an account?{" "}
                    <button className="jr-link-btn" onClick={() => switchMode("signin")}>Sign in</button>
                  </div>
                </>
              )}

              {/* ── SIGN UP — STEP 2: OTP ───────────────────────────────── */}
              {mode === "signup" && step === 2 && (
                <OtpStep
                  email={email} otp={otp} setOtpDigit={setOtpDigit} onOtpKey={onOtpKey}
                  onOtpPaste={onOtpPaste} otpRefs={otpRefs}
                  err={err} info={info} pending={pending} busy={busy}
                  cooldown={cooldown} onResend={resendOtp}
                  onSubmit={finishSignup} submitLabel="Create account"
                  onBack={() => { setStep(1); setErr(""); setInfo(""); }}
                />
              )}

              {/* ── FORGOT — STEP 1: email ──────────────────────────────── */}
              {mode === "forgot" && step === 1 && (
                <>
                  <Field label="Account email">
                    <input type="email" autoFocus autoComplete="email" style={inputStyle}
                      value={email} onChange={e => setEmail(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && beginForgot()}
                      placeholder="you@company.com" />
                  </Field>

                  <ErrorInfo err={err} info={info} />

                  <button onClick={beginForgot} className="jr-btn-primary" disabled={busy}
                    style={primaryBtnStyle}>
                    {busy ? "Sending code…" : "Send verification code"}
                  </button>

                  <Divider />
                  <div style={switchRowStyle}>
                    Remembered it?{" "}
                    <button className="jr-link-btn" onClick={() => switchMode("signin")}>Back to sign in</button>
                  </div>
                </>
              )}

              {/* ── FORGOT — STEP 2: OTP ────────────────────────────────── */}
              {mode === "forgot" && step === 2 && (
                <OtpStep
                  email={email} otp={otp} setOtpDigit={setOtpDigit} onOtpKey={onOtpKey}
                  onOtpPaste={onOtpPaste} otpRefs={otpRefs}
                  err={err} info={info} pending={pending} busy={busy}
                  cooldown={cooldown} onResend={resendOtp}
                  onSubmit={confirmForgotOtp} submitLabel="Verify code"
                  onBack={() => { setStep(1); setErr(""); setInfo(""); }}
                />
              )}

              {/* ── FORGOT — STEP 3: new password ───────────────────────── */}
              {mode === "forgot" && step === 3 && (
                <>
                  <Field label="New password">
                    <PasswordInput value={pass} setValue={setPass} show={showPw} setShow={setShowPw}
                      autoComplete="new-password" placeholder="At least 8 characters" autoFocus />
                    <div className="jr-strength-bar" aria-hidden>
                      {[0,1,2,3].map(i => (
                        <div key={i} style={{ background: i < score ? STRENGTH_COLORS[score] : C.border }} />
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: pass ? STRENGTH_COLORS[score] : C.text3, marginTop: 4, fontWeight: 500 }}>
                      {pass ? STRENGTH_LABELS[score] : "Use 8+ characters with a mix of letters & numbers"}
                    </div>
                  </Field>
                  <Field label="Confirm new password">
                    <PasswordInput value={pass2} setValue={setPass2} show={showPw} setShow={setShowPw}
                      autoComplete="new-password" onEnter={finishForgot}
                      placeholder="Re-enter new password" />
                  </Field>

                  <ErrorInfo err={err} info={info} />

                  <button onClick={finishForgot} className="jr-btn-primary" style={primaryBtnStyle}>
                    Reset password & sign in
                  </button>
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

// ── Auth helpers ──────────────────────────────────────────────────────────
const primaryBtnStyle = {
  width: "100%", padding: "11px 0", background: C.primary, border: "none",
  borderRadius: 4, color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer",
  letterSpacing: 0.2,
};
const switchRowStyle = {
  textAlign: "center", fontSize: 13, color: C.text2,
};

function Divider() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 14px", color: C.text3, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>
      <span style={{ flex: 1, height: 1, background: C.border }} />
      <span>or</span>
      <span style={{ flex: 1, height: 1, background: C.border }} />
    </div>
  );
}

function ErrorInfo({ err, info }) {
  if (!err && !info) return null;
  if (err) return (
    <div role="alert" style={{ fontSize: 13, color: C.danger, background: C.dangerBg, padding: "9px 12px", borderRadius: 4, marginBottom: 12, border: `1px solid #FFBDAD` }}>
      {err}
    </div>
  );
  return (
    <div style={{ fontSize: 13, color: C.primaryDk, background: C.primaryLt, padding: "9px 12px", borderRadius: 4, marginBottom: 12, border: `1px solid #B3D4FF` }}>
      {info}
    </div>
  );
}

function PasswordInput({ value, setValue, show, setShow, onEnter, placeholder, autoComplete, autoFocus }) {
  return (
    <div className="jr-input-wrap">
      <input
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        style={{ ...inputStyle, paddingRight: 56 }}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => e.key === "Enter" && onEnter && onEnter()}
        placeholder={placeholder}
      />
      <button type="button" className="jr-eye" onClick={() => setShow(s => !s)} tabIndex={-1}>
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}

function OtpStep({
  email, otp, setOtpDigit, onOtpKey, onOtpPaste, otpRefs,
  err, info, pending, busy, cooldown, onResend, onSubmit, submitLabel, onBack,
}) {
  return (
    <>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: C.text2, lineHeight: 1.5 }}>
        Enter the {OTP_LEN}-digit code we sent to{" "}
        <strong style={{ color: C.text }}>{email}</strong>.
      </p>

      <div onPaste={onOtpPaste}
        style={{ display: "flex", justifyContent: "space-between", gap: 6, marginBottom: 14 }}>
        {otp.map((d, i) => (
          <input
            key={i}
            ref={el => (otpRefs.current[i] = el)}
            className="jr-otp-input"
            inputMode="numeric"
            pattern="\d*"
            maxLength={1}
            value={d}
            autoFocus={i === 0}
            onChange={e => setOtpDigit(i, e.target.value)}
            onKeyDown={e => onOtpKey(i, e)}
          />
        ))}
      </div>

      {pending?.devCode && (
        <div style={{ fontSize: 12, color: C.text3, marginBottom: 10, textAlign: "center", fontFamily: F.mono }}>
          Dev code: <strong style={{ color: C.text }}>{pending.devCode}</strong> (shown because email delivery failed)
        </div>
      )}

      <ErrorInfo err={err} info={info} />

      <button onClick={onSubmit} className="jr-btn-primary" disabled={busy}
        style={primaryBtnStyle}>{submitLabel}</button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, fontSize: 13 }}>
        <button className="jr-link-btn" onClick={onBack}>← Back</button>
        <button className="jr-link-btn" onClick={onResend} disabled={cooldown > 0 || busy}
          style={{ opacity: cooldown > 0 ? 0.5 : 1, cursor: cooldown > 0 ? "default" : "pointer" }}>
          {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
        </button>
      </div>
    </>
  );
}

// ─── TopHeader (global app bar) ──────────────────────────────────────────────
function TopHeader({ session, onCreate, onLogout, onOpenIssue, onPickProject, setView }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifs, setNotifs] = useState([]);
  const [readIds, setReadIds] = useState(() => {
    try { return new Set(JSON.parse(safeStorage.getItem("jr:readNotifs") || "[]")); }
    catch { return new Set(); }
  });
  const menuRef = useRef(null);
  const notifRef = useRef(null);

  // Poll the API for notifications. Refreshes when popover opens and every 60s.
  const refresh = async () => {
    try { const r = await api.notifications(); setNotifs(r.notifications || []); }
    catch { /* ignore — server may be offline */ }
  };
  useEffect(() => { refresh(); const t = setInterval(refresh, 60_000); return () => clearInterval(t); }, []);
  useEffect(() => { if (notifOpen) refresh(); }, [notifOpen]);

  useEffect(() => {
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const markAllRead = () => {
    const all = new Set([...readIds, ...notifs.map(n => n.id)]);
    setReadIds(all);
    safeStorage.setItem("jr:readNotifs", JSON.stringify([...all]));
  };
  const handleClick = (n) => {
    setReadIds(prev => {
      const next = new Set(prev); next.add(n.id);
      safeStorage.setItem("jr:readNotifs", JSON.stringify([...next]));
      return next;
    });
    setNotifOpen(false);
    if (n.link?.type === "meeting") setView?.("meetings");
    else if (n.link?.type === "issue") {
      if (n.link.projectId) onPickProject?.(n.link.projectId);
      onOpenIssue?.(n.link.id);
    }
  };
  const unread = notifs.filter(n => !readIds.has(n.id)).length;

  return (
    <header className="jr-topbar" style={{
      height: 56, background: C.bg, borderBottom: `1px solid ${C.border}`,
      display: "flex", alignItems: "center", padding: "0 16px", gap: 12, flexShrink: 0,
      position: "sticky", top: 0, zIndex: 50,
    }}>
      {/* App switcher + brand */}
      <button className="jr-icon-btn" title="Apps" aria-label="App switcher">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <circle cx="4" cy="4" r="1.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="16" cy="4" r="1.5"/>
          <circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/>
          <circle cx="4" cy="16" r="1.5"/><circle cx="10" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/>
        </svg>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 6px" }}>
        <Logo size={26} />
        <span style={{ fontWeight: 600, fontSize: 15, color: C.text }}>Jiraly</span>
      </div>

      {/* Search */}
      <div style={{ flex: 1, display: "flex", justifyContent: "center", maxWidth: 720, margin: "0 auto" }}>
        <div className="jr-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="7" cy="7" r="5"/><path d="M11 11l3 3" strokeLinecap="round"/>
          </svg>
          <input placeholder="Search" />
        </div>
      </div>

      {/* Create + actions */}
      <button onClick={onCreate} className="jr-btn-primary"
        style={{ padding: "7px 14px", background: C.primary, border: "none", borderRadius: 4, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> Create
      </button>

      <div ref={notifRef} style={{ position: "relative" }}>
        <button onClick={() => setNotifOpen(o => !o)} className="jr-icon-btn" title="Notifications" aria-label="Notifications">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 8a5 5 0 0110 0v3l1.5 2.5h-13L5 11V8z" strokeLinejoin="round"/>
            <path d="M8 16a2 2 0 004 0" strokeLinecap="round"/>
          </svg>
          {unread > 0 && (
            <span style={{
              position: "absolute", top: 4, right: 4, minWidth: 16, height: 16,
              padding: "0 4px", borderRadius: 8, background: C.danger, color: "#fff",
              fontSize: 10, fontWeight: 700, display: "inline-flex",
              alignItems: "center", justifyContent: "center", lineHeight: 1,
            }}>{unread > 99 ? "99+" : unread}</span>
          )}
        </button>
        {notifOpen && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            width: 360, maxHeight: 480, overflow: "auto",
            background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
            boxShadow: "0 8px 16px rgba(9,30,66,0.15)", zIndex: 60,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
              <strong style={{ fontSize: 14, color: C.text }}>Notifications</strong>
              {notifs.length > 0 && (
                <button onClick={markAllRead} className="jr-link-btn" style={{ fontSize: 12 }}>
                  Mark all read
                </button>
              )}
            </div>
            {notifs.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center", color: C.text3, fontSize: 13 }}>
                You're all caught up.
              </div>
            ) : notifs.map(n => {
              const isUnread = !readIds.has(n.id);
              const dotColor = n.kind === "overdue" ? C.danger
                : n.kind === "due_soon" ? "#E2A03F"
                : n.kind === "meeting" ? C.primary
                : "#5243AA";
              return (
                <button key={n.id} onClick={() => handleClick(n)}
                  style={{
                    display: "flex", gap: 10, width: "100%", textAlign: "left",
                    padding: "12px 14px", border: "none", borderBottom: `1px solid ${C.border}`,
                    background: isUnread ? "#F4F5F7" : C.bg, cursor: "pointer",
                  }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, marginTop: 6, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: isUnread ? 600 : 500, color: C.text }}>{n.title}</div>
                    {n.body && <div style={{ fontSize: 12, color: C.text3, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.body}</div>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <button className="jr-icon-btn" title="Help" aria-label="Help">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.5a2.2 2.2 0 014.2 0c0 1.6-2 1.8-2 3M10 14h.01" strokeLinecap="round"/>
        </svg>
      </button>
      <button className="jr-icon-btn" title="Settings" aria-label="Settings">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="10" cy="10" r="2.5"/>
          <path d="M10 1.5l1 2.2 2.4-.4.4 2.4 2.2 1-1.4 2 1.4 2-2.2 1-.4 2.4-2.4-.4L10 18.5l-1-2.2-2.4.4-.4-2.4-2.2-1 1.4-2-1.4-2 2.2-1 .4-2.4 2.4.4z" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* User menu */}
      <div ref={menuRef} style={{ position: "relative" }}>
        <button onClick={() => setMenuOpen(o => !o)} title={session.name}
          style={{ background: "transparent", border: "none", padding: 2, borderRadius: "50%", cursor: "pointer" }}>
          <Avatar email={session.email} name={session.name} size={32} />
        </button>
        {menuOpen && (
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
            boxShadow: "0 8px 16px rgba(9,30,66,0.15)", minWidth: 220, zIndex: 60,
            overflow: "hidden",
          }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{session.name}</div>
              <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>{session.email}</div>
              <div style={{ fontSize: 11, color: C.primaryDk, background: C.primaryLt, padding: "2px 6px", borderRadius: 3, display: "inline-block", marginTop: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{session.role}</div>
            </div>
            <button onClick={onLogout} className="jr-menu-item">Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

// ─── Sidebar (white, modern Jira) ────────────────────────────────────────────
function Sidebar({ projects, activeId, onPick, onNewProject, view, setView, starred, onToggleStar }) {
  const [collapsed, setCollapsed] = useState(false);
  const w = collapsed ? 56 : 240;

  return (
    <aside className="jr-sidebar" style={{
      width: w, background: C.bg, borderRight: `1px solid ${C.border}`,
      display: "flex", flexDirection: "column", flexShrink: 0,
      transition: "width 0.18s",
    }}>
      <div style={{ padding: "10px 8px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: collapsed ? "center" : "flex-end" }}>
        <button onClick={() => setCollapsed(c => !c)} className="jr-icon-btn" title={collapsed ? "Expand" : "Collapse"}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ transform: collapsed ? "rotate(180deg)" : "none" }}>
            <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <nav style={{ padding: "8px 6px", flex: collapsed ? "0 0 auto" : "0 0 auto" }}>
        {[
          { id: "dash",    icon: <IconCircle />,    label: "For you" },
          { id: "recent",  icon: <IconClock />,     label: "Recent" },
          { id: "starred", icon: <IconStar />,      label: "Starred" },
          { id: "apps",    icon: <IconApps />,      label: "Apps" },
        ].map(it => (
          <SbItem
            key={it.id} icon={it.icon} label={it.label} collapsed={collapsed}
            active={view === it.id}
            onClick={() => setView(it.id)}
          />
        ))}
      </nav>

      {!collapsed && (
        <div style={{ padding: "6px 14px 6px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.6, color: C.text3, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Projects</span>
          <button onClick={onNewProject} title="New project" className="jr-icon-btn-sm">+</button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px 8px" }}>
        {projects.length === 0 && !collapsed && (
          <div style={{ padding: "8px 12px", fontSize: 12, color: C.text3 }}>
            No projects yet. Create one to start.
          </div>
        )}
        {projects.map(p => {
          const active = p.id === activeId;
          const isStar = starred?.has(p.id);
          return (
            <div key={p.id} className={`jr-sb-item ${active ? "active" : ""}`} style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 4 }}>
              <button onClick={() => onPick(p.id)}
                title={collapsed ? p.name : undefined}
                style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "inherit", font: "inherit", textAlign: "left" }}>
                <span style={{ width: 22, height: 22, borderRadius: 4, background: stringColor(p.key), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                  {p.key.slice(0, 2)}
                </span>
                {!collapsed && <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>}
              </button>
              {!collapsed && (
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleStar?.(p.id); }}
                  title={isStar ? "Unstar" : "Star this project"}
                  style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center", color: isStar ? "#E2A03F" : C.text3 }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill={isStar ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                    <path d="M8 1.8l1.9 4 4.3.6-3.1 3 .8 4.3L8 11.6 4.1 13.7l.8-4.3-3.1-3 4.3-.6L8 1.8z"/>
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, padding: "8px 6px" }}>
        {[
          { id: "dash",     icon: <IconDash />,     label: "Dashboard" },
          { id: "meetings", icon: <IconCalendar />, label: "Meetings" },
          { id: "filters",  icon: <IconFilter />,   label: "Filters" },
        ].map(it => (
          <SbItem
            key={it.id} icon={it.icon} label={it.label} collapsed={collapsed}
            active={view === it.id}
            onClick={() => (it.id === "dash" || it.id === "meetings") && setView(it.id)}
          />
        ))}
      </div>
    </aside>
  );
}

function SbItem({ icon, label, collapsed, active, onClick }) {
  return (
    <button onClick={onClick}
      className={`jr-sb-item ${active ? "active" : ""}`}
      title={collapsed ? label : undefined}>
      <span style={{ width: 22, display: "flex", alignItems: "center", justifyContent: "center", color: "currentColor", flexShrink: 0 }}>{icon}</span>
      {!collapsed && <span style={{ flex: 1, textAlign: "left" }}>{label}</span>}
    </button>
  );
}

// ─── Tiny inline icons (16px) ────────────────────────────────────────────────
const Ic = ({ children }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const IconCircle   = () => <Ic><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></Ic>;
const IconClock    = () => <Ic><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></Ic>;
const IconStar     = () => <Ic><path d="M8 1.8l1.9 4 4.3.6-3.1 3 .8 4.3L8 11.6 4.1 13.7l.8-4.3-3.1-3 4.3-.6L8 1.8z"/></Ic>;
const IconApps     = () => <Ic><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></Ic>;
const IconCalendar = () => <Ic><rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M5 1v3M11 1v3M2 6h12"/></Ic>;
const IconFilter   = () => <Ic><path d="M2 3h12l-4.5 5.5V13L6.5 14.5V8.5L2 3z"/></Ic>;
const IconDash     = () => <Ic><rect x="2" y="2" width="5" height="6" rx="1"/><rect x="9" y="2" width="5" height="3" rx="1"/><rect x="9" y="7" width="5" height="7" rx="1"/><rect x="2" y="10" width="5" height="4" rx="1"/></Ic>;

// ─── ProjectHeader (breadcrumbs + tabs) ──────────────────────────────────────
function ProjectHeader({ project, view, setView }) {
  const tabs = [
    { id: "board",    label: "Board" },
    { id: "backlog",  label: "Backlog" },
    { id: "meetings", label: "Meetings" },
  ];

  return (
    <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}`, padding: "16px 28px 0", flexShrink: 0 }}>
      <div style={{ fontSize: 12, color: C.text3, marginBottom: 6 }}>
        {view === "meetings" ? "Workspace" : "Projects"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        {view === "meetings" ? (
          <>
            <span style={{ width: 26, height: 26, borderRadius: 5, background: C.primary, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>📅</span>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text }}>Meetings</h1>
          </>
        ) : project ? (
          <>
            <span style={{ width: 26, height: 26, borderRadius: 5, background: stringColor(project.key), color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>
              {project.key.slice(0, 2)}
            </span>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text }}>{project.name}</h1>
            <span style={{ fontSize: 11, color: C.text3, fontFamily: F.mono, background: C.bg2, padding: "2px 6px", borderRadius: 3 }}>{project.key}</span>
          </>
        ) : (
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: C.text }}>Welcome</h1>
        )}
      </div>

      {project && view !== "meetings" && (
        <div style={{ display: "flex", gap: 4, marginTop: 8, marginBottom: -1 }}>
          {tabs.filter(t => t.id !== "meetings").map(t => {
            const active = view === t.id;
            return (
              <button key={t.id} onClick={() => setView(t.id)}
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  padding: "8px 14px", fontSize: 14, fontWeight: active ? 600 : 500,
                  color: active ? C.primary : C.text2,
                  borderBottom: `2px solid ${active ? C.primary : "transparent"}`,
                  marginBottom: -1,
                }}>
                {t.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
    <div style={{ padding: "16px 28px 24px", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <BoardFilters
        search={search} setSearch={setSearch}
        filterAssignee={filterAssignee} setFA={setFA}
        filterType={filterType} setFT={setFT}
        users={users}
      />

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: `repeat(${STATUSES.length}, minmax(260px, 1fr)) 44px`, gap: 12, minHeight: 0 }}>
        {STATUSES.map(col => (
          <div key={col.id}
            className={`jr-col-modern ${overCol === col.id ? "over" : ""}`}
            onDragOver={e => { e.preventDefault(); setOverCol(col.id); }}
            onDragLeave={() => setOverCol(c => c === col.id ? null : c)}
            onDrop={() => { if (dragId) onMove(dragId, col.id); setDragId(null); setOverCol(null); }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {col.label}
                </span>
                <span className="jr-count-pill">{grouped[col.id].length}</span>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: "0 4px" }}>
              {grouped[col.id].map(issue => (
                <IssueCard
                  key={issue.id} issue={issue} users={users}
                  isDragging={dragId === issue.id}
                  onDragStart={() => setDragId(issue.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onClick={() => onOpen(issue)}
                />
              ))}
            </div>

            <button className="jr-col-add" onClick={() => onNewInColumn(col.id)}>
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> Create
            </button>
          </div>
        ))}

        <button title="Add column" disabled
          style={{ background: C.bg2, border: `1px dashed ${C.borderDk}`, borderRadius: 4, color: C.text3, fontSize: 18, cursor: "not-allowed", opacity: 0.6 }}>+</button>
      </div>
    </div>
  );
}

function BoardFilters({ search, setSearch, filterAssignee, setFA, filterType, setFT, users }) {
  const active = !!filterAssignee || !!filterType;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
      <div className="jr-search" style={{ maxWidth: 260, height: 32, flex: "0 1 260px" }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="7" cy="7" r="5"/><path d="M11 11l3 3" strokeLinecap="round"/>
        </svg>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search board" />
      </div>

      <div style={{ display: "flex", alignItems: "center" }}>
        {users.slice(0, 4).map((u, i) => (
          <span key={u.id} style={{ marginLeft: i === 0 ? 0 : -8, border: `2px solid ${C.bg}`, borderRadius: "50%", display: "inline-flex" }}>
            <Avatar email={u.email} name={u.name} size={26} />
          </span>
        ))}
      </div>

      <select value={filterType} onChange={e => setFT(e.target.value)}
        style={{ padding: "6px 10px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 4, background: C.bg, color: C.text2, cursor: "pointer" }}>
        <option value="">All types</option>
        {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <select value={filterAssignee} onChange={e => setFA(e.target.value)}
        style={{ padding: "6px 10px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 4, background: C.bg, color: C.text2, cursor: "pointer" }}>
        <option value="">All assignees</option>
        <option value="__unassigned">Unassigned</option>
        {users.map(u => <option key={u.id} value={u.email}>{u.name}</option>)}
      </select>
      {active && (
        <button onClick={() => { setFA(""); setFT(""); }} className="jr-link-btn" style={{ fontSize: 13 }}>
          Clear filters
        </button>
      )}
    </div>
  );
}

function IssueCard({ issue, users, isDragging, onDragStart, onDragEnd, onClick }) {
  const type = TYPE_BY_ID[issue.type] || TYPES[0];
  const prio = PRIO_BY_ID[issue.priority] || PRIORITIES[2];
  const assignee = users.find(u => u.email === issue.assignee);

  const overdue = issue.dueDate && new Date(issue.dueDate) < new Date(new Date().toDateString())
                  && issue.status !== "done";
  const dueLabel = issue.dueDate
    ? new Date(issue.dueDate).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
    : null;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className={`jr-card ${isDragging ? "dragging" : ""}`}
      style={{
        background: C.bg, borderRadius: 4, padding: "10px 12px",
        boxShadow: "0 1px 1px rgba(9,30,66,0.1), 0 0 1px rgba(9,30,66,0.31)",
        cursor: "pointer", userSelect: "none",
      }}>
      <div style={{ fontSize: 14, color: C.text, marginBottom: 8, lineHeight: 1.35, fontWeight: 500 }}>{issue.title}</div>

      {dueLabel && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "2px 7px", borderRadius: 3, fontSize: 11, fontWeight: 600,
          marginBottom: 8,
          background: overdue ? C.dangerBg : C.bg2,
          color: overdue ? C.danger : C.text2,
          border: overdue ? `1px solid #FFBDAD` : `1px solid ${C.border}`,
        }}>
          {overdue && <span>⚠</span>}{dueLabel}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span title={type.label} style={{ width: 16, height: 16, borderRadius: 3, background: type.color, color: "#fff", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
            {type.icon}
          </span>
          <span style={{ fontSize: 12, color: C.text3, fontFamily: F.mono, fontWeight: 500 }}>{issue.key}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span title={`${prio.label} priority`} style={{ color: prio.color, fontSize: 13, fontWeight: 700 }}>{prio.icon}</span>
          {assignee
            ? <Avatar email={assignee.email} name={assignee.name} size={22} />
            : <span style={{ width: 22, height: 22, borderRadius: "50%", border: `1.5px dashed ${C.borderDk}`, display: "inline-flex", alignItems: "center", justifyContent: "center", color: C.text3, fontSize: 11 }}>👤</span>
          }
        </div>
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

// ─── Recent / Starred / Apps views ──────────────────────────────────────────
function PageShell({ title, subtitle, children }) {
  return (
    <div style={{ flex: 1, padding: "20px 28px", overflow: "auto" }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: C.text, margin: 0 }}>{title}</h1>
        {subtitle && <div style={{ fontSize: 13, color: C.text3, marginTop: 4 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function RecentView({ projects, issues, recents, onPickProject, onOpenIssue }) {
  const recentProjects = recents
    .map(id => projects.find(p => p.id === id))
    .filter(Boolean);
  const recentIssues = [...issues]
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 12);

  return (
    <PageShell title="Recent" subtitle="Things you've worked on lately">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        <Panel title="Recent projects">
          {recentProjects.length === 0 ? (
            <div style={{ fontSize: 13, color: C.text3 }}>Open a project to see it here.</div>
          ) : recentProjects.map(p => (
            <button key={p.id} onClick={() => onPickProject(p.id)} className="jr-dash-row">
              <span style={{ width: 26, height: 26, borderRadius: 4, background: stringColor(p.key), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff" }}>{p.key.slice(0, 2)}</span>
              <span style={{ flex: 1, fontSize: 13, color: C.text }}>{p.name}</span>
              <span style={{ fontSize: 11, color: C.text3 }}>{p.key}</span>
            </button>
          ))}
        </Panel>
        <Panel title="Recently updated issues">
          {recentIssues.length === 0 ? (
            <div style={{ fontSize: 13, color: C.text3 }}>No issues yet.</div>
          ) : recentIssues.map(i => {
            const proj = projects.find(p => p.id === i.projectId);
            return (
              <button key={i.id} onClick={() => { if (proj) onPickProject(proj.id); onOpenIssue(i.id); }} className="jr-dash-row">
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: C.text3, fontWeight: 600 }}>{proj?.key ? `${proj.key} · ` : ""}{i.key}</div>
                  <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</div>
                </span>
                <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 3, background: STATUS_BY_ID[i.status]?.bg || "#F4F5F7", color: STATUS_BY_ID[i.status]?.color || C.text2 }}>
                  {STATUS_BY_ID[i.status]?.label || i.status}
                </span>
              </button>
            );
          })}
        </Panel>
      </div>
    </PageShell>
  );
}

function StarredView({ projects, starred, onToggleStar, onPickProject }) {
  const starredProjects = projects.filter(p => starred.has(p.id));
  return (
    <PageShell title="Starred" subtitle="Projects you've starred for quick access">
      {starredProjects.length === 0 ? (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 32, textAlign: "center", color: C.text3 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>★</div>
          <div style={{ fontSize: 14, color: C.text, fontWeight: 500, marginBottom: 4 }}>No starred projects yet</div>
          <div style={{ fontSize: 13 }}>Click the star next to a project in the sidebar to pin it here.</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          {starredProjects.map(p => (
            <div key={p.id} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 16, display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={() => onPickProject(p.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0, background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                <span style={{ width: 36, height: 36, borderRadius: 6, background: stringColor(p.key), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff" }}>{p.key.slice(0, 2)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: C.text3 }}>{p.key}</div>
                </span>
              </button>
              <button onClick={() => onToggleStar(p.id)} className="jr-icon-btn" title="Unstar" style={{ color: "#E2A03F" }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.8l1.9 4 4.3.6-3.1 3 .8 4.3L8 11.6 4.1 13.7l.8-4.3-3.1-3 4.3-.6L8 1.8z"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}

function AppsView({ setView, hasProject }) {
  const apps = [
    { id: "dash",     label: "Dashboard", desc: "Overview of your work",          color: "#0052CC" },
    { id: "board",    label: "Board",     desc: "Kanban view of the active project", color: "#5243AA", disabled: !hasProject },
    { id: "backlog",  label: "Backlog",   desc: "Prioritised list of issues",     color: "#00875A", disabled: !hasProject },
    { id: "meetings", label: "Meetings",  desc: "Schedule & email invites",       color: "#E97F33" },
    { id: "recent",   label: "Recent",    desc: "Recently opened items",          color: "#2684FF" },
    { id: "starred",  label: "Starred",   desc: "Your pinned projects",           color: "#E2A03F" },
  ];
  return (
    <PageShell title="Apps" subtitle="Jump to any part of Jiraly">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {apps.map(a => (
          <button key={a.id} onClick={() => !a.disabled && setView(a.id)} disabled={a.disabled}
            style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
              padding: 16, textAlign: "left", cursor: a.disabled ? "not-allowed" : "pointer",
              opacity: a.disabled ? 0.5 : 1, display: "flex", alignItems: "center", gap: 14,
            }}>
            <span style={{ width: 40, height: 40, borderRadius: 8, background: a.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, flexShrink: 0 }}>
              {a.label.slice(0, 1)}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{a.label}</div>
              <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>{a.desc}{a.disabled ? " — pick a project first" : ""}</div>
            </span>
          </button>
        ))}
      </div>
    </PageShell>
  );
}

// ─── Dashboard view ─────────────────────────────────────────────────────────
function Dashboard({ session, onPickProject, onOpenIssue, setView }) {
  const [data, setData] = useState(null);
  const [err, setErr]   = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true); setErr("");
    try { setData(await api.dashboard()); }
    catch (e) { setErr(e.message || "Couldn't load dashboard"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading) return <div style={{ padding: 32, color: C.text3 }}>Loading dashboard…</div>;
  if (err) return (
    <div style={{ padding: 32 }}>
      <div style={{ color: C.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>
      <button onClick={load} className="jr-btn-primary" style={{ padding: "6px 12px", background: C.primary, color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}>Retry</button>
    </div>
  );
  if (!data) return null;

  const { counts = {}, byStatus = {}, byPriority = {}, myOpen = 0, upcomingMeetings = [], myIssues = [], recentIssues = [] } = data;
  const statusLabel = (id) => STATUS_BY_ID[id]?.label || id;
  const totalActive = (counts.issues || 0) - (byStatus.done || 0);

  const statTile = (label, value, accent) => (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 16, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: C.text3, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, color: accent || C.text, marginTop: 6 }}>{value}</div>
    </div>
  );

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (d) => d && d < today;

  return (
    <div style={{ flex: 1, padding: "20px 28px", overflow: "auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: C.text, margin: 0 }}>Dashboard</h1>
          <div style={{ fontSize: 13, color: C.text3, marginTop: 4 }}>Welcome back, {session.name.split(" ")[0]}.</div>
        </div>
        <button onClick={load} className="jr-link-btn" style={{ fontSize: 13 }}>Refresh</button>
      </div>

      {/* Stat tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
        {statTile("Projects", counts.projects ?? 0)}
        {statTile("Active issues", totalActive, C.primary)}
        {statTile("Assigned to me", myOpen, "#5243AA")}
        {statTile("Done", byStatus.done ?? 0, "#00875A")}
        {statTile("Meetings", counts.meetings ?? 0)}
        {statTile("Team members", counts.users ?? 0)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        {/* Status breakdown */}
        <Panel title="Issues by status">
          {STATUSES.map(s => {
            const n = byStatus[s.id] || 0;
            const pct = counts.issues ? Math.round((n / counts.issues) * 100) : 0;
            return (
              <div key={s.id} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.text2, marginBottom: 4 }}>
                  <span>{s.label}</span><span>{n}</span>
                </div>
                <div style={{ height: 6, background: "#F4F5F7", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: s.color }} />
                </div>
              </div>
            );
          })}
          {(counts.issues ?? 0) === 0 && <div style={{ fontSize: 13, color: C.text3 }}>No issues yet.</div>}
        </Panel>

        {/* My work */}
        <Panel title="Assigned to me" subtitle={myIssues.length ? `${myIssues.length} open` : null}>
          {myIssues.length === 0 ? (
            <div style={{ fontSize: 13, color: C.text3 }}>Nothing assigned. ✨</div>
          ) : myIssues.map(i => (
            <button key={i.id} onClick={() => { onPickProject?.(i.projectId); onOpenIssue?.(i.id); }}
              className="jr-dash-row">
              <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 11, color: C.text3, fontWeight: 600, letterSpacing: 0.4 }}>
                  {i.projectKey ? `${i.projectKey} · ` : ""}{i.key}
                </span>
                <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</span>
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 3, background: STATUS_BY_ID[i.status]?.bg || "#F4F5F7", color: STATUS_BY_ID[i.status]?.color || C.text2 }}>
                {statusLabel(i.status)}
              </span>
              {i.dueDate && (
                <span style={{ fontSize: 11, color: isOverdue(i.dueDate) ? C.danger : C.text3, marginLeft: 8 }}>
                  {isOverdue(i.dueDate) ? "Overdue" : i.dueDate}
                </span>
              )}
            </button>
          ))}
        </Panel>

        {/* Upcoming meetings */}
        <Panel title="Upcoming meetings"
          subtitle={upcomingMeetings.length ? `${upcomingMeetings.length} scheduled` : null}
          action={<button onClick={() => setView?.("meetings")} className="jr-link-btn" style={{ fontSize: 12 }}>View all</button>}>
          {upcomingMeetings.length === 0 ? (
            <div style={{ fontSize: 13, color: C.text3 }}>No meetings scheduled.</div>
          ) : upcomingMeetings.map(m => (
            <div key={m.id} className="jr-dash-row" style={{ cursor: "default" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: C.text, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</div>
                <div style={{ fontSize: 11, color: C.text3 }}>{m.date} {m.time && `· ${m.time}`} · {m.host}</div>
              </span>
              <a href={m.meetingUrl} target="_blank" rel="noreferrer"
                className="jr-link-btn" style={{ fontSize: 12 }}>Join</a>
            </div>
          ))}
        </Panel>

        {/* Recent activity */}
        <Panel title="Recent activity">
          {recentIssues.length === 0 ? (
            <div style={{ fontSize: 13, color: C.text3 }}>No activity yet.</div>
          ) : recentIssues.slice(0, 6).map(i => (
            <button key={i.id} onClick={() => { onPickProject?.(i.projectId); onOpenIssue?.(i.id); }}
              className="jr-dash-row">
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.text3, fontWeight: 600 }}>{i.projectKey ? `${i.projectKey} · ` : ""}{i.key}</div>
                <div style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.title}</div>
              </span>
              <span style={{ fontSize: 11, color: C.text3 }}>{(i.updatedAt || "").slice(0, 10)}</span>
            </button>
          ))}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, subtitle, action, children }) {
  return (
    <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
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
    hostEmail:   meeting.hostEmail || session.email,
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
