import plistlib

from app import schedule


def test_morning_opener(tmp_path, monkeypatch, client):
    monkeypatch.setenv("TODAY_LAUNCH_AGENTS", str(tmp_path))
    assert client.get("/api/morning").json()["enabled"] is False
    r = client.put("/api/morning", json={"enabled": True, "time": "07:45"}).json()
    assert r == {"enabled": True, "time": "07:45", "weekdays_only": True, "at_login": False}
    plist = plistlib.loads((tmp_path / "local.today.app.plist").read_bytes())
    assert plist["ProgramArguments"] == ["/usr/bin/open", "-a", "Today"]
    assert [d["Weekday"] for d in plist["StartCalendarInterval"]] == [1, 2, 3, 4, 5]   # Monday..Friday
    assert {(d["Hour"], d["Minute"]) for d in plist["StartCalendarInterval"]} == {(7, 45)}
    r = client.put("/api/morning", json={"enabled": True, "time": "09:00", "weekdays_only": False, "at_login": True}).json()
    assert r["weekdays_only"] is False and r["at_login"] is True
    assert client.put("/api/morning", json={"enabled": True, "time": "25:00"}).status_code == 422
    assert client.put("/api/morning", json={"enabled": False}).json()["enabled"] is False
    assert not (tmp_path / "local.today.app.plist").exists()
