from datetime import date, datetime, time, timedelta

from app.life import Routine, occurrences, _spread

NOW = datetime(2026, 10, 12, 8, 0)     # a Monday morning
MON = date(2026, 10, 12)
SUN = date(2026, 10, 18)


def test_fixed_routine_on_its_days_and_time():
    r = Routine(1, "Football", "fixed", minutes=90, days=[5], at=time(11, 0))
    occ = occurrences([r], [], MON, date(2026, 10, 25), NOW)
    assert [(o.start, o.end.time()) for o in occ] == [
        (datetime(2026, 10, 17, 11, 0), time(12, 30)), (datetime(2026, 10, 24, 11, 0), time(12, 30))]


def test_flexible_gym_spread_over_the_week_in_the_evening():
    gym = Routine(1, "Gym", "flexible", minutes=90, per_week=3, part="evening")
    occ = occurrences([gym], [], MON, SUN, NOW)
    assert len(occ) == 3
    days = sorted(o.start.date() for o in occ)
    assert all((b - a).days >= 2 for a, b in zip(days, days[1:]))          # not on back-to-back days
    assert all(time(17) <= o.start.time() and o.end.time() <= time(22) for o in occ)


def test_flexible_avoids_busy_time():
    gym = Routine(1, "Gym", "flexible", minutes=60, per_week=7, part="evening")
    busy = [(datetime.combine(MON + timedelta(days=i), time(17)), datetime.combine(MON + timedelta(days=i), time(19)))
            for i in range(7)]
    occ = occurrences([gym], busy, MON, SUN, NOW, break_minutes=15)
    assert occ and all(o.start >= datetime.combine(o.start.date(), time(19, 15)) for o in occ)


def test_no_room_means_no_occurrence_rather_than_a_clash():
    gym = Routine(1, "Gym", "flexible", minutes=60, per_week=2, part="morning")
    busy = [(datetime.combine(MON + timedelta(days=i), time(7)), datetime.combine(MON + timedelta(days=i), time(12)))
            for i in range(7)]
    assert occurrences([gym], busy, MON, SUN, NOW) == []


def test_a_week_already_under_way_asks_for_less():
    gym = Routine(1, "Gym", "flexible", minutes=60, per_week=4, part="evening")
    thursday = datetime(2026, 10, 15, 8, 0)
    occ = occurrences([gym], [], date(2026, 10, 15), SUN, thursday)
    assert len(occ) == 2          # 4 a week, but only 4 of 7 days are left


def test_routines_dont_clash_with_each_other():
    a = Routine(1, "Gym", "flexible", minutes=90, per_week=3, part="evening")
    b = Routine(2, "Run", "flexible", minutes=60, per_week=3, part="evening")
    occ = occurrences([a, b], [], MON, SUN, NOW)
    occ.sort(key=lambda o: o.start)
    assert all(x.end <= y.start for x, y in zip(occ, occ[1:]))


def test_spread_picks_evenly():
    week = [MON + timedelta(days=i) for i in range(7)]
    assert [d.weekday() for d in _spread(week, 3)] in ([0, 2, 4], [0, 3, 5], [1, 3, 5])
    assert _spread(week, 0) == [] and len(_spread(week, 7)) == 7


# --- through the app -------------------------------------------------------------

def test_routines_validation(client):
    assert client.post("/api/revision/routines", json={"title": "Gym", "kind": "fixed", "days": [], "at": "19:00"}).status_code == 422
    assert client.post("/api/revision/routines", json={"title": "Gym", "kind": "sometimes"}).status_code == 422
    assert client.post("/api/revision/routines", json={"title": "Gym", "kind": "flexible", "part": "night"}).status_code == 422
    s = client.post("/api/revision/routines", json={"title": "Football", "kind": "fixed", "days": [5, 5], "at": "11:00", "minutes": 90}).json()
    assert s["routines"][0]["days"] == [5]


def test_plan_with_only_routines(client):
    client.post("/api/revision/routines", json={"title": "Gym", "kind": "flexible", "per_week": 3, "part": "evening", "minutes": 90})
    s = client.post("/api/revision/plan").json()
    assert len(s["life"]) >= 9                 # about three a week for four weeks
    assert all(e["title"] == "Gym" for e in s["life"])


def test_revision_works_around_routines_and_both_go_to_the_calendar(client):
    from datetime import date as D, timedelta as TD
    client.post("/api/revision/exams", json={"subject": "Statistics", "date": (D.today() + TD(days=10)).isoformat(), "difficulty": 3})
    client.post("/api/revision/routines", json={"title": "Gym", "kind": "flexible", "per_week": 4, "part": "evening", "minutes": 90})
    s = client.post("/api/revision/plan").json()
    gyms = [(e["start"], e["end"]) for e in s["life"]]
    for x in s["sessions"]:
        assert all(x["end"] <= g0 or x["start"] >= g1 for g0, g1 in gyms), "a session overlaps the gym"
    s = client.post("/api/revision/calendar").json()
    life_events = [e for e in client.fake.added.values() if e["calendar"] == "Life"]
    assert len(life_events) == len(s["life"]) and all(e["title"] == "Gym" for e in life_events)
    # Replanning swaps our events, never duplicates them.
    s = client.post("/api/revision/plan").json()
    assert len([e for e in client.fake.added.values() if e["calendar"] == "Life"]) == len(s["life"])


def test_deleting_a_routine_removes_its_events(client):
    s = client.post("/api/revision/routines", json={"title": "Run", "kind": "fixed", "days": [0, 2, 4], "at": "07:30", "minutes": 45}).json()
    client.post("/api/revision/plan")
    client.post("/api/revision/calendar")
    assert any(e["title"] == "Run" for e in client.fake.added.values())
    s = client.delete(f"/api/revision/routines/{s['routines'][0]['id']}").json()
    assert s["routines"] == [] and s["life"] == []
    assert not any(e["title"] == "Run" for e in client.fake.added.values())
