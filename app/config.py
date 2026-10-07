"""Paths and settings.

Your data lives in ~/Library/Application Support/Today (outside the project and
the .app), so rebuilding or updating the app never touches it:

    today.db       exams, revision sessions, settings, cached weather
    .env           optional settings

TODAY_DATA_DIR uses a different folder (handy for testing a build).
TODAY_DEMO=1 shows made-up calendar, weather, email and budget data instead of
yours (for screenshots and trying things out).
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

APP_NAME = "Today"

BASE_DIR = Path(__file__).resolve().parent.parent
FROZEN = getattr(sys, "frozen", False)
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", BASE_DIR))
STATIC_DIR = RESOURCE_DIR / "static"

DATA_DIR = Path(
    os.environ.get("TODAY_DATA_DIR") or Path.home() / "Library" / "Application Support" / APP_NAME
).expanduser()
DB_PATH = DATA_DIR / "today.db"
LOG_DIR = Path.home() / "Library" / "Logs" / APP_NAME

# Budget's database, read (never written) for the one-line money summary.
BUDGET_DB = Path(
    os.environ.get("TODAY_BUDGET_DB") or Path.home() / "Library" / "Application Support" / "Budget" / "budget.db"
).expanduser()

load_dotenv(DATA_DIR / ".env")


def demo() -> bool:
    return os.environ.get("TODAY_DEMO", "").strip().lower() in {"1", "true", "yes", "on"}
