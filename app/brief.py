"""Everything on the morning screen, gathered in one go.

Each part is fetched on its own and fails on its own: no internet still shows
your calendar, and a Gmail problem never hides the weather.
"""
from __future__ import annotations

import logging
import re
import sqlite3
from datetime import date, datetime, time, timedelta

from . import budget_link, mail, weather
from .calendar_mac import get_calendar
from .db import get_setting

log = logging.getLogger("today.brief")

DAY_START, DAY_END = time(8, 0), time(22, 0)
MIN_FREE_MINUTES = 45
LOOKAHEAD_DAYS = 14
DEADLINE_WORDS = re.compile(
    r"\b(exam|examen|ex[aá]menes|midterm|final|parcial|quiz|test|entrega|deadline|due|"
    r"presentation|presentaci[oó]n|assignment|pr[aá]ctica|essay|trabajo|defensa|submission)\b", re.I)


def get_prefs(conn: sqlite3.Connection) -> dict:
    return {"name": "", "place": weather.DEFAULT_PLACE, "hidden_calendars": [],
            **(get_setting(conn, "prefs") or {})}


def greeting(now: datetime, name: str) -> str:
    part = "morning" if now.hour < 12 else "afternoon" if now.hour < 19 else "evening"
    return f"Good {part}{', ' + name if name else ''}"


def _safe(label: str, fn):
    try:
        return fn()
    except Exception as exc:
        log.info("%s unavailable: %s", label, exc)
        return {"error": str(exc) or f"{label} isn't available"}


def _visible(cal, start: datetime, end: datetime, hidden: list[str]) -> list[dict]:
    return [e for e in cal.events(start, end) if e["calendar_id"] not in hidden]


def free_slots(events: list[dict], day: date, after: datetime | None = None,
               start: time = DAY_START, end: time = DAY_END, min_minutes: int = MIN_FREE_MINUTES) -> list[dict]:
    """Gaps of at least `min_minutes` between timed events, within the day's waking hours."""
    cursor = datetime.combine(day, start)
    if after and after > cursor:
        cursor = after.replace(second=0, microsecond=0)
    stop = datetime.combine(day, end)
    gaps = []
    for e in sorted((e for e in events if not e["all_day"]), key=lambda e: e["start"]):
        if e["start"] > cursor and (e["start"] - cursor).total_seconds() >= min_minutes * 60:
            gaps.append({"start": cursor, "end": min(e["start"], stop)})
        cursor = max(cursor, e["end"])
        if cursor >= stop:
            break
    if stop > cursor and (stop - cursor).total_seconds() >= min_minutes * 60:
        gaps.append({"start": cursor, "end": stop})
    return [g for g in gaps if g["end"] > g["start"]]


def _iso(d: datetime | None) -> str | None:
    return d.isoformat(timespec="minutes") if d else None


def _event_out(e: dict, now: datetime) -> dict:
    return {**{k: e[k] for k in ("id", "title", "all_day", "location", "calendar", "color", "session_id")},
            "start": _iso(e["start"]), "end": _iso(e["end"]),
            "past": not e["all_day"] and e["end"] <= now,
            "now": not e["all_day"] and e["start"] <= now < e["end"]}


def coming_up(conn: sqlite3.Connection, cal, now: datetime, hidden: list[str]) -> list[dict]:
    """Exams you entered plus calendar events that look like deadlines, for the next two weeks."""
    today = now.date()
    horizon = today + timedelta(days=LOOKAHEAD_DAYS)
    items = []
    exams = conn.execute("SELECT * FROM exams WHERE date BETWEEN ? AND ? ORDER BY date",
                         (today.isoformat(), horizon.isoformat())).fetchall()
    for x in exams:
        d = date.fromisoformat(x["date"])
        items.append({"title": f"{x['subject']} exam", "date": x["date"], "time": x["time"], "days": (d - today).days,
                      "kind": "exam", "exam_id": x["id"]})
    exam_keys = {(x["subject"].lower(), x["date"]) for x in exams}
    events = _visible(cal, datetime.combine(today, time()), datetime.combine(horizon + timedelta(days=1), time()), hidden)
    for e in events:
        if e["session_id"] or not DEADLINE_WORDS.search(e["title"]):
            continue
        d = e["start"].date()
        if any(subj in e["title"].lower() and day == d.isoformat() for subj, day in exam_keys):
            continue   # already listed as an exam you entered
        items.append({"title": e["title"], "date": d.isoformat(), "time": None if e["all_day"] else e["start"].strftime("%H:%M"),
                      "days": (d - today).days, "kind": "calendar", "color": e["color"]})
    return sorted(items, key=lambda i: (i["date"], i["time"] or ""))


def reminders(cal, now: datetime) -> list[dict]:
    """Due today or tomorrow, plus overdue from the last week (not ancient ones)."""
    today = now.date()
    until = datetime.combine(today + timedelta(days=2), time())
    since = datetime.combine(today - timedelta(days=7), time())
    out = []
    for r in cal.reminders(until):
        if r["due"] is None or r["due"] < since:
            continue
        out.append({"id": r["id"], "title": r["title"], "list": r["list"], "color": r["color"],
                    "due": _iso(r["due"]), "overdue": r["due"].date() < today,
                    "when": "today" if r["due"].date() == today else "tomorrow" if r["due"].date() > today else "overdue"})
    return out


def build(conn: sqlite3.Connection, now: datetime | None = None) -> dict:
    now = now or datetime.now()
    prefs = get_prefs(conn)
    cal = get_calendar()
    hidden = prefs["hidden_calendars"]
    today = now.date()

    def day():
        start = datetime.combine(today, time())
        evs = _visible(cal, start, start + timedelta(days=1), hidden)
        tomorrow = [e for e in _visible(cal, start + timedelta(days=1), start + timedelta(days=2), hidden) if not e["all_day"]]
        return {
            "events": [_event_out(e, now) for e in evs],
            "free": [{"start": _iso(g["start"]), "end": _iso(g["end"]),
                      "minutes": int((g["end"] - g["start"]).total_seconds() // 60)}
                     for g in free_slots(evs, today, after=now)],
            "tomorrow_first": _event_out(tomorrow[0], now) if tomorrow else None,
        }

    access = cal.status("event")
    return {
        "now": _iso(now),
        "greeting": greeting(now, prefs["name"]),
        "calendar_access": access,
        "weather": _safe("Weather", lambda: weather.get(conn, prefs["place"], now)),
        "day": _safe("Calendar", day) if access == "granted" else {"error": "no_access"},
        "coming_up": _safe("Coming up", lambda: coming_up(conn, cal, now, hidden)) if access == "granted" else [],
        "reminders": _safe("Reminders", lambda: reminders(cal, now)),
        "email": _safe("Email", lambda: mail.get(conn, now)),
        "budget": _safe("Budget", lambda: budget_link.get(today)),
    }
