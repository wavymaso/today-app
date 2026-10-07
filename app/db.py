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

-- Life outside studying: routines (gym, football...) and their planned times.
CREATE TABLE IF NOT EXISTS routines (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('fixed', 'flexible')),
    minutes     INTEGER NOT NULL,
    days        TEXT NOT NULL DEFAULT '[]',   -- fixed: JSON weekdays, 0 = Monday
    at          TEXT,                         -- fixed: HH:MM
    per_week    INTEGER NOT NULL DEFAULT 3,   -- flexible
    part        TEXT NOT NULL DEFAULT 'any',  -- flexible: morning | afternoon | evening | any
    location    TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS life_events (
    id          INTEGER PRIMARY KEY,
    routine_id  INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    start       TEXT NOT NULL,
    end         TEXT NOT NULL,
    event_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_life_start ON life_events(start);

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
        _upgrade(conn)
        conn.commit()
    finally:
        conn.close()


def _upgrade(conn: sqlite3.Connection) -> None:
    """Columns newer versions need, added to a database made by an older one."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(exams)")}
    if "course" not in cols:
        conn.execute("ALTER TABLE exams ADD COLUMN course TEXT")   # e.g. "Algorithms & Data Structures"
        _fill_courses(conn)


def _fill_courses(conn: sqlite3.Connection) -> None:
    """Exams added before courses existed: take the course from a bundled key-dates
    list when the name and date match."""
    for f in (config.STATIC_DIR / "key-dates").glob("*.json"):
        try:
            items = json.loads(f.read_text(encoding="utf-8"))["items"]
        except Exception:
            continue
        for i in items:
            if i.get("course"):
                conn.execute("UPDATE exams SET course = ? WHERE course IS NULL AND lower(subject) = lower(?) AND date = ?",
                             (i["course"], i["subject"], i["date"]))


def get_setting(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
