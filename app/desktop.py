"""Run Today as a desktop app: the API on a free local port, shown in a native window."""
import json
import logging
import subprocess
import sys
import threading

import webview

from . import config
from .db import init_db
from .server import BackgroundServer

log = logging.getLogger("today")


class DesktopApi:
    """Native features the page can call as window.pywebview.api.<name>()."""

    def open_url(self, url: str) -> None:
        if url.startswith(("https://", "http://")):
            subprocess.run(["open", url], check=False)

    def open_budget(self) -> None:
        subprocess.run(["open", "-a", "Budget"], check=False)

    def notify(self, title: str, text: str) -> None:
        """A macOS notification (used when a focus session ends)."""
        script = f'display notification {json.dumps(text[:200])} with title {json.dumps(title[:80])} sound name "Glass"'
        subprocess.run(["osascript", "-e", script], check=False, timeout=5)


def setup_logging() -> None:
    if config.FROZEN:
        config.LOG_DIR.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = open(config.LOG_DIR / "today.log", "a", buffering=1, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def set_dev_dock_icon() -> None:
    icon = config.BASE_DIR / "macos" / "icon.png"
    if config.FROZEN or not icon.exists():
        return
    try:
        from AppKit import NSApplication, NSImage
        NSApplication.sharedApplication().setApplicationIconImage_(NSImage.alloc().initWithContentsOfFile_(str(icon)))
    except Exception:
        pass


def main(debug: bool = False) -> None:
    setup_logging()
    init_db()
    server = BackgroundServer()
    server.start()
    log.info("Today started on port %s, data in %s", server.port, config.DATA_DIR)

    window = webview.create_window(config.APP_NAME, f"http://127.0.0.1:{server.port}/", js_api=DesktopApi(),
                                   width=1180, height=860, min_size=(380, 560), text_select=True,
                                   background_color="#F7F7F8")
    stopped = threading.Event()

    def shutdown():
        if not stopped.is_set():
            stopped.set()
            server.stop()

    window.events.closing += shutdown
    set_dev_dock_icon()
    try:
        webview.start(debug=debug)
    finally:
        shutdown()
