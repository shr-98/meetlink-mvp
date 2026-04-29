"""SQLite persistence layer for the Jiraly Python backend."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "jiraly.db"
_lock = threading.Lock()


def now_iso() -> str:
    import datetime as _dt
    return _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"


def uid() -> str:
    return uuid.uuid4().hex[:12]


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


# One SQLite connection per thread. Sharing a single connection across Flask's
# threaded request workers can corrupt internal state and segfault the
# interpreter, so we keep them isolated via threading.local.
_local = threading.local()


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = connect()
        _local.conn = conn
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    verified INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key TEXT UNIQUE NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    issue_key TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'task',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee TEXT,
    reporter TEXT,
    due_date TEXT,
    labels TEXT,           -- JSON array
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    host TEXT,
    provider TEXT,
    meeting_url TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    duration INTEGER DEFAULT 30,
    attendees TEXT,        -- JSON array of emails
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""


def init_db() -> None:
    conn = get_conn()
    with _lock:
        conn.executescript(SCHEMA)
        conn.commit()


# ─── helpers ──────────────────────────────────────────────────────────────

def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def issue_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "key": row["issue_key"],
        "title": row["title"],
        "description": row["description"] or "",
        "type": row["type"],
        "status": row["status"],
        "priority": row["priority"],
        "assignee": row["assignee"],
        "reporter": row["reporter"],
        "dueDate": row["due_date"],
        "labels": json.loads(row["labels"]) if row["labels"] else [],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def project_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "key": row["key"],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
    }


def meeting_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"] or "",
        "host": row["host"],
        "provider": row["provider"],
        "meetingUrl": row["meeting_url"],
        "date": row["date"],
        "time": row["time"],
        "duration": row["duration"],
        "attendees": json.loads(row["attendees"]) if row["attendees"] else [],
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def user_to_api(row: sqlite3.Row, *, public: bool = True) -> dict:
    base = {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "role": row["role"],
        "joinedAt": row["joined_at"],
    }
    if not public:
        base["verified"] = bool(row["verified"])
    return base


def comment_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "author": row["author"],
        "body": row["body"],
        "at": row["at"],
    }


# ─── OTP storage ──────────────────────────────────────────────────────────

OTP_TTL_S = 10 * 60


def store_otp(email: str, code: str, purpose: str) -> None:
    conn = get_conn()
    with _lock:
        conn.execute(
            "INSERT INTO otps (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)",
            (email.lower(), code, purpose, int(time.time()) + OTP_TTL_S),
        )
        # Cleanup old/expired
        conn.execute("DELETE FROM otps WHERE expires_at < ? OR used = 1",
                     (int(time.time()) - 86400,))
        conn.commit()


def consume_otp(email: str, code: str, purpose: str) -> bool:
    conn = get_conn()
    with _lock:
        row = conn.execute(
            "SELECT id FROM otps WHERE email = ? AND code = ? AND purpose = ? "
            "AND used = 0 AND expires_at >= ? "
            "ORDER BY id DESC LIMIT 1",
            (email.lower(), code, purpose, int(time.time())),
        ).fetchone()
        if not row:
            return False
        conn.execute("UPDATE otps SET used = 1 WHERE id = ?", (row["id"],))
        conn.commit()
        return True
