"""FastAPI application: JSON API under /api, the interface at /."""
import sqlite3
from contextlib import asynccontextmanager
from datetime import date
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import brief, config, mail, schedule, weather
from .calendar_mac import get_calendar
from .db import get_db, get_setting, init_db, set_setting
from .routers import revision


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="Today", lifespan=lifespan)
app.include_router(revision.router)

THEMES = Literal["auto", "light", "dark", "sand", "ocean", "lavender", "rose", "noir"]


@app.get("/api/brief")
def get_brief(view: str | None = None, db: sqlite3.Connection = Depends(get_db)):
    return brief.build(db, view=view)


class Top3Item(BaseModel):
    position: int = Field(ge=1, le=3)
    text: str = Field("", max_length=120)
    done: bool = False


class Top3In(BaseModel):
    date: date
    items: list[Top3Item]


@app.put("/api/top3")
def save_top3(body: Top3In, db: sqlite3.Connection = Depends(get_db)):
    day = body.date.isoformat()
    for it in body.items:
        if it.text.strip():
            db.execute("INSERT INTO top3 (date, position, text, done) VALUES (?, ?, ?, ?) "
                       "ON CONFLICT(date, position) DO UPDATE SET text = excluded.text, done = excluded.done",
                       (day, it.position, it.text.strip(), int(it.done)))
        else:
            db.execute("DELETE FROM top3 WHERE date = ? AND position = ?", (day, it.position))
    db.commit()
    return brief.top3(db, body.date)


@app.post("/api/calendar/access")
def request_calendar_access():
    """Shows the macOS permission prompt if it hasn't been answered yet."""
    return get_calendar().request_access()


@app.get("/api/calendars")
def list_calendars(db: sqlite3.Connection = Depends(get_db)):
    hidden = brief.get_prefs(db)["hidden_calendars"]
    return [{**c, "shown": c["id"] not in hidden} for c in get_calendar().calendars()]


# --- preferences -------------------------------------------------------------

class SectionIn(BaseModel):
    id: str
    on: bool


class PrefsIn(BaseModel):
    name: str | None = Field(None, max_length=40)
    sections: list[SectionIn] | None = None
    travel_minutes: int | None = Field(None, ge=0, le=180)
    theme: THEMES | None = None
    hidden_calendars: list[str] | None = None
    place: dict | None = None


@app.get("/api/prefs")
def get_prefs(db: sqlite3.Connection = Depends(get_db)):
    return {"theme": "auto", **brief.get_prefs(db)}


@app.put("/api/prefs")
def update_prefs(body: PrefsIn, db: sqlite3.Connection = Depends(get_db)):
    prefs = {"theme": "auto", **brief.get_prefs(db)}
    changes = body.model_dump(exclude_none=True)
    if "place" in changes:
        p = changes["place"]
        if not {"name", "lat", "lon"} <= set(p):
            raise HTTPException(422, "A place needs a name, lat and lon")
        changes["place"] = {"name": str(p["name"])[:60], "lat": float(p["lat"]), "lon": float(p["lon"])}
    if "name" in changes:
        changes["name"] = changes["name"].strip()
    if "sections" in changes:
        valid = brief.SECTIONS + brief.FEATURES
        if sorted(s["id"] for s in changes["sections"]) != sorted(valid):
            raise HTTPException(422, "Send every section once")
    prefs.update(changes)
    set_setting(db, "prefs", prefs)
    db.commit()
    return prefs


@app.get("/api/places")
def search_places(q: str):
    try:
        return weather.find_place(q)
    except Exception as exc:
        raise HTTPException(502, f"Couldn't search for places: {exc}")


# --- Gmail ---------------------------------------------------------------------

class GmailIn(BaseModel):
    address: str = Field(max_length=200)
    enabled: bool = True
    password: str | None = None
    use_budget_password: bool = False
    forget_password: bool = False


@app.get("/api/gmail")
def get_gmail(db: sqlite3.Connection = Depends(get_db)):
    return mail.get_config(db)


@app.put("/api/gmail")
def update_gmail(body: GmailIn, db: sqlite3.Connection = Depends(get_db)):
    address = body.address.strip().lower()
    if body.enabled and "@" not in address:
        raise HTTPException(422, "Enter your Gmail address")
    if body.forget_password:
        mail.delete_password(address)
    elif body.use_budget_password:
        if not mail.copy_from_budget(address):
            raise HTTPException(404, "Budget has no saved app password for that address")
    elif body.password:
        mail.set_password(address, mail.clean_app_password(body.password))
    mail.save_config(db, address, body.enabled)
    return mail.get_config(db)


@app.post("/api/gmail/test")
def test_gmail(db: sqlite3.Connection = Depends(get_db)):
    result = mail.get(db, force=True)
    if result.get("error"):
        return {"ok": False, "message": result["error"]}
    n = len(result["items"])
    return {"ok": True, "message": f"Connected. {n} email{'s' if n != 1 else ''} might need a reply."}


class MorningIn(BaseModel):
    enabled: bool
    time: str = Field("08:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    weekdays_only: bool = True
    at_login: bool = False


@app.get("/api/morning")
def get_morning():
    return schedule.current()


@app.put("/api/morning")
def set_morning(body: MorningIn):
    """Open Today by itself each morning (a macOS LaunchAgent)."""
    if body.enabled:
        h, m = body.time.split(":")
        schedule.enable(int(h), int(m), body.weekdays_only, body.at_login)
    else:
        schedule.disable()
    return schedule.current()


@app.get("/api/status")
def status():
    return {"demo": config.demo(), "data_dir": str(config.DATA_DIR), "budget_found": config.BUDGET_DB.exists()}


app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(config.STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
