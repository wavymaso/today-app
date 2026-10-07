"""SQLite storage: exams, revision sessions, settings and a small cache."""
import json
import sqlite3
from pathlib import Path

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS exams (
    id          INTEGER PRIMARY KEY,
    subject     TEXT NOT NULL,
    date        TEXT NOT NULL,              -- ISO date of the exam
    time        TEXT,                       -- HH:MM, optional
    difficulty  INTEGER NOT NULL DEFAULT 2 CHECK (difficulty BETWEEN 1 AND 3),   -- 1 easy .. 3 hard
    hours       REAL,                       -- your own estimate; otherwise from difficulty
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Planned revision blocks. event_id links to the event added to your calendar.
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY,
    exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    start       TEXT NOT NULL,              -- local ISO datetime
    end         TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'study' CHECK (kind IN ('study', 'review')),
    status      TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'missed')),
    event_id    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start);

-- "Top 3 for today": three things you want to get done, per day.
CREATE TABLE IF NOT EXISTS top3 (
    date        TEXT NOT NULL,              -- ISO date
    position    INTEGER NOT NULL CHECK (position BETWEEN 1 AND 3),
    text        TEXT NOT NULL,
    done        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, position)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Answers from the internet (weather) kept for a while, so the brief opens instantly.
CREATE TABLE IF NOT EXISTS cache (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    fetched_at REAL NOT NULL
);
"""


def db_path() -> Path:
    return config.DB_PATH


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    """FastAPI dependency: one connection per request."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    conn = connect()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def get_setting(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
