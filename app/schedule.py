"""Open Today by itself every weekday morning (and optionally at login).

This is a small macOS LaunchAgent: ~/Library/LaunchAgents/local.today.app.plist.
At the chosen time it runs `open -a Today`, so the brief is waiting for you.
If Today is already open it just comes to the front.
"""
import os
import plistlib
import subprocess
from pathlib import Path

LABEL = "local.today.app"


def agent_path() -> Path:
    return Path(os.environ.get("TODAY_LAUNCH_AGENTS") or Path.home() / "Library" / "LaunchAgents") / f"{LABEL}.plist"


def build_plist(hour: int, minute: int, weekdays_only: bool = True, at_login: bool = False) -> dict:
    days = range(1, 6) if weekdays_only else range(0, 7)     # launchd: 0/7 = Sunday, 1 = Monday
    return {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/open", "-a", "Today"],
        "StartCalendarInterval": [{"Weekday": d, "Hour": hour, "Minute": minute} for d in days],
        "RunAtLoad": at_login,
    }


def _launchctl(*args: str) -> None:
    if os.environ.get("TODAY_LAUNCH_AGENTS"):
        return   # tests: write the file only
    subprocess.run(["launchctl", *args], capture_output=True, timeout=10)


def enable(hour: int, minute: int, weekdays_only: bool = True, at_login: bool = False) -> None:
    path = agent_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    disable()
    with open(path, "wb") as f:
        plistlib.dump(build_plist(hour, minute, weekdays_only, at_login), f)
    _launchctl("bootstrap", f"gui/{os.getuid()}", str(path))


def disable() -> None:
    path = agent_path()
    if path.exists():
        _launchctl("bootout", f"gui/{os.getuid()}", str(path))
        path.unlink()


def current() -> dict:
    path = agent_path()
    if not path.exists():
        return {"enabled": False, "time": "08:00", "weekdays_only": True, "at_login": False}
    with open(path, "rb") as f:
        p = plistlib.load(f)
    first = p["StartCalendarInterval"][0]
    return {"enabled": True, "time": f"{first['Hour']:02d}:{first['Minute']:02d}",
            "weekdays_only": len(p["StartCalendarInterval"]) == 5, "at_login": bool(p.get("RunAtLoad"))}
