from datetime import date, datetime, time, timedelta

from app import brief, weather
from app.calendar_mac import FakeCalendar


def ev(day, h1, h2, title="Class", all_day=False):
    return {"start": datetime.combine(day, time(h1)), "end": datetime.combine(day, time(h2)), "all_day": all_day, "title": title}


def test_free_slots_between_events():
    d = date(2026, 10, 7)
    gaps = brief.free_slots([ev(d, 9, 10), ev(d, 13, 14), ev(d, 0, 0, all_day=True)], d)
    assert [(g["start"].hour, g["end"].hour) for g in gaps] == [(8, 9), (10, 13), (14, 22)]
    # Only from now on, and short gaps are dropped.
    gaps = brief.free_slots([ev(d, 12, 13)], d, after=datetime.combine(d, time(11, 30)))
    assert [(g["start"].hour, g["end"].hour) for g in gaps] == [(13, 22)]


def test_greeting():
    assert brief.greeting(datetime(2026, 10, 7, 8), "") == "Good morning"
    assert brief.greeting(datetime(2026, 10, 7, 15), "Sam") == "Good afternoon, Sam"
    assert brief.greeting(datetime(2026, 10, 7, 21), "") == "Good evening"


def test_reminders_skip_ancient_ones():
    now = datetime(2026, 10, 7, 8)

    class Cal(FakeCalendar):
        def reminders(self, until):
            mk = lambda d: {"id": str(d), "title": "x", "due": d, "list": "R", "color": "#000"}   # noqa: E731
            return [mk(datetime(2019, 12, 31)), mk(now - timedelta(days=2)), mk(now + timedelta(hours=3)), mk(now + timedelta(days=1))]

    whens = [r["when"] for r in brief.reminders(Cal(), now)]
    assert whens == ["overdue", "today", "tomorrow"]


def test_umbrella_advice():
    now = datetime(2026, 10, 7, 9)
    w = weather.summarize(weather.demo_raw(now), now)
    assert w["advice"] == "Take an umbrella: rain likely from 16:00"
    assert w["temp"] == 19 and w["high"] == 23


def test_brief_in_demo_mode(client):
    b = client.get("/api/brief").json()
    assert b["calendar_access"] == "granted"
    assert b["weather"]["place"] == "Madrid"
    assert len(b["email"]["items"]) == 3
    assert b["budget"]["left_cents"] == 41459
    titles = [c["title"] for c in b["coming_up"]]
    assert "Statistics midterm" in titles and "Marketing essay due" in titles
    assert all(0 <= c["days"] <= 14 for c in b["coming_up"])


def test_hidden_calendars_are_left_out(client):
    client.put("/api/prefs", json={"hidden_calendars": ["uni"]})
    b = client.get("/api/brief").json()
    assert all(e["calendar"] != "University" for e in b["day"]["events"])
    assert [c for c in client.get("/api/calendars").json() if c["id"] == "uni"][0]["shown"] is False


def test_prefs_round_trip(client):
    p = client.put("/api/prefs", json={"name": " Sam ", "theme": "noir",
                                        "place": {"name": "Valencia", "lat": 39.47, "lon": -0.38}}).json()
    assert (p["name"], p["theme"], p["place"]["name"]) == ("Sam", "noir", "Valencia")
    assert client.put("/api/prefs", json={"theme": "neon"}).status_code == 422
    assert client.get("/api/brief").json()["greeting"].endswith(", Sam")


def test_leave_by_uses_the_first_event_with_a_place():
    d = date(2026, 10, 8)
    evs = [dict(ev(d, 8, 9, "Breakfast"), location=None, session_id=None),
           dict(ev(d, 9, 10, "Statistics"), location="Aula 2.04", session_id=None),
           dict(ev(d, 11, 12, "Lab"), location="Lab B", session_id=None)]
    lb = brief.leave_by(evs, 35, datetime(2026, 10, 8, 7, 0))
    assert (lb["title"], lb["leave"], lb["minutes_until"]) == ("Statistics", "2026-10-08T08:25", 85)
    # Once it has started, the next one counts.
    assert brief.leave_by(evs, 35, datetime(2026, 10, 8, 9, 30))["title"] == "Lab"


def test_evening_shows_tomorrow(client, monkeypatch):
    from app import brief as b
    real = b.build
    late = datetime.combine(date.today(), time(21, 0))
    monkeypatch.setattr("app.main.brief.build", lambda db, view=None: real(db, now=late, view=view))
    r = client.get("/api/brief").json()
    assert r["view"] == "tomorrow" and r["date"] == (date.today() + timedelta(days=1)).isoformat()
    assert client.get("/api/brief?view=today").json()["view"] == "today"
    # Switched off: the evening shows today.
    sections = [{"id": s["id"], "on": s["id"] != "evening"} for s in r["sections"]]
    client.put("/api/prefs", json={"sections": sections})
    assert client.get("/api/brief").json()["view"] == "today"


def test_sections_can_be_switched_off_and_reordered(client):
    sections = client.get("/api/prefs").json()["sections"]
    flipped = [{"id": s["id"], "on": s["id"] not in ("email", "money")} for s in reversed(sections)]
    p = client.put("/api/prefs", json={"sections": flipped}).json()
    assert [s["id"] for s in p["sections"]] == [s["id"] for s in reversed(sections)]
    b = client.get("/api/brief").json()
    assert b["email"] is None and b["budget"] is None and b["coming_up"] is not None
    assert client.put("/api/prefs", json={"sections": flipped[:2]}).status_code == 422


def test_birthdays_this_week(client):
    names = [x["name"] for x in client.get("/api/brief?view=today").json()["birthdays"]]
    assert names == ["Lucía", "Mum"]


def test_top3_saves_and_offers_leftovers(client):
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    client.put("/api/top3", json={"date": yesterday, "items": [
        {"position": 1, "text": "Finish stats problem set", "done": True},
        {"position": 2, "text": "Email Prof. Ruiz", "done": False}]})
    t = client.get("/api/brief?view=today").json()["top3"]
    assert t["leftover"] == ["Email Prof. Ruiz"]
    t = client.put("/api/top3", json={"date": date.today().isoformat(), "items": [
        {"position": 1, "text": "Email Prof. Ruiz", "done": False}, {"position": 2, "text": "  "}]}).json()
    assert [i["text"] for i in t["items"]] == ["Email Prof. Ruiz", "", ""]
    assert t["leftover"] == []
