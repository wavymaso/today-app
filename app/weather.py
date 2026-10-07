"""Today's weather from Open-Meteo (free, no account). Cached for 30 minutes."""
import json
import logging
import sqlite3
import time as _time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from . import config

log = logging.getLogger("today.weather")
CACHE_SECONDS = 30 * 60
DEFAULT_PLACE = {"name": "Madrid", "lat": 40.4168, "lon": -3.7038}

# WMO weather codes -> (label, icon name)
CODES = {
    0: ("Clear", "sun"), 1: ("Mostly clear", "sun"), 2: ("Partly cloudy", "cloud-sun"), 3: ("Cloudy", "cloud"),
    45: ("Fog", "fog"), 48: ("Fog", "fog"),
    51: ("Light drizzle", "drizzle"), 53: ("Drizzle", "drizzle"), 55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "drizzle"), 57: ("Freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"), 63: ("Rain", "rain"), 65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"), 67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"), 73: ("Snow", "snow"), 75: ("Heavy snow", "snow"), 77: ("Snow", "snow"),
    80: ("Showers", "rain"), 81: ("Showers", "rain"), 82: ("Heavy showers", "rain"),
    85: ("Snow showers", "snow"), 86: ("Snow showers", "snow"),
    95: ("Thunderstorm", "storm"), 96: ("Thunderstorm", "storm"), 99: ("Thunderstorm", "storm"),
}


def _get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=8) as r:
        return json.loads(r.read())


def find_place(query: str) -> list[dict]:
    """City search for Settings."""
    url = "https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode({"name": query, "count": 5, "language": "en"})
    return [{"name": p["name"], "country": p.get("country"), "admin": p.get("admin1"), "lat": p["latitude"], "lon": p["longitude"]}
            for p in _get(url).get("results", [])]


def summarize(raw: dict, now: datetime, day=None) -> dict:
    """Turn Open-Meteo's answer into what the brief shows: for today, or for `day` (tomorrow)."""
    cur = raw["current"]
    hourly = raw["hourly"]
    other_day = day is not None and day != now.date()
    today = (day or now.date()).isoformat()
    hours = []
    for t, temp, rain, code in zip(hourly["time"], hourly["temperature_2m"], hourly["precipitation_probability"], hourly["weather_code"]):
        if t.startswith(today) and 7 <= int(t[11:13]) <= 22:
            hours.append({"hour": int(t[11:13]), "temp": round(temp), "rain": rain or 0, "code": code})
    daily = raw["daily"]
    i = daily["time"].index(today) if today in daily["time"] else 0
    # Umbrella: a real chance of rain during the hours you're likely out.
    wet = [h for h in hours if (other_day or h["hour"] >= now.hour) and h["rain"] >= 40]
    code = daily["weather_code"][i] if other_day else cur["weather_code"]
    label, icon = CODES.get(code, ("", "cloud"))
    advice = None
    if wet:
        advice = f"Take an umbrella: rain likely from {wet[0]['hour']:02d}:00"
    elif daily["temperature_2m_max"][i] >= 33:
        advice = "Hot today: take water"
    elif daily["temperature_2m_min"][i] <= 5:
        advice = "Cold this morning: wrap up"
    return {
        "temp": round(daily["temperature_2m_max"][i]) if other_day else round(cur["temperature_2m"]), "label": label, "icon": icon,
        "day": today,
        "high": round(daily["temperature_2m_max"][i]), "low": round(daily["temperature_2m_min"][i]),
        "rain_chance": max((h["rain"] for h in hours), default=0),
        "advice": advice,
        "hours": [h for h in hours if h["hour"] % 3 == 0 and (other_day or h["hour"] >= now.hour - 1)][:6],
    }


def fetch(place: dict) -> dict:
    qs = urllib.parse.urlencode({
        "latitude": place["lat"], "longitude": place["lon"], "timezone": "auto", "forecast_days": 2,
        "current": "temperature_2m,weather_code",
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    })
    return _get("https://api.open-meteo.com/v1/forecast?" + qs)


def demo_raw(now: datetime) -> dict:
    days = [(now.date() + timedelta(days=i)).isoformat() for i in range(2)]
    hours = [f"{d}T{h:02d}:00" for d in days for h in range(24)]
    rain = [0] * 15 + [20, 45, 60, 50, 30, 10, 0, 0, 0]
    return {"current": {"temperature_2m": 19.4, "weather_code": 2},
            "hourly": {"time": hours, "temperature_2m": [12 + min(h, 15) * 0.6 for h in range(24)] * 2,
                       "precipitation_probability": rain + [0] * 24, "weather_code": [2] * 15 + [61] * 5 + [3] * 4 + [0] * 24},
            "daily": {"time": days, "temperature_2m_max": [23, 25], "temperature_2m_min": [12, 13],
                      "precipitation_probability_max": [60, 5], "weather_code": [61, 0]}}


def get(conn: sqlite3.Connection, place: dict | None = None, now: datetime | None = None, day=None) -> dict:
    now = now or datetime.now()
    place = place or DEFAULT_PLACE
    if config.demo():
        return {**summarize(demo_raw(now), now, day), "place": place["name"]}
    key = f"weather:{place['lat']:.3f},{place['lon']:.3f}"
    row = conn.execute("SELECT value, fetched_at FROM cache WHERE key = ?", (key,)).fetchone()
    raw = None
    if row and _time.time() - row["fetched_at"] < CACHE_SECONDS:
        raw = json.loads(row["value"])
    else:
        try:
            raw = fetch(place)
            conn.execute("INSERT INTO cache (key, value, fetched_at) VALUES (?, ?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at",
                         (key, json.dumps(raw), _time.time()))
            conn.commit()
        except Exception as exc:
            log.info("Weather unavailable: %s", exc)
            if row:
                raw = json.loads(row["value"])   # an older forecast beats none
    if raw is None:
        raise RuntimeError("Weather isn't available right now (offline?)")
    return {**summarize(raw, now, day), "place": place["name"]}
