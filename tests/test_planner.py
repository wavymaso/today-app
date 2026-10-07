from datetime import date, datetime, time, timedelta

from app.planner import Exam, free_intervals, plan, DEFAULTS

NOW = datetime(2026, 10, 7, 8, 0)          # a Wednesday morning


def at(d, h, m=0):
    return datetime.combine(d, time(h, m))


def minutes_for(p, exam_id, kind=None):
    return sum(s.minutes for s in p.sessions if s.exam_id == exam_id and (kind is None or s.kind == kind))


def test_free_time_skips_events_with_a_buffer():
    day = date(2026, 10, 8)
    free = free_intervals(day, [(at(day, 11), at(day, 12, 30))], DEFAULTS)
    assert free == [[at(day, 9), at(day, 10, 45)], [at(day, 12, 45), at(day, 21)]]


def test_sessions_never_overlap_events_and_stay_in_the_window():
    exams = [Exam(1, "Statistics", date(2026, 10, 16), difficulty=3)]
    busy = [(at(date(2026, 10, 7) + timedelta(days=i), 10), at(date(2026, 10, 7) + timedelta(days=i), 13)) for i in range(9)]
    p = plan(exams, busy, now=NOW)
    for s in p.sessions:
        assert time(9) <= s.start.time() and s.end.time() <= time(21)
        for b0, b1 in busy:
            assert s.end <= b0 or s.start >= b1
    assert [s.start for s in p.sessions] == sorted(s.start for s in p.sessions)


def test_harder_exams_get_more_time_and_hours_are_met():
    exams = [Exam(1, "Easy", date(2026, 10, 20), difficulty=1), Exam(2, "Hard", date(2026, 10, 20), difficulty=3)]
    p = plan(exams, [], now=NOW)
    assert minutes_for(p, 2) > minutes_for(p, 1)
    # The hours are met without planning more than needed.
    assert 6 * 60 - 30 < minutes_for(p, 1) <= 6 * 60 and 15 * 60 - 30 < minutes_for(p, 2) <= 15 * 60
    assert p.shortfall == {}


def test_daily_limit_and_two_sessions_per_subject():
    exams = [Exam(1, "A", date(2026, 10, 12), difficulty=3), Exam(2, "B", date(2026, 10, 13), difficulty=3)]
    p = plan(exams, [], {"hours_per_day": 3}, now=NOW)
    by_day = {}
    for s in p.sessions:
        by_day.setdefault(s.start.date(), []).append(s)
    for day, ss in by_day.items():
        assert sum(s.minutes for s in ss) <= 180
        for exam_id in (1, 2):
            assert sum(1 for s in ss if s.exam_id == exam_id) <= 2


def test_review_the_day_before_and_nothing_on_exam_day():
    exams = [Exam(1, "Stats", date(2026, 10, 12), difficulty=2), Exam(2, "Micro", date(2026, 10, 15), difficulty=2)]
    p = plan(exams, [], now=NOW)
    reviews = [s for s in p.sessions if s.kind == "review"]
    assert {(s.exam_id, s.start.date()) for s in reviews} == {(1, date(2026, 10, 11)), (2, date(2026, 10, 14))}
    assert not [s for s in p.sessions if s.exam_id == 1 and s.start.date() >= date(2026, 10, 12)]


def test_days_off_and_done_sessions_are_respected():
    exams = [Exam(1, "Stats", date(2026, 10, 19), difficulty=2, done_minutes=4 * 60)]
    p = plan(exams, [], {"days_off": [5, 6]}, now=NOW)
    assert all(s.start.weekday() < 5 for s in p.sessions)
    assert 6 * 60 - 30 < minutes_for(p, 1) <= 6 * 60     # 10 h minus the 4 h already done


def test_not_enough_time_is_reported():
    exams = [Exam(1, "Stats", date(2026, 10, 9), difficulty=3)]   # 15 h needed in ~1.5 days
    p = plan(exams, [], {"hours_per_day": 3}, now=NOW)
    assert p.shortfall[1] > 0
    assert 15 * 60 - 30 < minutes_for(p, 1) + p.shortfall[1] <= 15 * 60


def test_later_today_starts_after_now():
    exams = [Exam(1, "Stats", date(2026, 10, 9), difficulty=1)]
    p = plan(exams, [], now=datetime(2026, 10, 7, 15, 10))
    today = [s for s in p.sessions if s.start.date() == date(2026, 10, 7)]
    assert today and all(s.start >= datetime(2026, 10, 7, 15, 45) for s in today)


def test_past_exams_are_ignored():
    assert plan([Exam(1, "Old", date(2026, 10, 1))], [], now=NOW).sessions == []


def test_review_moves_off_a_day_off():
    # Exam on Monday 19 Oct, weekends off: the review lands on Friday 16 Oct.
    p = plan([Exam(1, "Stats", date(2026, 10, 19), difficulty=1)], [], {"days_off": [5, 6]}, now=NOW)
    reviews = [s for s in p.sessions if s.kind == "review"]
    assert [r.start.date() for r in reviews] == [date(2026, 10, 16)]
    assert p.shortfall == {}
