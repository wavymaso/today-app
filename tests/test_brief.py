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
