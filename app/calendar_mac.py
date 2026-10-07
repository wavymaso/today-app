"""Your calendar and reminders, through the Mac's Calendar and Reminders apps (EventKit).

Your Google calendar syncs into the Mac Calendar app, so reading here sees it,
and revision sessions added here show up in Google Calendar on your phone too.

Everything outside this module uses plain Python values: local naive datetimes
and dicts. `get_calendar()` returns the real one, or a made-up one in demo mode.
"""
from __future__ import annotations

import logging
import threading
from datetime import date, datetime, time, timedelta

from . import config

log = logging.getLogger("today.calendar")

TAG = "today-app:session:"   # in the notes of events we add, so we only ever touch our own
REVISION_CALENDAR = "Revision"


class CalendarError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# The real thing (EventKit)
# ---------------------------------------------------------------------------

class MacCalendar:
    STATUS = {0: "not_asked", 1: "restricted", 2: "denied", 3: "granted", 4: "write_only"}

    def __init__(self):
        import EventKit
        self.ek = EventKit
        self.store = EventKit.EKEventStore.alloc().init()
        self.lock = threading.Lock()

    # --- permission -------------------------------------------------------
    def status(self, entity: str = "event") -> str:
        kind = self.ek.EKEntityTypeEvent if entity == "event" else self.ek.EKEntityTypeReminder
        return self.STATUS.get(self.ek.EKEventStore.authorizationStatusForEntityType_(kind), "unknown")

    def request_access(self) -> dict:
        """Shows the macOS permission prompt (once). Returns the new statuses."""
        for entity in ("event", "reminder"):
            if self.status(entity) != "not_asked":
                continue
            done = threading.Event()
            handler = lambda granted, error: done.set()   # noqa: E731
            if entity == "event":
                if hasattr(self.store, "requestFullAccessToEventsWithCompletion_"):
                    self.store.requestFullAccessToEventsWithCompletion_(handler)
                else:
                    self.store.requestAccessToEntityType_completion_(self.ek.EKEntityTypeEvent, handler)
            else:
                if hasattr(self.store, "requestFullAccessToRemindersWithCompletion_"):
                    self.store.requestFullAccessToRemindersWithCompletion_(handler)
                else:
                    self.store.requestAccessToEntityType_completion_(self.ek.EKEntityTypeReminder, handler)
            done.wait(120)
        # A store made before access was granted doesn't see anything; start fresh.
        self.store = self.ek.EKEventStore.alloc().init()
        return {"events": self.status("event"), "reminders": self.status("reminder")}

    # --- helpers ----------------------------------------------------------
    @staticmethod
    def _ns(dt: datetime):
        from Foundation import NSDate
        return NSDate.dateWithTimeIntervalSince1970_(dt.timestamp())

    @staticmethod
    def _py(nsdate) -> datetime | None:
        return datetime.fromtimestamp(nsdate.timeIntervalSince1970()) if nsdate is not None else None

    @staticmethod
    def _hex(color) -> str:
        try:
            from AppKit import NSColorSpace
            c = color.colorUsingColorSpace_(NSColorSpace.sRGBColorSpace())
            return "#{:02x}{:02x}{:02x}".format(*(round(x * 255) for x in (c.redComponent(), c.greenComponent(), c.blueComponent())))
        except Exception:
            return "#64748b"

    def _calendar(self, ident: str):
        cal = self.store.calendarWithIdentifier_(ident)
        if cal is None:
            raise CalendarError("That calendar no longer exists")
        return cal

    # --- reading ----------------------------------------------------------
    def calendars(self) -> list[dict]:
        with self.lock:
            cals = self.store.calendarsForEntityType_(self.ek.EKEntityTypeEvent) or []
            return [{"id": c.calendarIdentifier(), "title": c.title(), "color": self._hex(c.color()),
                     "writable": bool(c.allowsContentModifications()), "source": c.source().title(),
                     "birthdays": c.type() == self.ek.EKCalendarTypeBirthday} for c in cals]

    def events(self, start: datetime, end: datetime, calendar_ids: list[str] | None = None) -> list[dict]:
        with self.lock:
            cals = None
            if calendar_ids:
                cals = [c for c in (self.store.calendarWithIdentifier_(i) for i in calendar_ids) if c is not None] or None
            pred = self.store.predicateForEventsWithStartDate_endDate_calendars_(self._ns(start), self._ns(end), cals)
            out = []
            for e in self.store.eventsMatchingPredicate_(pred) or []:
                notes = e.notes() or ""
                out.append({
                    "id": e.calendarItemIdentifier(),
                    "title": e.title() or "(No title)",
                    "start": self._py(e.startDate()),
                    "end": self._py(e.endDate()),
                    "all_day": bool(e.isAllDay()),
                    "location": e.location() or None,
                    "calendar": e.calendar().title(),
                    "calendar_id": e.calendar().calendarIdentifier(),
                    "color": self._hex(e.calendar().color()),
                    "session_id": int(notes.split(TAG, 1)[1].split()[0]) if TAG in notes else None,
                })
            return sorted(out, key=lambda x: (not x["all_day"], x["start"]))

    def reminders(self, until: datetime) -> list[dict]:
        """Unfinished reminders due before `until` (overdue included), plus ones with no date flagged."""
        if self.status("reminder") != "granted":
            return []
        done = threading.Event()
        found: list = []

        def handler(items):
            found.extend(items or [])
            done.set()

        with self.lock:
            pred = self.store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(None, self._ns(until), None)
            self.store.fetchRemindersMatchingPredicate_completion_(pred, handler)
        done.wait(10)
        out = []
        for r in found:
            due = r.dueDateComponents()
            when = None
            if due is not None:
                d = due.date()
                when = self._py(d) if d is not None else None
            out.append({"id": r.calendarItemIdentifier(), "title": r.title() or "(No title)", "due": when,
                        "list": r.calendar().title(), "color": self._hex(r.calendar().color())})
        return sorted(out, key=lambda x: x["due"] or datetime.max)

    # --- writing (only our own revision sessions) --------------------------
    def revision_calendar(self) -> dict:
        """A calendar named "Revision" if there is one or we can make one; otherwise your main calendar."""
        with self.lock:
            cals = self.store.calendarsForEntityType_(self.ek.EKEntityTypeEvent) or []
            for c in cals:
                if c.title() == REVISION_CALENDAR and c.allowsContentModifications():
                    return {"id": c.calendarIdentifier(), "title": c.title(), "separate": True}
            default = self.store.defaultCalendarForNewEvents()
            if default is None:
                raise CalendarError("No calendar you can add events to was found")
            try:
                new = self.ek.EKCalendar.calendarForEntityType_eventStore_(self.ek.EKEntityTypeEvent, self.store)
                new.setTitle_(REVISION_CALENDAR)
                new.setSource_(default.source())
                ok, err = self.store.saveCalendar_commit_error_(new, True, None)
                if ok:
                    return {"id": new.calendarIdentifier(), "title": REVISION_CALENDAR, "separate": True}
                log.info("Couldn't create a Revision calendar (%s); using %s", err, default.title())
            except Exception as exc:   # some accounts (e.g. Google) don't allow new calendars from the Mac
                log.info("Couldn't create a Revision calendar (%s); using %s", exc, default.title())
            return {"id": default.calendarIdentifier(), "title": default.title(), "separate": False}

    def add_event(self, calendar_id: str, title: str, start: datetime, end: datetime, session_id: int,
                  notes: str = "", alert_minutes: int = 0) -> str:
        with self.lock:
            ev = self.ek.EKEvent.eventWithEventStore_(self.store)
            if alert_minutes:   # an alert before it starts, on the Mac and the phone
                ev.addAlarm_(self.ek.EKAlarm.alarmWithRelativeOffset_(-60 * alert_minutes))
            ev.setCalendar_(self._calendar(calendar_id))
            ev.setTitle_(title)
            ev.setStartDate_(self._ns(start))
            ev.setEndDate_(self._ns(end))
            ev.setNotes_(f"{notes}\n\n{TAG}{session_id} (added by the Today app)".strip())
            ok, err = self.store.saveEvent_span_commit_error_(ev, self.ek.EKSpanThisEvent, True, None)
            if not ok:
                raise CalendarError(f"Couldn't add the event: {err}")
            return ev.calendarItemIdentifier()

    def delete_event(self, event_id: str) -> bool:
        """Removes an event we added. Events without our tag are never touched."""
        with self.lock:
            items = self.store.calendarItemsWithExternalIdentifier_(event_id) or []
            ev = self.store.calendarItemWithIdentifier_(event_id) or (items[0] if items else None)
            if ev is None:
                return False
            if TAG not in (ev.notes() or ""):
                log.warning("Refusing to delete event %s: not added by Today", event_id)
                return False
            ok, _ = self.store.removeEvent_span_commit_error_(ev, self.ek.EKSpanThisEvent, True, None)
            return bool(ok)


# ---------------------------------------------------------------------------
# Made-up calendar for demo mode and tests
# ---------------------------------------------------------------------------

class FakeCalendar:
    """A student's week with classes, a lab, a few plans and two exams."""

    def __init__(self, today: date | None = None):
        self.today = today or date.today()
        self.added: dict[str, dict] = {}
        self._n = 0

    def status(self, entity: str = "event") -> str:
        return "granted"

    def request_access(self) -> dict:
        return {"events": "granted", "reminders": "granted"}

    def calendars(self) -> list[dict]:
        return [{"id": "uni", "title": "University", "color": "#2a78d6", "writable": True, "source": "Demo", "birthdays": False},
                {"id": "personal", "title": "Personal", "color": "#e87ba4", "writable": True, "source": "Demo", "birthdays": False},
                {"id": "birthdays", "title": "Birthdays", "color": "#8295af", "writable": False, "source": "Demo", "birthdays": True}]

    def _week(self) -> list[dict]:
        out = []
        monday = self.today - timedelta(days=self.today.weekday())
        classes = {
            0: [("Statistics", 9, 0, 10, 30, "Aula 2.04"), ("Microeconomics", 11, 0, 12, 30, "Aula 1.12")],
            1: [("Programming lab", 10, 0, 13, 0, "Lab B"), ("Spanish B2", 17, 0, 18, 30, "Language centre")],
            2: [("Statistics", 9, 0, 10, 30, "Aula 2.04"), ("Marketing", 12, 0, 13, 30, "Aula 3.01")],
            3: [("Microeconomics", 11, 0, 12, 30, "Aula 1.12"), ("Programming lab", 15, 0, 17, 0, "Lab B")],
            4: [("Marketing", 10, 0, 11, 30, "Aula 3.01")],
        }
        personal = {1: [("Gym", 19, 30, 20, 30, "Basic-Fit")], 3: [("Dinner with Lucía", 21, 0, 23, 0, "Malasaña")],
                    5: [("Football", 11, 0, 12, 30, "Parque del Retiro")]}
        for week in range(0, 6):
            for wd in range(7):
                day = monday + timedelta(days=7 * week + wd)
                for cal, table in (("uni", classes), ("personal", personal)):
                    for title, h1, m1, h2, m2, loc in table.get(wd, []):
                        out.append({"id": f"{cal}-{day}-{title}", "title": title, "all_day": False,
                                    "start": datetime.combine(day, time(h1, m1)), "end": datetime.combine(day, time(h2, m2)),
                                    "location": loc, "calendar": "University" if cal == "uni" else "Personal",
                                    "calendar_id": cal, "color": "#2a78d6" if cal == "uni" else "#e87ba4", "session_id": None})
        for offset, who in ((2, "Lucía"), (5, "Mum")):
            day = self.today + timedelta(days=offset)
            out.append({"id": f"bday-{who}", "title": f"{who}'s Birthday", "all_day": True,
                        "start": datetime.combine(day, time(0)), "end": datetime.combine(day + timedelta(days=1), time(0)),
                        "location": None, "calendar": "Birthdays", "calendar_id": "birthdays", "color": "#8295af", "session_id": None})
        for offset, title in ((9, "Statistics midterm"), (16, "Microeconomics exam"), (5, "Marketing essay due")):
            day = self.today + timedelta(days=offset)
            out.append({"id": f"uni-{title}", "title": title, "all_day": offset == 5,
                        "start": datetime.combine(day, time(9, 0) if offset != 5 else time(0)),
                        "end": datetime.combine(day, time(11, 0)) if offset != 5 else datetime.combine(day + timedelta(days=1), time(0)),
                        "location": "Aula Magna" if offset != 5 else None, "calendar": "University", "calendar_id": "uni",
                        "color": "#2a78d6", "session_id": None})
        return out + list(self.added.values())

    def events(self, start: datetime, end: datetime, calendar_ids: list[str] | None = None) -> list[dict]:
        evs = [e for e in self._week() if e["start"] < end and e["end"] > start]
        if calendar_ids:
            evs = [e for e in evs if e["calendar_id"] in calendar_ids]
        return sorted(evs, key=lambda x: (not x["all_day"], x["start"]))

    def reminders(self, until: datetime) -> list[dict]:
        t = datetime.combine(self.today, time(9))
        return [r for r in [
            {"id": "r1", "title": "Pay the gas bill", "due": t - timedelta(days=1), "list": "Reminders", "color": "#eb6834"},
            {"id": "r2", "title": "Book TIE appointment", "due": t, "list": "Reminders", "color": "#eb6834"},
            {"id": "r3", "title": "Return library books", "due": t + timedelta(days=2), "list": "Reminders", "color": "#eb6834"},
        ] if r["due"] < until]

    def revision_calendar(self) -> dict:
        return {"id": "revision", "title": REVISION_CALENDAR, "separate": True}

    def add_event(self, calendar_id, title, start, end, session_id, notes="", alert_minutes=0) -> str:
        self._n += 1
        ident = f"fake-{self._n}"
        self.added[ident] = {"id": ident, "title": title, "start": start, "end": end, "all_day": False, "location": None,
                             "calendar": REVISION_CALENDAR, "calendar_id": calendar_id, "color": "#8b5cf6",
                             "session_id": session_id, "alert_minutes": alert_minutes}
        return ident

    def delete_event(self, event_id: str) -> bool:
        return self.added.pop(event_id, None) is not None


_calendar = None
_calendar_lock = threading.Lock()


def get_calendar():
    global _calendar
    with _calendar_lock:
        if _calendar is None:
            _calendar = FakeCalendar() if config.demo() else MacCalendar()
        return _calendar


def set_calendar(cal) -> None:
    """For tests: use a specific calendar object."""
    global _calendar
    _calendar = cal
