import pytest
from fastapi.testclient import TestClient

from app import calendar_mac, config, main


@pytest.fixture
def client(tmp_path, monkeypatch):
    """The app on a temporary database, with the made-up calendar (never your real one)."""
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "today.db")
    monkeypatch.setattr(config, "BUDGET_DB", tmp_path / "no-budget.db")
    monkeypatch.setenv("TODAY_DEMO", "1")
    fake = calendar_mac.FakeCalendar()
    calendar_mac.set_calendar(fake)
    with TestClient(main.app) as c:
        c.fake = fake
        yield c
    calendar_mac.set_calendar(None)
