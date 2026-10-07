"""One line from the Budget app: what's left to spend this month.

Budget's database is opened read-only, so Today can never change your money data.
"""
import calendar
import sqlite3
from datetime import date

from . import config


def get(today: date | None = None) -> dict | None:
    today = today or date.today()
    if config.demo():
        return {"spent_cents": 18541, "limit_cents": 60000, "left_cents": 41459, "per_day_cents": 1518,
                "bills_upcoming_cents": 3500, "days_left": 25}
    if not config.BUDGET_DB.exists():
        return None
    start = today.replace(day=1)
    end = today.replace(day=calendar.monthrange(today.year, today.month)[1])
    days_left = (end - today).days + 1
    conn = sqlite3.connect(f"file:{config.BUDGET_DB}?mode=ro", uri=True, timeout=5)
    try:
        spent = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) FROM expenses WHERE date BETWEEN ? AND ?",
                             (start.isoformat(), end.isoformat())).fetchone()[0]
        row = conn.execute("SELECT limit_cents FROM budgets WHERE category_id IS NULL AND period = 'month'").fetchone()
        limit = row[0] if row else None
        upcoming = 0
        try:   # monthly bills still to come (Budget 1.4+)
            upcoming = conn.execute("SELECT COALESCE(SUM(amount_cents), 0) FROM recurring WHERE next_date > ? AND next_date <= ?",
                                    (today.isoformat(), end.isoformat())).fetchone()[0]
        except sqlite3.OperationalError:
            pass
    finally:
        conn.close()
    left = None if limit is None else limit - spent
    per_day = None if left is None else max(0, left - upcoming) // days_left
    return {"spent_cents": spent, "limit_cents": limit, "left_cents": left, "per_day_cents": per_day,
            "bills_upcoming_cents": upcoming, "days_left": days_left}
