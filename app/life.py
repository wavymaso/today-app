"""Your life outside studying: routines like the gym, football or calling home.

Two kinds:
- fixed:    the same days and time every week ("Football, Saturday 11:00").
- flexible: a number of times a week, whenever you're free, in the part of the
            day you like ("Gym, 3 times a week, evenings"). Today picks the days,
            spreads them out, and finds free time on them.

Routines are placed before revision, so studying fits around your life rather
than the other way round.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

PARTS = {
    "morning": (time(7, 0), time(12, 0)),
    "afternoon": (time(12, 0), time(18, 0)),
    "evening": (time(17, 0), time(22, 0)),
    "any": (time(8, 0), time(22, 0)),
}


@dataclass
class Routine:
    id: int
    title: str
    kind: str = "flexible"                       # "fixed" or "flexible"
    minutes: int = 60
    days: list[int] = field(default_factory=list)  # fixed: weekdays, 0 = Monday
    at: time | None = None                       # fixed: start time
    per_week: int = 3                            # flexible: how often
    part: str = "any"                            # flexible: morning / afternoon / evening / any


@dataclass
class Occurrence:
    routine_id: int
    start: datetime
    end: datetime


def _overlaps(a0: datetime, a1: datetime, busy: list[tuple[datetime, datetime]], gap: timedelta) -> bool:
    return any(a0 < b1 + gap and a1 > b0 - gap for b0, b1 in busy)


def _first_free(day: date, minutes: int, part: str, busy: list[tuple[datetime, datetime]], gap: timedelta,
                not_before: datetime | None) -> tuple[datetime, datetime] | None:
    lo, hi = PARTS.get(part, PARTS["any"])
    t = datetime.combine(day, lo)
    if not_before and not_before > t:
        t = not_before + timedelta(minutes=(-not_before.minute) % 15)
        t = t.replace(second=0, microsecond=0)
    end_of_window = datetime.combine(day, hi)
    step = timedelta(minutes=15)
    while t + timedelta(minutes=minutes) <= end_of_window:
        e = t + timedelta(minutes=minutes)
        if not _overlaps(t, e, busy, gap):
            return t, e
        t += step
    return None


def _spread(days: list[date], n: int) -> list[date]:
    """Pick n of these days as evenly spaced as possible (Mon/Wed/Fri rather than Mon/Tue/Wed)."""
    if n >= len(days):
        return list(days)
    if n <= 0:
        return []
    step = len(days) / n
    picked = []
    for i in range(n):
        d = days[min(len(days) - 1, round(i * step + step / 2 - 0.5))]
        if d not in picked:
            picked.append(d)
    return picked


def occurrences(routines: list[Routine], busy: list[tuple[datetime, datetime]], first: date, last: date,
                now: datetime, break_minutes: int = 15) -> list[Occurrence]:
    """Every routine's times between `first` and `last` (inclusive), avoiding `busy` for flexible ones."""
    gap = timedelta(minutes=break_minutes)
    out: list[Occurrence] = []
    taken = list(busy)
    days = [first + timedelta(days=i) for i in range((last - first).days + 1)]

    # Fixed routines are where you said they are.
    for r in (r for r in routines if r.kind == "fixed" and r.at):
        for d in days:
            if d.weekday() in r.days:
                s = datetime.combine(d, r.at)
                if s > now:
                    e = s + timedelta(minutes=r.minutes)
                    out.append(Occurrence(r.id, s, e))
                    taken.append((s, e))

    # Flexible ones, week by week (Monday to Sunday).
    flexible = sorted((r for r in routines if r.kind == "flexible"), key=lambda r: -r.per_week)
    weeks: dict[date, list[date]] = {}
    for d in days:
        weeks.setdefault(d - timedelta(days=d.weekday()), []).append(d)
    for monday, week_days in sorted(weeks.items()):
        open_days = [d for d in week_days if d >= now.date()]
        # A week that's already partly over gets fewer, so you're not asked to catch up.
        share = len(open_days) / 7
        for r in flexible:
            want = min(len(open_days), max(0, round(r.per_week * share)))
            placed_days: list[date] = []
            for d in _spread(open_days, want) + [d for d in open_days]:
                if len(placed_days) >= want:
                    break
                if d in placed_days or any(abs((d - p).days) < 1 for p in placed_days):
                    continue
                slot = _first_free(d, r.minutes, r.part, taken, gap, now if d == now.date() else None)
                if slot:
                    out.append(Occurrence(r.id, *slot))
                    taken.append(slot)
                    placed_days.append(d)
    return sorted(out, key=lambda o: o.start)
