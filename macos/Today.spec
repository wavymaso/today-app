# PyInstaller recipe for Today.app. Run via ./build.sh, not directly.
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).parent
VERSION = (ROOT / "VERSION").read_text().strip()

a = Analysis(
    [str(ROOT / "macos" / "launcher.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "static"), "static")],
    hiddenimports=[
        "webview.platforms.cocoa",
        "keyring.backends.macOS",
        "EventKit", "Foundation", "AppKit", "objc",
        *collect_submodules("app"),
        *collect_submodules("uvicorn"),
    ],
    excludes=["tkinter", "pytest", "PIL", "PyInstaller"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Today", console=False, target_arch=None)
coll = COLLECT(exe, a.binaries, a.datas, name="Today")
app = BUNDLE(
    coll,
    name="Today.app",
    icon=str(ROOT / "macos" / "Today.icns"),
    bundle_identifier="local.today.app",
    version=VERSION,
    info_plist={
        "CFBundleName": "Today",
        "CFBundleDisplayName": "Today",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "LSApplicationCategoryType": "public.app-category.productivity",
        "LSMinimumSystemVersion": "12.0",
        "NSHighResolutionCapable": True,
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        # Shown by macOS when Today asks for access.
        "NSCalendarsUsageDescription": "Today shows your day's events and adds the revision sessions you choose to add.",
        "NSCalendarsFullAccessUsageDescription": "Today shows your day's events and adds the revision sessions you choose to add.",
        "NSRemindersUsageDescription": "Today shows reminders that are due today and tomorrow.",
        "NSRemindersFullAccessUsageDescription": "Today shows reminders that are due today and tomorrow.",
    },
)
