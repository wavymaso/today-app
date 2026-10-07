"""Exams, the revision plan, and putting it in your calendar."""
import logging
import re
import sqlite3
from datetime import date as Date
from datetime import datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

import json

from .. import life, planner
from ..calendar_mac import CalendarError, get_calendar
from ..db import get_db, get_setting, set_setting

log = logging.getLogger("today.revision")
router = APIRouter(prefix="/api/revision", tags=["revision"])


def get_settings(db: sqlite3.Connection) -> dict:
    return {**planner.DEFAULTS, "synced": False, **(get_setting(db, "revision") or {})}


def _hm(v: str | None) -> str | None:
    if v is None or v == "":
        return None
    if not re.fullmatch(r"\d{1,2}:\d{2}", v) or not (0 <= int(v.split(":")[0]) < 24 and 0 <= int(v.split(":")[1]) < 60):
        raise ValueError("use HH:MM, like 09:30")
    h, m = v.split(":")
    return f"{int(h):02d}:{m}"


class SettingsIn(BaseModel):
    hours_per_day: float | None = Field(None, gt=0, le=12)
    session_minutes: int | None = Field(None, ge=25, le=240)
    break_minutes: int | None = Field(None, ge=0, le=60)
    earliest: str | None = None
    latest: str | None = None
    days_off: list[int] | None = None
    alert_minutes: int | None = Field(None, ge=0, le=120)

    _times = field_validator("earliest", "latest")(classmethod(lambda cls, v: _hm(v)))

    @field_validator("days_off")
    @classmethod
    def _days(cls, v):
        if v is not None and any(d not in range(7) for d in v):
            raise ValueError("days are 0 (Monday) to 6 (Sunday)")
        return sorted(set(v)) if v is not None else v


class ExamIn(BaseModel):
    subject: str = Field(min_length=1, max_length=60)
    course: str | None = Field(None, max_length=80)
    date: Date
    time: str | None = None
    difficulty: int = Field(2, ge=1, le=3)
    hours: float | None = Field(None, gt=0, le=200)
    notes: str | None = Field(None, max_length=500)

    _time = field_validator("time")(classmethod(lambda cls, v: _hm(v)))


class ExamPatch(BaseModel):
    subject: str | None = Field(None, min_length=1, max_length=60)
    course: str | None = Field(None, max_length=80)
    date: Date | None = None
    time: str | None = None
    difficulty: int | None = Field(None, ge=1, le=3)
    hours: float | None = Field(None, ge=0, le=200)    # 0 clears it (use the difficulty)
    notes: str | None = Field(None, max_length=500)

    _time = field_validator("time")(classmethod(lambda cls, v: _hm(v)))


class SessionPatch(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def _status(cls, v):
        if v not in ("planned", "done", "missed"):
            raise ValueError("status must be planned, done or missed")
        return v


# --- helpers -----------------------------------------------------------------

def _minutes(row) -> int:
    return int((datetime.fromisoformat(row["end"]) - datetime.fromisoformat(row["start"])).total_seconds() // 60)


def _title(subject: str, kind: str) -> str:
    return f"📚 Review: {subject}" if kind == "review" else f"📚 {subject}"


def _add_to_calendar(db: sqlite3.Connection, rows) -> int:
    cal = get_calendar()
    target = cal.revision_calendar()
    set_setting(db, "revision_calendar", target)
    added = 0
    for r in rows:
        try:
            ident = cal.add_event(target["id"], _title(r["subject"], r["kind"]), datetime.fromisoformat(r["start"]),
                                  datetime.fromisoformat(r["end"]), r["id"],
                                  notes=f"Revision for your {r['subject']} exam on {Date.fromisoformat(r['exam_date']):%d/%m}.",
                                  alert_minutes=int(get_settings(db)["alert_minutes"]))
        except CalendarError as exc:
            raise HTTPException(502, str(exc))
        db.execute("UPDATE sessions SET event_id = ? WHERE id = ?", (ident, r["id"]))
        added += 1
    return added


def _future_planned(db: sqlite3.Connection, now: datetime, exam_id: int | None = None):
    sql = ("SELECT s.*, x.subject, x.date AS exam_date FROM sessions s JOIN exams x ON x.id = s.exam_id "
           "WHERE s.status = 'planned' AND s.start >= ?")
    params: list = [now.isoformat(timespec="minutes")]
    if exam_id is not None:
        sql += " AND s.exam_id = ?"
        params.append(exam_id)
    return db.execute(sql + " ORDER BY s.start", params).fetchall()


def _remove(db: sqlite3.Connection, rows) -> None:
    cal = get_calendar()
    for r in rows:
        if r["event_id"]:
            try:
                cal.delete_event(r["event_id"])
            except Exception as exc:
                log.info("Couldn't remove event %s: %s", r["event_id"], exc)
        db.execute("DELETE FROM sessions WHERE id = ?", (r["id"],))


def state(db: sqlite3.Connection, now: datetime | None = None) -> dict:
    now = now or datetime.now()
    settings = get_settings(db)
    exams = []
    for x in db.execute("SELECT * FROM exams ORDER BY date, time").fetchall():
        sess = db.execute("SELECT * FROM sessions WHERE exam_id = ?", (x["id"],)).fetchall()
        done = sum(_minutes(s) for s in sess if s["status"] == "done")
        planned = sum(_minutes(s) for s in sess if s["status"] == "planned" and s["start"] >= now.isoformat(timespec="minutes"))
        target = int((x["hours"] or planner.HOURS_FOR_DIFFICULTY[x["difficulty"]]) * 60)
        exams.append({**dict(x), "target_minutes": target, "done_minutes": done, "planned_minutes": planned,
                      # Within 45 minutes counts as fitting; only warn about real gaps.
                      "short_minutes": short if (short := max(0, target - done - planned)) >= 45 and x["date"] > now.date().isoformat() else 0,
                      "days": (Date.fromisoformat(x["date"]) - now.date()).days})
    since = (now - timedelta(days=7)).isoformat(timespec="minutes")
    sessions = [dict(r) for r in db.execute(
        "SELECT s.*, x.subject FROM sessions s JOIN exams x ON x.id = s.exam_id WHERE s.start >= ? ORDER BY s.start",
        (since,))]
    for s in sessions:
        s["past"] = s["end"] <= now.isoformat(timespec="minutes")
    routines = [_routine_out(r) for r in db.execute("SELECT * FROM routines ORDER BY id")]
    life_events = [dict(r) for r in db.execute(
        "SELECT l.*, r.title, r.location FROM life_events l JOIN routines r ON r.id = l.routine_id WHERE l.start >= ? ORDER BY l.start",
        (now.date().isoformat(),))]
    return {"settings": settings, "exams": exams, "sessions": sessions, "routines": routines, "life": life_events,
            "calendar": get_setting(db, "revision_calendar"),
            "to_check": [s for s in sessions if s["past"] and s["status"] == "planned"]}


# --- life: routines -----------------------------------------------------------------

class RoutineIn(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    kind: str
    minutes: int = Field(60, ge=15, le=480)
    days: list[int] = []
    at: str | None = None
    per_week: int = Field(3, ge=1, le=7)
    part: str = "any"
    location: str | None = Field(None, max_length=80)

    @field_validator("kind")
    @classmethod
    def _kind(cls, v):
        if v not in ("fixed", "flexible"):
            raise ValueError("kind is fixed or flexible")
        return v

    @field_validator("part")
    @classmethod
    def _part(cls, v):
        if v not in life.PARTS:
            raise ValueError("part is morning, afternoon, evening or any")
        return v

    @field_validator("days")
    @classmethod
    def _days(cls, v):
        if any(d not in range(7) for d in v):
            raise ValueError("days are 0 (Monday) to 6 (Sunday)")
        return sorted(set(v))

    @field_validator("at")
    @classmethod
    def _at(cls, v):
        return _hm(v)


def _routine_out(r) -> dict:
    return {**dict(r), "days": json.loads(r["days"])}


def _routines(db: sqlite3.Connection) -> list[life.Routine]:
    return [life.Routine(r["id"], r["title"], r["kind"], r["minutes"], json.loads(r["days"]),
                         time.fromisoformat(r["at"]) if r["at"] else None, r["per_week"], r["part"])
            for r in db.execute("SELECT * FROM routines")]


def _check_routine(body: RoutineIn) -> None:
    if body.kind == "fixed" and (not body.days or not body.at):
        raise HTTPException(422, "Pick the days and the time")


def _future_life(db: sqlite3.Connection, now: datetime, routine_id: int | None = None):
    sql = "SELECT l.*, r.title, r.location FROM life_events l JOIN routines r ON r.id = l.routine_id WHERE l.start >= ?"
    params: list = [now.isoformat(timespec="minutes")]
    if routine_id is not None:
        sql += " AND l.routine_id = ?"
        params.append(routine_id)
    return db.execute(sql + " ORDER BY l.start", params).fetchall()


def _remove_life(db: sqlite3.Connection, rows) -> None:
    cal = get_calendar()
    for r in rows:
        if r["event_id"]:
            try:
                cal.delete_event(r["event_id"])
            except Exception as exc:
                log.info("Couldn't remove event %s: %s", r["event_id"], exc)
        db.execute("DELETE FROM life_events WHERE id = ?", (r["id"],))


def _add_life_to_calendar(db: sqlite3.Connection, rows) -> int:
    if not rows:
        return 0
    cal = get_calendar()
    target = cal.calendar_named(life_calendar_name())
    set_setting(db, "life_calendar", target)
    for r in rows:
        try:
            ident = cal.add_event(target["id"], r["title"], datetime.fromisoformat(r["start"]), datetime.fromisoformat(r["end"]),
                                  r["id"], notes=r["location"] or "", tag=f"today-app:life:{r['id']}")
        except CalendarError as exc:
            raise HTTPException(502, str(exc))
        db.execute("UPDATE life_events SET event_id = ? WHERE id = ?", (ident, r["id"]))
    return len(rows)


def life_calendar_name() -> str:
    from ..calendar_mac import LIFE_CALENDAR
    return LIFE_CALENDAR


@router.post("/routines", status_code=201)
def add_routine(body: RoutineIn, db: sqlite3.Connection = Depends(get_db)):
    _check_routine(body)
    db.execute("INSERT INTO routines (title, kind, minutes, days, at, per_week, part, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               (body.title.strip(), body.kind, body.minutes, json.dumps(body.days), body.at, body.per_week, body.part,
                (body.location or "").strip() or None))
    db.commit()
    return state(db)


@router.put("/routines/{routine_id}")
def update_routine(routine_id: int, body: RoutineIn, db: sqlite3.Connection = Depends(get_db)):
    _check_routine(body)
    if not db.execute("UPDATE routines SET title = ?, kind = ?, minutes = ?, days = ?, at = ?, per_week = ?, part = ?, location = ? WHERE id = ?",
                      (body.title.strip(), body.kind, body.minutes, json.dumps(body.days), body.at, body.per_week, body.part,
                       (body.location or "").strip() or None, routine_id)).rowcount:
        raise HTTPException(404, "Routine not found")
    db.commit()
    return state(db)


@router.delete("/routines/{routine_id}")
def delete_routine(routine_id: int, db: sqlite3.Connection = Depends(get_db)):
    _remove_life(db, _future_life(db, datetime.now(), routine_id))
    if not db.execute("DELETE FROM routines WHERE id = ?", (routine_id,)).rowcount:
        raise HTTPException(404, "Routine not found")
    db.commit()
    return state(db)


# --- endpoints -----------------------------------------------------------------

@router.get("")
def get_state(db: sqlite3.Connection = Depends(get_db)):
    return state(db)


@router.put("/settings")
def update_settings(body: SettingsIn, db: sqlite3.Connection = Depends(get_db)):
    s = get_settings(db)
    s.update(body.model_dump(exclude_none=True))
    if s["earliest"] >= s["latest"]:
        raise HTTPException(422, "The study window must start before it ends")
    set_setting(db, "revision", s)
    db.commit()
    return state(db)


@router.post("/exams", status_code=201)
def add_exam(body: ExamIn, db: sqlite3.Connection = Depends(get_db)):
    db.execute("INSERT INTO exams (subject, course, date, time, difficulty, hours, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
               (body.subject.strip(), (body.course or "").strip() or None, body.date.isoformat(), body.time,
                body.difficulty, body.hours, body.notes))
    db.commit()
    return state(db)


@router.patch("/exams/{exam_id}")
def update_exam(exam_id: int, body: ExamPatch, db: sqlite3.Connection = Depends(get_db)):
    changes = body.model_dump(exclude_unset=True)
    if "date" in changes and changes["date"]:
        changes["date"] = changes["date"].isoformat()
    if changes.get("hours") == 0:
        changes["hours"] = None
    if changes:
        cols = ", ".join(f"{k} = ?" for k in changes)
        if not db.execute(f"UPDATE exams SET {cols} WHERE id = ?", (*changes.values(), exam_id)).rowcount:
            raise HTTPException(404, "Exam not found")
        db.commit()
    return state(db)


@router.delete("/exams/{exam_id}")
def delete_exam(exam_id: int, db: sqlite3.Connection = Depends(get_db)):
    _remove(db, _future_planned(db, datetime.now(), exam_id))
    if not db.execute("DELETE FROM exams WHERE id = ?", (exam_id,)).rowcount:
        raise HTTPException(404, "Exam not found")
    db.commit()
    return state(db)


# --- shared key dates (e.g. a class's exam calendar) ------------------------------

KEY_DATES_DIR = "key-dates"


class KeyDate(BaseModel):
    course: str | None = Field(None, max_length=80)
    subject: str = Field(min_length=1, max_length=60)
    date: Date
    time: str | None = None
    room: str | None = Field(None, max_length=60)
    weight: str | None = Field(None, max_length=60)
    minimum: str | None = Field(None, max_length=20)
    notes: str | None = Field(None, max_length=800)

    @field_validator("time")
    @classmethod
    def _t(cls, v):
        return _hm(v)


class ImportIn(BaseModel):
    items: list[KeyDate] = Field(min_length=1, max_length=200)


def _key_date_notes(k: KeyDate) -> str | None:
    parts = [p for p in (k.weight, f"need at least {k.minimum}" if k.minimum else None, k.room) if p]
    text = ". ".join([", ".join(parts)] if parts else [])
    if k.notes:
        text = f"{text}. {k.notes}" if text else k.notes
    return text[:500] or None


@router.get("/key-dates")
def list_key_dates():
    """Key-date lists that ship with the app (static/key-dates/*.json)."""
    import json
    from .. import config
    out = []
    for f in sorted((config.STATIC_DIR / KEY_DATES_DIR).glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            items = [KeyDate(**i).model_dump(mode="json") for i in data["items"]]
        except Exception as exc:
            log.warning("Skipping key dates %s: %s", f.name, exc)
            continue
        out.append({"id": f.stem, "title": data.get("title", f.stem), "description": data.get("description"),
                    "check": data.get("check"), "updated": data.get("updated"), "items": items})
    return out


@router.post("/import")
def import_key_dates(body: ImportIn, db: sqlite3.Connection = Depends(get_db)):
    """Add key dates as exams. Ones you already have (same name and date) are left alone."""
    existing = {(r["subject"].lower(), r["date"]) for r in db.execute("SELECT subject, date FROM exams")}
    added = skipped = 0
    for k in body.items:
        if (k.subject.lower(), k.date.isoformat()) in existing:
            skipped += 1
            continue
        db.execute("INSERT INTO exams (subject, course, date, time, difficulty, notes) VALUES (?, ?, ?, ?, 2, ?)",
                   (k.subject.strip(), (k.course or "").strip() or None, k.date.isoformat(), k.time, _key_date_notes(k)))
        existing.add((k.subject.lower(), k.date.isoformat()))
        added += 1
    db.commit()
    return {**state(db), "added": added, "skipped": skipped}


@router.post("/plan")
def make_plan(db: sqlite3.Connection = Depends(get_db)):
    """(Re)plan every upcoming session. Done and missed sessions are kept."""
    now = datetime.now()
    settings = get_settings(db)
    # Exams later today still count (an evening quiz can get a morning session).
    exams_rows = db.execute("SELECT * FROM exams WHERE date >= ?", (now.date().isoformat(),)).fetchall()
    routines = _routines(db)
    if not exams_rows and not routines:
        raise HTTPException(422, "Add an exam or a routine first")
    old = _future_planned(db, now)
    _remove(db, old)
    _remove_life(db, _future_life(db, now))

    exams = []
    for x in exams_rows:
        done = sum(_minutes(s) for s in db.execute("SELECT * FROM sessions WHERE exam_id = ? AND status = 'done'", (x["id"],)))
        at = time.fromisoformat(x["time"]) if x["time"] else None
        exams.append(planner.Exam(x["id"], x["subject"], Date.fromisoformat(x["date"]), x["difficulty"], x["hours"], done, at))
    # Life first: routines over the coming weeks (at least four), then revision around them.
    last = max([e.date for e in exams] + [now.date() + timedelta(days=27)])
    busy = [(e["start"], e["end"]) for e in get_calendar().events(now, datetime.combine(last, time(23, 59)))
            if not e["all_day"] and not e["session_id"] and not e.get("ours")]
    for o in life.occurrences(routines, busy, now.date(), last, now, int(settings["break_minutes"])):
        db.execute("INSERT INTO life_events (routine_id, start, end) VALUES (?, ?, ?)",
                   (o.routine_id, o.start.isoformat(timespec="minutes"), o.end.isoformat(timespec="minutes")))
        busy.append((o.start, o.end))
    # Today's sessions already done or missed count as busy too.
    busy += [(datetime.fromisoformat(r["start"]), datetime.fromisoformat(r["end"]))
             for r in db.execute("SELECT * FROM sessions WHERE start >= ?", (now.date().isoformat(),))]
    result = planner.plan(exams, busy, settings, now) if exams else planner.Plan()
    for s in result.sessions:
        db.execute("INSERT INTO sessions (exam_id, start, end, kind) VALUES (?, ?, ?, ?)",
                   (s.exam_id, s.start.isoformat(timespec="minutes"), s.end.isoformat(timespec="minutes"), s.kind))
    if settings["synced"]:
        _add_to_calendar(db, _future_planned(db, now))
        _add_life_to_calendar(db, _future_life(db, now))
    db.commit()
    return {**state(db), "replaced": len(old)}


@router.post("/calendar")
def add_plan_to_calendar(db: sqlite3.Connection = Depends(get_db)):
    now = datetime.now()
    rows = [r for r in _future_planned(db, now) if not r["event_id"]]
    added = _add_to_calendar(db, rows) if rows else 0
    added += _add_life_to_calendar(db, [r for r in _future_life(db, now) if not r["event_id"]])
    s = get_settings(db)
    s["synced"] = True
    set_setting(db, "revision", s)
    db.commit()
    return {**state(db), "added": added}


@router.delete("/calendar")
def remove_plan_from_calendar(db: sqlite3.Connection = Depends(get_db)):
    """Take upcoming sessions out of your calendar (the plan stays here)."""
    cal = get_calendar()
    removed = 0
    for r in _future_planned(db, datetime.now()):
        if r["event_id"]:
            if cal.delete_event(r["event_id"]):
                removed += 1
            db.execute("UPDATE sessions SET event_id = NULL WHERE id = ?", (r["id"],))
    for r in _future_life(db, datetime.now()):
        if r["event_id"]:
            if cal.delete_event(r["event_id"]):
                removed += 1
            db.execute("UPDATE life_events SET event_id = NULL WHERE id = ?", (r["id"],))
    s = get_settings(db)
    s["synced"] = False
    set_setting(db, "revision", s)
    db.commit()
    return {**state(db), "removed": removed}


@router.patch("/sessions/{session_id}")
def update_session(session_id: int, body: SessionPatch, db: sqlite3.Connection = Depends(get_db)):
    if not db.execute("UPDATE sessions SET status = ? WHERE id = ?", (body.status, session_id)).rowcount:
        raise HTTPException(404, "Session not found")
    db.commit()
    return state(db)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: int, db: sqlite3.Connection = Depends(get_db)):
    row = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    _remove(db, [row])
    db.commit()
    return Response(status_code=204)
