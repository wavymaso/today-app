"""Exams, the revision plan, and putting it in your calendar."""
import logging
import re
import sqlite3
from datetime import date as Date
from datetime import datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from .. import planner
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
    date: Date
    time: str | None = None
    difficulty: int = Field(2, ge=1, le=3)
    hours: float | None = Field(None, gt=0, le=200)
    notes: str | None = Field(None, max_length=500)

    _time = field_validator("time")(classmethod(lambda cls, v: _hm(v)))


class ExamPatch(BaseModel):
    subject: str | None = Field(None, min_length=1, max_length=60)
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
    return {"settings": settings, "exams": exams, "sessions": sessions,
            "calendar": get_setting(db, "revision_calendar"),
            "to_check": [s for s in sessions if s["past"] and s["status"] == "planned"]}


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
    db.execute("INSERT INTO exams (subject, date, time, difficulty, hours, notes) VALUES (?, ?, ?, ?, ?, ?)",
               (body.subject.strip(), body.date.isoformat(), body.time, body.difficulty, body.hours, body.notes))
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


@router.post("/plan")
def make_plan(db: sqlite3.Connection = Depends(get_db)):
    """(Re)plan every upcoming session. Done and missed sessions are kept."""
    now = datetime.now()
    settings = get_settings(db)
    exams_rows = db.execute("SELECT * FROM exams WHERE date > ?", (now.date().isoformat(),)).fetchall()
    if not exams_rows:
        raise HTTPException(422, "Add an exam first")
    old = _future_planned(db, now)
    _remove(db, old)

    exams = []
    for x in exams_rows:
        done = sum(_minutes(s) for s in db.execute("SELECT * FROM sessions WHERE exam_id = ? AND status = 'done'", (x["id"],)))
        exams.append(planner.Exam(x["id"], x["subject"], Date.fromisoformat(x["date"]), x["difficulty"], x["hours"], done))
    last = max(e.date for e in exams)
    busy = [(e["start"], e["end"]) for e in get_calendar().events(now, datetime.combine(last, time(23, 59)))
            if not e["all_day"] and not e["session_id"]]
    # Today's sessions already done or missed count as busy too.
    busy += [(datetime.fromisoformat(r["start"]), datetime.fromisoformat(r["end"]))
             for r in db.execute("SELECT * FROM sessions WHERE start >= ?", (now.date().isoformat(),))]
    result = planner.plan(exams, busy, settings, now)
    for s in result.sessions:
        db.execute("INSERT INTO sessions (exam_id, start, end, kind) VALUES (?, ?, ?, ?)",
                   (s.exam_id, s.start.isoformat(timespec="minutes"), s.end.isoformat(timespec="minutes"), s.kind))
    if settings["synced"]:
        _add_to_calendar(db, _future_planned(db, now))
    db.commit()
    return {**state(db), "replaced": len(old)}


@router.post("/calendar")
def add_plan_to_calendar(db: sqlite3.Connection = Depends(get_db)):
    now = datetime.now()
    rows = [r for r in _future_planned(db, now) if not r["event_id"]]
    added = _add_to_calendar(db, rows)
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
