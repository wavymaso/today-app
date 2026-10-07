from datetime import date, datetime, timedelta


def add_exam(client, subject, days, difficulty=2):
    d = (date.today() + timedelta(days=days)).isoformat()
    return client.post("/api/revision/exams", json={"subject": subject, "date": d, "difficulty": difficulty})


def test_exam_validation(client):
    assert add_exam(client, "Stats", 10).status_code == 201
    bad = client.post("/api/revision/exams", json={"subject": "X", "date": "2026-13-01"})
    assert bad.status_code == 422
    assert client.post("/api/revision/exams", json={"subject": "X", "date": "2026-12-01", "time": "25:00"}).status_code == 422


def test_plan_then_add_to_calendar_then_replan(client):
    add_exam(client, "Statistics", 9, 3)
    add_exam(client, "Micro", 16, 2)
    s = client.post("/api/revision/plan").json()
    assert s["sessions"], "a plan was made"
    assert all(not x["event_id"] for x in s["sessions"])      # nothing in the calendar until you say so
    assert not client.fake.added

    s = client.post("/api/revision/calendar").json()
    assert s["added"] == len(client.fake.added) == len([x for x in s["sessions"] if not x["past"]])
    assert s["settings"]["synced"] is True
    titles = {e["title"] for e in client.fake.added.values()}
    assert any(t.startswith("📚 Statistics") for t in titles)

    # Replanning replaces our events, and keeps them in the calendar.
    before = set(client.fake.added)
    s = client.post("/api/revision/plan").json()
    assert s["replaced"] == len(before)
    assert not (before & set(client.fake.added)) and len(client.fake.added) == len(s["sessions"])

    # Sessions never clash with calendar events.
    events = [e for e in client.fake._week() if not e["session_id"] and not e["all_day"]]
    for x in s["sessions"]:
        a, b = datetime.fromisoformat(x["start"]), datetime.fromisoformat(x["end"])
        assert all(b <= e["start"] or a >= e["end"] for e in events)


def test_remove_from_calendar_keeps_the_plan(client):
    add_exam(client, "Statistics", 9)
    client.post("/api/revision/plan")
    client.post("/api/revision/calendar")
    s = client.delete("/api/revision/calendar").json()
    assert s["removed"] > 0 and not client.fake.added
    assert s["sessions"] and s["settings"]["synced"] is False


def test_done_sessions_count_and_survive_replanning(client):
    add_exam(client, "Statistics", 9, 2)
    s = client.post("/api/revision/plan").json()
    first = s["sessions"][0]
    s = client.patch(f"/api/revision/sessions/{first['id']}", json={"status": "done"}).json()
    exam = s["exams"][0]
    assert exam["done_minutes"] > 0
    s = client.post("/api/revision/plan").json()
    assert any(x["id"] == first["id"] and x["status"] == "done" for x in s["sessions"])
    assert client.patch(f"/api/revision/sessions/{first['id']}", json={"status": "maybe"}).status_code == 422


def test_deleting_an_exam_removes_its_upcoming_sessions(client):
    add_exam(client, "Statistics", 9)
    exam_id = add_exam(client, "Micro", 12).json()["exams"][1]["id"]
    client.post("/api/revision/plan")
    client.post("/api/revision/calendar")
    s = client.delete(f"/api/revision/exams/{exam_id}").json()
    assert all(x["subject"] != "Micro" for x in s["sessions"])
    assert all("Micro" not in e["title"] for e in client.fake.added.values())


def test_settings_validation(client):
    s = client.put("/api/revision/settings", json={"hours_per_day": 2, "earliest": "10:00", "latest": "20:00", "days_off": [6, 6]}).json()
    assert (s["settings"]["hours_per_day"], s["settings"]["earliest"], s["settings"]["days_off"]) == (2, "10:00", [6])
    assert client.put("/api/revision/settings", json={"earliest": "21:00", "latest": "09:00"}).status_code == 422
    assert client.put("/api/revision/settings", json={"days_off": [7]}).status_code == 422


def test_plan_needs_an_exam(client):
    assert client.post("/api/revision/plan").status_code == 422


def test_exams_show_in_coming_up(client):
    add_exam(client, "Statistics", 4)
    items = client.get("/api/brief").json()["coming_up"]
    assert any(i["kind"] == "exam" and i["title"] == "Statistics exam" and i["days"] == 4 for i in items)


def test_sessions_get_an_alert_in_the_calendar(client):
    add_exam(client, "Statistics", 9)
    client.post("/api/revision/plan")
    client.post("/api/revision/calendar")
    assert {e["alert_minutes"] for e in client.fake.added.values()} == {10}
    client.put("/api/revision/settings", json={"alert_minutes": 0})
    client.post("/api/revision/plan")     # replanning re-adds them with the new setting
    assert {e["alert_minutes"] for e in client.fake.added.values()} == {0}


def test_coming_up_doesnt_say_exam_twice(client):
    add_exam(client, "OOP quiz", 2)
    add_exam(client, "Statistics", 3)
    titles = [i["title"] for i in client.get("/api/brief?view=today").json()["coming_up"] if i["kind"] == "exam"]
    assert titles == ["OOP quiz", "Statistics exam"]
