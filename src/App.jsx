import { useState, useEffect, useMemo } from "react";

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
const KEYS = { USERS: "ml:users", SESSION: "ml:session", MEETINGS: "ml:meetings" };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const pwHash = (s) => { let h = 0; for (let c of s) h = Math.imul(31, h) + c.charCodeAt(0) | 0; return h.toString(36); };
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const TAGS = ["Engineering","Design","Product","HR","Marketing","Sales","All Hands","1:1","Sprint","Review","Workshop","Interview"];

// ─── Design tokens (amber brand on top of CSS vars) ───────────────────────────
const A = { 50: "#FAEEDA", 100: "#FAC775", 400: "#EF9F27", 600: "#BA7517", 800: "#633806" };
const F = {
  sans: "'IBM Plex Sans', var(--font-sans, sans-serif)",
  mono: "'IBM Plex Mono', var(--font-mono, monospace)",
  serif: "'Playfair Display', var(--font-serif, serif)",
};
const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=IBM+Plex+Sans:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');`;

// ─── Root ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [ready, setReady]           = useState(false);
  const [session, setSession]       = useState(null);
  const [meetings, setMeetings]     = useState([]);
  const [view, setView]             = useState("list");
  const [editing, setEditing]       = useState(null);
  const [search, setSearch]         = useState("");
  const [activeTags, setActiveTags] = useState([]);
  const [dateFilter, setDate]       = useState("");
  const [toast, setToast]           = useState(null);

  useEffect(() => {
    (async () => {
      const [sess, meets] = await Promise.all([db.get(KEYS.SESSION), db.get(KEYS.MEETINGS)]);
      if (sess) setSession(sess);
      if (meets) setMeetings(meets);
      setReady(true);
    })();
  }, []);

  const flash = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  const login = async (sess) => { setSession(sess); await db.set(KEYS.SESSION, sess); };
  const logout = async () => { setSession(null); await db.set(KEYS.SESSION, null); };

  const saveMeetings = async (list) => { setMeetings(list); await db.set(KEYS.MEETINGS, list); };

  const handleSave = async (m) => {
    const list = editing
      ? meetings.map(x => x.id === m.id ? m : x)
      : [...meetings, { ...m, id: uid(), createdBy: session.email, createdAt: new Date().toISOString() }];
    await saveMeetings(list);
    setView("list"); setEditing(null);
    flash(editing ? "Meeting updated" : "Meeting created");
  };

  const handleDelete = async (id) => {
    await saveMeetings(meetings.filter(m => m.id !== id));
    flash("Meeting removed", "danger");
  };

  const copyLink = (meeting) => {
    const payload = btoa(unescape(encodeURIComponent(JSON.stringify(meeting))));
    const url = `${window.location.origin}${window.location.pathname}?ml=${payload}`;
    navigator.clipboard.writeText(url).then(() => flash("Shareable link copied!"));
  };

  const filtered = useMemo(() => meetings
    .filter(m => {
      const q = search.toLowerCase();
      const s = !search || [m.title, m.host, m.description].some(v => (v || "").toLowerCase().includes(q));
      const t = activeTags.length === 0 || activeTags.some(tag => (m.tags || []).includes(tag));
      const d = !dateFilter || m.date === dateFilter;
      return s && t && d;
    })
    .sort((a, b) => new Date(`${a.date}T${a.time}`) - new Date(`${b.date}T${b.time}`)),
  [meetings, search, activeTags, dateFilter]);

  if (!ready) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300, fontFamily: F.sans, color: "var(--color-text-secondary)", fontSize: 14 }}>
      Loading…
    </div>
  );
  if (!session) return <AuthScreen onLogin={login} />;
  if (view === "editor") return (
    <MeetingEditor meeting={editing} session={session} onSave={handleSave} onCancel={() => { setView("list"); setEditing(null); }} />
  );
  return (
    <Dashboard
      meetings={filtered} total={meetings.length} session={session} toast={toast}
      search={search} setSearch={setSearch}
      activeTags={activeTags} setActiveTags={setActiveTags}
      dateFilter={dateFilter} setDate={setDate}
      onNew={() => { setEditing(null); setView("editor"); }}
      onEdit={m => { setEditing(m); setView("editor"); }}
      onDelete={handleDelete} onCopy={copyLink} onLogout={logout}
    />
  );
}

// ─── AuthScreen ───────────────────────────────────────────────────────────────
function AuthScreen({ onLogin }) {
  const [tab, setTab]         = useState("login");
  const [name, setName]       = useState("");
  const [email, setEmail]     = useState("");
  const [pass, setPass]       = useState("");
  const [err, setErr]         = useState("");
  const [busy, setBusy]       = useState(false);

  const submit = async () => {
    setErr(""); setBusy(true);
    const users = await db.get(KEYS.USERS) || [];
    if (tab === "signup") {
      if (!name.trim() || !email.trim() || !pass) { setErr("All fields are required"); setBusy(false); return; }
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { setErr("Enter a valid work email"); setBusy(false); return; }
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) { setErr("Email already registered"); setBusy(false); return; }
      const user = { id: uid(), name: name.trim(), email: email.toLowerCase().trim(), ph: pwHash(pass), role: users.length === 0 ? "admin" : "member", joinedAt: new Date().toISOString() };
      await db.set(KEYS.USERS, [...users, user]);
      const { ph, ...sess } = user;
      onLogin(sess);
    } else {
      if (!email || !pass) { setErr("Email and password required"); setBusy(false); return; }
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.ph === pwHash(pass));
      if (!user) { setErr("Invalid email or password"); setBusy(false); return; }
      const { ph, ...sess } = user;
      onLogin(sess);
    }
    setBusy(false);
  };

  return (
    <>
      <style>{FONTS}</style>
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem", fontFamily: F.sans, background: "var(--color-background-tertiary)" }}>
        <div style={{ width: "100%", maxWidth: 400 }}>
          <div style={{ textAlign: "center", marginBottom: "2rem" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <Logo size={32} />
              <span style={{ fontFamily: F.serif, fontSize: 24, color: "var(--color-text-primary)", letterSpacing: "-0.5px" }}>MeetLink</span>
            </div>
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: 0 }}>Your team's meeting hub</p>
          </div>

          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1.5rem" }}>
            <div style={{ display: "flex", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: 3, marginBottom: "1.5rem", gap: 0 }}>
              {[["login","Sign in"],["signup","Create account"]].map(([t, label]) => (
                <button key={t} onClick={() => { setTab(t); setErr(""); }}
                  style={{ flex: 1, padding: "7px 0", border: "none", borderRadius: 6, cursor: "pointer", fontFamily: F.sans, fontSize: 13, fontWeight: 500, transition: "all 0.15s",
                    background: tab === t ? "var(--color-background-primary)" : "transparent",
                    color: tab === t ? "var(--color-text-primary)" : "var(--color-text-secondary)" }}>
                  {label}
                </button>
              ))}
            </div>

            {tab === "signup" && <AField label="Full name" value={name} onChange={setName} placeholder="Jane Smith" />}
            <AField label="Work email" value={email} onChange={setEmail} placeholder="jane@company.com" type="email" />
            <AField label="Password" value={pass} onChange={setPass} placeholder="Min. 8 characters" type="password" onKeyDown={e => e.key === "Enter" && submit()} />

            {err && <div style={{ fontSize: 13, color: "var(--color-text-danger)", background: "var(--color-background-danger)", padding: "8px 12px", borderRadius: "var(--border-radius-md)", marginBottom: "1rem", lineHeight: 1.4 }}>{err}</div>}

            <button onClick={submit} disabled={busy}
              style={{ width: "100%", padding: "10px 0", background: A[400], border: "none", borderRadius: "var(--border-radius-md)", color: "#fff", fontWeight: 600, fontSize: 14, cursor: "pointer", fontFamily: F.sans, opacity: busy ? 0.7 : 1 }}>
              {tab === "login" ? "Sign in" : "Create account"}
            </button>

            <p style={{ textAlign: "center", marginTop: "1rem", fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 0 }}>
              {tab === "login" ? "No account? " : "Already have one? "}
              <span onClick={() => { setTab(tab === "login" ? "signup" : "login"); setErr(""); }} style={{ color: A[600], cursor: "pointer", fontWeight: 500 }}>
                {tab === "login" ? "Sign up free" : "Sign in"}
              </span>
            </p>
          </div>

          <p style={{ textAlign: "center", marginTop: "1rem", fontSize: 11, color: "var(--color-text-tertiary)", fontFamily: F.mono }}>
            MVP · All data stored in this browser session
          </p>
        </div>
      </div>
    </>
  );
}

function AField({ label, value, onChange, placeholder, type = "text", onKeyDown }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</label>
      <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        style={{ width: "100%", padding: "9px 12px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-primary)", fontSize: 14, fontFamily: F.sans }} />
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ meetings, total, session, toast, search, setSearch, activeTags, setActiveTags, dateFilter, setDate, onNew, onEdit, onDelete, onCopy, onLogout }) {
  const now = new Date();
  const upcoming = meetings.filter(m => new Date(`${m.date}T${m.time}`) >= now).length;
  const hasFilters = search || activeTags.length > 0 || dateFilter;
  const clearAll = () => { setSearch(""); setActiveTags([]); setDate(""); };

  return (
    <>
      <style>{FONTS}</style>
      <div style={{ fontFamily: F.sans, minHeight: "100vh", background: "var(--color-background-tertiary)" }}>

        {/* Toast notification */}
        {toast && (
          <div style={{ position: "fixed", top: 16, right: 16, zIndex: 999, padding: "10px 16px", borderRadius: "var(--border-radius-md)", fontSize: 13, fontWeight: 500, fontFamily: F.sans, pointerEvents: "none",
            background: toast.type === "danger" ? "var(--color-background-danger)" : "var(--color-background-success)",
            color: toast.type === "danger" ? "var(--color-text-danger)" : "var(--color-text-success)",
            border: `0.5px solid ${toast.type === "danger" ? "var(--color-border-danger)" : "var(--color-border-success)"}` }}>
            {toast.msg}
          </div>
        )}

        {/* Header */}
        <header style={{ background: "var(--color-background-primary)", borderBottom: "0.5px solid var(--color-border-tertiary)", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Logo size={28} />
            <span style={{ fontFamily: F.serif, fontSize: 19, color: "var(--color-text-primary)" }}>MeetLink</span>
            <span style={{ fontSize: 10, background: A[50], color: A[800], padding: "2px 7px", borderRadius: 4, fontFamily: F.mono, fontWeight: 500 }}>MVP</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
              {session.name}
              <span style={{ marginLeft: 6, fontSize: 10, background: A[50], color: A[800], padding: "2px 7px", borderRadius: 4, fontFamily: F.mono }}>{session.role}</span>
            </div>
            <button onClick={onNew} style={{ padding: "7px 14px", background: A[400], border: "none", borderRadius: "var(--border-radius-md)", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: F.sans }}>
              + New meeting
            </button>
            <button onClick={onLogout} style={{ padding: "7px 12px", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontFamily: F.sans }}>
              Sign out
            </button>
          </div>
        </header>

        <div style={{ maxWidth: 920, margin: "0 auto", padding: "24px" }}>

          {/* Stats row */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
            {[
              { label: "Total meetings", val: total, color: A[600] },
              { label: "Upcoming", val: upcoming, color: "var(--color-text-success)" },
              { label: "Showing", val: meetings.length, color: "var(--color-text-secondary)" },
            ].map(s => (
              <div key={s.label} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "1rem" }}>
                <div style={{ fontSize: 28, fontWeight: 500, color: s.color, fontFamily: F.mono, lineHeight: 1 }}>{s.val}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 5, textTransform: "uppercase", letterSpacing: "0.5px" }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Filter panel */}
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1rem 1.25rem", marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1, position: "relative" }}>
                <svg style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="6.5" cy="6.5" r="5" stroke="var(--color-text-tertiary)" strokeWidth="1.5"/>
                  <path d="M10.5 10.5l3 3" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title, host, or description…"
                  style={{ width: "100%", padding: "8px 10px 8px 30px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-primary)", fontSize: 13, fontFamily: F.sans }} />
              </div>
              <input type="date" value={dateFilter} onChange={e => setDate(e.target.value)}
                style={{ padding: "8px 10px", background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", color: dateFilter ? "var(--color-text-primary)" : "var(--color-text-tertiary)", fontSize: 13, fontFamily: F.sans, colorScheme: "auto" }} />
              {hasFilters && (
                <button onClick={clearAll} style={{ padding: "8px 12px", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", fontFamily: F.sans }}>
                  Clear
                </button>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {TAGS.map(tag => {
                const on = activeTags.includes(tag);
                return (
                  <button key={tag} onClick={() => setActiveTags(on ? activeTags.filter(t => t !== tag) : [...activeTags, tag])}
                    style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer", fontFamily: F.sans, fontWeight: 500, transition: "all 0.12s",
                      border: on ? `1.5px solid ${A[400]}` : "0.5px solid var(--color-border-secondary)",
                      background: on ? A[50] : "transparent",
                      color: on ? A[800] : "var(--color-text-secondary)" }}>
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Meeting list */}
          {meetings.length === 0 ? (
            <Empty hasFilters={hasFilters} onNew={onNew} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {meetings.map(m => (
                <MeetingCard key={m.id} meeting={m} session={session} onEdit={onEdit} onDelete={onDelete} onCopy={onCopy} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Empty({ hasFilters, onNew }) {
  return (
    <div style={{ textAlign: "center", padding: "64px 0", color: "var(--color-text-secondary)" }}>
      <div style={{ margin: "0 auto 16px", width: 48, height: 48, borderRadius: "50%", background: "var(--color-background-secondary)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="3" y="3" width="16" height="16" rx="2" stroke="var(--color-text-tertiary)" strokeWidth="1.5"/>
          <line x1="7" y1="9" x2="15" y2="9" stroke="var(--color-text-tertiary)" strokeWidth="1.3" strokeLinecap="round"/>
          <line x1="7" y1="13" x2="12" y2="13" stroke="var(--color-text-tertiary)" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </div>
      <p style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>
        {hasFilters ? "No meetings match your filters" : "No meetings yet"}
      </p>
      <p style={{ fontSize: 13, marginBottom: hasFilters ? 0 : "1rem" }}>
        {hasFilters ? "Try adjusting or clearing your search" : "Create a meeting link to share with your team"}
      </p>
      {!hasFilters && (
        <button onClick={onNew} style={{ padding: "8px 18px", background: A[400], border: "none", borderRadius: "var(--border-radius-md)", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: F.sans }}>
          + Create first meeting
        </button>
      )}
    </div>
  );
}

// ─── MeetingCard ──────────────────────────────────────────────────────────────
function MeetingCard({ meeting, session, onEdit, onDelete, onCopy }) {
  const [copied, setCopied]     = useState(false);
  const [confirm, setConfirm]   = useState(false);

  const dt     = new Date(`${meeting.date}T${meeting.time}`);
  const isPast = dt < new Date();
  const isToday = meeting.date === new Date().toISOString().slice(0, 10);
  const dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const canEdit = session.role === "admin" || meeting.createdBy === session.email;

  const handleCopy = () => {
    onCopy(meeting); setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const accent = isToday ? A[400] : isPast ? "var(--color-border-tertiary)" : "var(--color-border-info)";

  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1rem 1.25rem", borderLeft: `3px solid ${accent}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)" }}>{meeting.title}</span>
            {isToday && <Pill label="Today" bg={A[50]} color={A[800]} />}
            {isPast && <Pill label="Past" bg="var(--color-background-secondary)" color="var(--color-text-tertiary)" />}
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--color-text-secondary)", marginBottom: meeting.description ? 6 : 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: F.mono }}>{dateStr} · {timeStr}</span>
            <span>Host: {meeting.host}</span>
            {meeting.department && <span>{meeting.department}</span>}
          </div>
          {meeting.description && (
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: "0 0 8px", lineHeight: 1.5 }}>{meeting.description}</p>
          )}
          {(meeting.tags || []).length > 0 && (
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {meeting.tags.map(t => <Pill key={t} label={t} bg={A[50]} color={A[800]} />)}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <a href={meeting.meetingUrl} target="_blank" rel="noopener noreferrer"
            style={{ padding: "6px 12px", background: "var(--color-background-info)", border: "none", borderRadius: "var(--border-radius-md)", color: "var(--color-text-info)", fontSize: 12, fontWeight: 500, textDecoration: "none", display: "inline-block" }}>
            Join ↗
          </a>
          <button onClick={handleCopy}
            style={{ padding: "6px 12px", background: copied ? "var(--color-background-success)" : "var(--color-background-secondary)", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: copied ? "var(--color-text-success)" : "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontFamily: F.sans, fontWeight: copied ? 500 : 400 }}>
            {copied ? "Copied!" : "Copy link"}
          </button>
          {canEdit && (
            <>
              <button onClick={() => onEdit(meeting)}
                style={{ padding: "6px 10px", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-secondary)", fontSize: 12, cursor: "pointer", fontFamily: F.sans }}>
                Edit
              </button>
              {confirm ? (
                <button onClick={() => { onDelete(meeting.id); setConfirm(false); }}
                  style={{ padding: "6px 10px", background: "var(--color-background-danger)", border: "none", borderRadius: "var(--border-radius-md)", color: "var(--color-text-danger)", fontSize: 12, cursor: "pointer", fontFamily: F.sans, fontWeight: 500 }}>
                  Confirm?
                </button>
              ) : (
                <button onClick={() => setConfirm(true)}
                  style={{ padding: "6px 10px", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-tertiary)", fontSize: 12, cursor: "pointer", fontFamily: F.sans }}>
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── MeetingEditor ────────────────────────────────────────────────────────────
function MeetingEditor({ meeting, session, onSave, onCancel }) {
  const [form, setForm] = useState({
    id:          meeting?.id || null,
    title:       meeting?.title || "",
    date:        meeting?.date || "",
    time:        meeting?.time || "",
    host:        meeting?.host || session.name,
    department:  meeting?.department || "",
    meetingUrl:  meeting?.meetingUrl || "",
    description: meeting?.description || "",
    tags:        meeting?.tags || [],
  });
  const [errors, setErrors] = useState({});

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const validate = () => {
    const e = {};
    if (!form.title.trim())      e.title = "Title is required";
    if (!form.date)              e.date = "Date is required";
    if (!form.time)              e.time = "Time is required";
    if (!form.host.trim())       e.host = "Host name is required";
    if (!form.meetingUrl.trim()) e.meetingUrl = "Meeting URL is required";
    else if (!/^https?:\/\/.+/.test(form.meetingUrl)) e.meetingUrl = "Must start with https://";
    return e;
  };

  const submit = () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    onSave(form);
  };

  return (
    <>
      <style>{FONTS}</style>
      <div style={{ fontFamily: F.sans, minHeight: "100vh", background: "var(--color-background-tertiary)" }}>
        <header style={{ background: "var(--color-background-primary)", borderBottom: "0.5px solid var(--color-border-tertiary)", padding: "12px 24px", display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={onCancel} style={{ padding: "7px 12px", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontFamily: F.sans }}>
            ← Back
          </button>
          <span style={{ fontFamily: F.serif, fontSize: 19, color: "var(--color-text-primary)" }}>
            {meeting ? "Edit meeting" : "New meeting"}
          </span>
        </header>

        <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 24px" }}>
          <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1.5rem" }}>

            <EField label="Meeting title *" error={errors.title}>
              <input value={form.title} onChange={e => set("title", e.target.value)} placeholder="Q3 All Hands · Weekly Design Review…"
                style={inp(errors.title)} />
            </EField>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <EField label="Date *" error={errors.date}>
                <input type="date" value={form.date} onChange={e => set("date", e.target.value)} style={{ ...inp(errors.date), colorScheme: "auto" }} />
              </EField>
              <EField label="Time *" error={errors.time}>
                <input type="time" value={form.time} onChange={e => set("time", e.target.value)} style={{ ...inp(errors.time), colorScheme: "auto" }} />
              </EField>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <EField label="Host *" error={errors.host}>
                <input value={form.host} onChange={e => set("host", e.target.value)} placeholder="Host name" style={inp(errors.host)} />
              </EField>
              <EField label="Department">
                <input value={form.department} onChange={e => set("department", e.target.value)} placeholder="Engineering, Design…" style={inp()} />
              </EField>
            </div>

            <EField label="Meeting URL *" error={errors.meetingUrl}>
              <input value={form.meetingUrl} onChange={e => set("meetingUrl", e.target.value)} placeholder="https://zoom.us/j/... or https://meet.google.com/..."
                style={{ ...inp(errors.meetingUrl), fontFamily: F.mono, fontSize: 13 }} />
            </EField>

            <EField label="Description">
              <textarea value={form.description} onChange={e => set("description", e.target.value)} placeholder="Agenda, context, or notes for attendees…" rows={3}
                style={{ ...inp(), resize: "vertical" }} />
            </EField>

            <EField label="Tags">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {TAGS.map(tag => {
                  const on = form.tags.includes(tag);
                  return (
                    <button key={tag} type="button" onClick={() => set("tags", on ? form.tags.filter(t => t !== tag) : [...form.tags, tag])}
                      style={{ padding: "4px 10px", borderRadius: 20, fontSize: 12, cursor: "pointer", fontFamily: F.sans,
                        border: on ? `1.5px solid ${A[400]}` : "0.5px solid var(--color-border-secondary)",
                        background: on ? A[50] : "transparent",
                        color: on ? A[800] : "var(--color-text-secondary)" }}>
                      {tag}
                    </button>
                  );
                })}
              </div>
            </EField>

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: "1.5rem", paddingTop: "1rem", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
              <button onClick={onCancel} style={{ padding: "9px 18px", background: "transparent", border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)", color: "var(--color-text-secondary)", fontSize: 13, cursor: "pointer", fontFamily: F.sans }}>
                Cancel
              </button>
              <button onClick={submit} style={{ padding: "9px 22px", background: A[400], border: "none", borderRadius: "var(--border-radius-md)", color: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: F.sans }}>
                {meeting ? "Save changes" : "Create meeting"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function EField({ label, children, error }) {
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</label>
      {children}
      {error && <p style={{ fontSize: 12, color: "var(--color-text-danger)", marginTop: 4, marginBottom: 0 }}>{error}</p>}
    </div>
  );
}

// Shared input style factory
const inp = (err) => ({
  width: "100%", padding: "9px 12px",
  background: "var(--color-background-secondary)",
  border: `0.5px solid ${err ? "var(--color-border-danger)" : "var(--color-border-secondary)"}`,
  borderRadius: "var(--border-radius-md)",
  color: "var(--color-text-primary)",
  fontSize: 14, fontFamily: F.sans,
});

// ─── Shared primitives ────────────────────────────────────────────────────────
function Logo({ size = 28 }) {
  const r = Math.round(size * 0.22);
  return (
    <div style={{ width: size, height: size, background: A[400], borderRadius: r, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="#fff" strokeWidth="1.5"/>
        <line x1="5" y1="6.5" x2="11" y2="6.5" stroke="#fff" strokeWidth="1.3" strokeLinecap="round"/>
        <line x1="5" y1="10" x2="9" y2="10" stroke="#fff" strokeWidth="1.3" strokeLinecap="round"/>
      </svg>
    </div>
  );
}

function Pill({ label, bg, color }) {
  return (
    <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 4, background: bg, color, fontFamily: F.mono, fontWeight: 500, display: "inline-block" }}>
      {label}
    </span>
  );
}
