"""The revision timetable: fit study sessions into your free time before each exam.

How it decides, day by day from tomorrow (or later today) until the last exam:
- Each exam needs a number of hours: 6 / 10 / 15 for easy / medium / hard, or
  your own number. Sessions you've done count towards it.
- Free time is your study window (e.g. 09:00-21:00) minus calendar events, with
  a short buffer around each, minus your days off.
- Each day, the exam that is most behind (hours still needed / study days left
  before it) gets the next session. So harder exams get more sessions, and
  sessions get more frequent as an exam gets closer. Subjects are mixed within
  a day, and no subject gets more than two sessions a day.
- The last study day before an exam (usually the day before) gets a lighter
  review session for it. The review counts towards the exam's hours.
- Nothing is planned on the exam's own day for that exam.
Whatever doesn't fit is reported, so you know when there isn't enough time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

HOURS_FOR_DIFFICULTY = {1: 6, 2: 10, 3: 15}
DEFAULTS = {
    "hours_per_day": 3.0,       # most study in one day
    "session_minutes": 90,
    "break_minutes": 15,        # between sessions, and around calendar events
    "earliest": "09:00",
    "latest": "21:00",
    "days_off": [],             # weekday numbers, 0 = Monday
    "review_minutes": 60,       # the day-before review
}


@dataclass
class Exam:
    id: int
    subject: str
    date: date
    difficulty: int = 2
    hours: float | None = None      # your own estimate; otherwise from difficulty
    done_minutes: int = 0           # sessions already done

    @property
    def needed_minutes(self) -> int:
        target = (self.hours if self.hours else HOURS_FOR_DIFFICULTY.get(self.difficulty, 10)) * 60
        return max(0, int(target) - self.done_minutes)


@dataclass
class Session:
    exam_id: int
    start: datetime
    end: datetime
    kind: str = "study"

    @property
    def minutes(self) -> int:
        return int((self.end - self.start).total_seconds() // 60)


@dataclass
class Plan:
    sessions: list[Session] = field(default_factory=list)
    shortfall: dict[int, int] = field(default_factory=dict)    # exam id -> minutes that didn't fit


def _hm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def free_intervals(day: date, busy: list[tuple[datetime, datetime]], settings: dict,
                   not_before: datetime | None = None) -> list[list[datetime]]:
    """Your study window that day minus busy times (with a buffer around each)."""
    start = datetime.combine(day, _hm(settings["earliest"]))
    end = datetime.combine(day, _hm(settings["latest"]))
    if not_before and not_before > start:
        start = not_before
    if end <= start:
        return []
    buf = timedelta(minutes=settings["break_minutes"])
    free = [[start, end]]
    for b_start, b_end in sorted(busy):
        b_start, b_end = b_start - buf, b_end + buf
        nxt = []
        for f_start, f_end in free:
            if b_end <= f_start or b_start >= f_end:
                nxt.append([f_start, f_end])
                continue
            if b_start > f_start:
                nxt.append([f_start, b_start])
            if b_end < f_end:
                nxt.append([b_end, f_end])
        free = nxt
    return [f for f in free if f[1] > f[0]]


def _take(free: list[list[datetime]], minutes: int, min_minutes: int, gap: timedelta) -> tuple[datetime, datetime] | None:
    """Book the earliest slot of `minutes` (or at least `min_minutes`) and remove it from `free`."""
    for f in free:
        length = (f[1] - f[0]).total_seconds() / 60
        if length >= min_minutes:
            use = min(minutes, int(length))
            start = f[0]
            end = start + timedelta(minutes=use)
            f[0] = end + gap
            return start, end
    return None


def plan(exams: list[Exam], busy: list[tuple[datetime, datetime]], settings: dict | None = None,
         now: datetime | None = None) -> Plan:
    s = {**DEFAULTS, **(settings or {})}
    now = now or datetime.now()
    result = Plan()
    exams = [e for e in exams if e.date > now.date()]
    if not exams:
        return result
    session = int(s["session_minutes"])
    min_session = max(30, session // 2)
    gap = timedelta(minutes=s["break_minutes"])
    remaining = {e.id: e.needed_minutes for e in exams}
    # The day-before review is part of each exam's hours, so set its time aside.
    review = {e.id: min(int(s["review_minutes"]), remaining[e.id]) for e in exams}
    for e in exams:
        remaining[e.id] -= review[e.id]
    # Start later today if there's still time, with half an hour to get going.
    not_before_today = (now + timedelta(minutes=30)).replace(second=0, microsecond=0)
    not_before_today += timedelta(minutes=(-not_before_today.minute) % 15)

    last = max(e.date for e in exams)
    days = [now.date() + timedelta(days=i) for i in range((last - now.date()).days)]
    study_days = [d for d in days if d.weekday() not in s["days_off"]]
    # The review goes on the last study day before each exam (the day before, unless that's a day off).
    review_day = {e.id: max((d for d in study_days if d < e.date), default=None) for e in exams}

    for day in study_days:
        free = free_intervals(day, [b for b in busy if b[0].date() <= day <= b[1].date()], s,
                              not_before=not_before_today if day == now.date() else None)
        budget = int(float(s["hours_per_day"]) * 60)
        per_subject: dict[int, int] = {}
        last_subject = None

        # The day before an exam: a lighter review first.
        for e in exams:
            if review_day[e.id] == day and review[e.id] >= 30 and budget >= 30:
                slot = _take(free, min(review[e.id], budget), 30, gap)
                if slot:
                    got = int((slot[1] - slot[0]).total_seconds() // 60)
                    result.sessions.append(Session(e.id, *slot, kind="review"))
                    budget -= got
                    review[e.id] -= got
                    per_subject[e.id] = 1
                    last_subject = e.id

        while budget >= min_session:
            # Exams still ahead (not today), with hours left.
            open_exams = [e for e in exams if e.date > day and remaining[e.id] > 0 and per_subject.get(e.id, 0) < 2]
            if not open_exams:
                break

            def urgency(e: Exam) -> float:
                days_left = sum(1 for d in study_days if day <= d < e.date) or 1
                score = remaining[e.id] / days_left
                return score * (0.6 if e.id == last_subject else 1.0)   # mix subjects within a day

            pick = max(open_exams, key=lambda e: (urgency(e), -e.date.toordinal()))
            if remaining[pick.id] < 30:      # a few minutes short isn't worth a session
                remaining[pick.id] = 0
                continue
            want = min(session, budget, remaining[pick.id])
            slot = _take(free, want, min(min_session, want), gap)
            if not slot:
                break
            got = int((slot[1] - slot[0]).total_seconds() // 60)
            result.sessions.append(Session(pick.id, *slot))
            remaining[pick.id] = max(0, remaining[pick.id] - got)
            budget -= got
            per_subject[pick.id] = per_subject.get(pick.id, 0) + 1
            last_subject = pick.id

    # A review that found no room counts as time that didn't fit.
    result.shortfall = {i: m + review[i] for i, m in remaining.items() if m + review[i] >= 30}
    result.sessions.sort(key=lambda x: x.start)
    return result
