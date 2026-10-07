"""Emails that probably need a reply, from Gmail (read-only, over IMAP).

"Needs a reply" = in your Primary inbox from the last two days, written by a
person (no newsletters, no-reply senders or automatic mail), and in a
conversation you haven't answered since. Nothing is ever marked, moved or
deleted. The app password lives in the macOS Keychain.
"""
from __future__ import annotations

import email
import email.policy
import email.utils
import imaplib
import json
import logging
import re
import sqlite3
import time as _time
from datetime import datetime, timedelta
from email.header import decode_header, make_header

from . import config
from .db import get_setting, set_setting

log = logging.getLogger("today.mail")
IMAP_HOST = "imap.gmail.com"
KEYCHAIN_SERVICE = "Today – Gmail app password"
BUDGET_KEYCHAIN_SERVICE = "Budget – Gmail app password"
CACHE_SECONDS = 5 * 60
MAX_SHOWN = 6

AUTOMATED_SENDER = re.compile(r"(no-?reply|do-?not-?reply|notifications?|mailer-daemon|newsletter|bounce|alerts?@|info@|news@)", re.I)


# --- Keychain ---------------------------------------------------------------

def _keyring():
    import keyring
    import keyring.backends.macOS
    keyring.set_keyring(keyring.backends.macOS.Keyring())   # auto-discovery fails inside the .app
    return keyring


def get_password(address: str, service: str = KEYCHAIN_SERVICE) -> str | None:
    if not address:
        return None
    try:
        return _keyring().get_password(service, address.lower())
    except Exception:
        return None


def set_password(address: str, password: str) -> None:
    _keyring().set_password(KEYCHAIN_SERVICE, address.lower(), password)


def delete_password(address: str) -> None:
    try:
        _keyring().delete_password(KEYCHAIN_SERVICE, address.lower())
    except Exception:
        pass


def copy_from_budget(address: str) -> bool:
    """Reuse the app password saved by the Budget app (macOS may ask once)."""
    pw = get_password(address, BUDGET_KEYCHAIN_SERVICE)
    if pw:
        set_password(address, pw)
    return bool(pw)


def clean_app_password(password: str) -> str:
    return re.sub(r"\s+", "", password or "")


# --- Settings ---------------------------------------------------------------

def get_config(conn: sqlite3.Connection) -> dict:
    cfg = {"address": "", "enabled": False, **(get_setting(conn, "gmail") or {})}
    cfg["has_password"] = bool(get_password(cfg["address"])) if cfg["address"] and not config.demo() else config.demo()
    return cfg


def save_config(conn: sqlite3.Connection, address: str, enabled: bool) -> None:
    set_setting(conn, "gmail", {"address": address.strip().lower(), "enabled": enabled})
    conn.execute("DELETE FROM cache WHERE key = 'mail'")
    conn.commit()


# --- Reading ----------------------------------------------------------------

def _text(value) -> str:
    try:
        return str(make_header(decode_header(value or ""))).strip()
    except Exception:
        return (value or "").strip()


def _special_mailbox(imap: imaplib.IMAP4_SSL, flag: str) -> str | None:
    """Gmail's All Mail / Sent folders have local names ("[Gmail]/Enviados"); find them by flag."""
    status, rows = imap.list()
    for raw in rows or []:
        line = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        if flag in line:
            m = re.search(r'"([^"]+)"\s*$', line) or re.search(r"(\S+)\s*$", line)
            if m:
                return m.group(1)
    return None


def _is_automated(msg) -> bool:
    sender = msg.get("From", "")
    if msg.get("List-Unsubscribe") or msg.get("List-Id"):
        return True
    if (msg.get("Precedence", "") or "").lower() in {"bulk", "list", "junk"}:
        return True
    if (msg.get("Auto-Submitted", "no") or "no").lower() != "no":
        return True
    return bool(AUTOMATED_SENDER.search(sender))


def connect(address: str, password: str, timeout: float = 15) -> imaplib.IMAP4_SSL:
    imap = imaplib.IMAP4_SSL(IMAP_HOST, 993, timeout=timeout)
    try:
        imap.login(address, clean_app_password(password))
    except imaplib.IMAP4.error as exc:
        imap.logout()
        raise RuntimeError("Gmail didn't accept the address or app password") from exc
    return imap


def fetch_needs_reply(address: str, password: str, now: datetime | None = None) -> list[dict]:
    now = now or datetime.now()
    imap = connect(address, password)
    try:
        all_mail = _special_mailbox(imap, "\\All") or "INBOX"
        imap.select(f'"{all_mail}"', readonly=True)

        # Conversations you've written in lately, and when.
        replied: dict[str, datetime] = {}
        status, data = imap.uid("SEARCH", "X-GM-RAW", '"in:sent newer_than:3d"')
        sent_uids = (data[0] or b"").split() if status == "OK" else []
        if sent_uids:
            status, rows = imap.uid("FETCH", b",".join(sent_uids[-60:]), "(X-GM-THRID INTERNALDATE)")
            for row in rows or []:
                line = row.decode() if isinstance(row, bytes) else (row[0].decode() if isinstance(row, tuple) else "")
                thr = re.search(r"X-GM-THRID (\d+)", line)
                when = re.search(r'INTERNALDATE "([^"]+)"', line)
                if thr and when:
                    t = datetime(*imaplib.Internaldate2tuple(f'INTERNALDATE "{when.group(1)}"'.encode())[:6])
                    replied[thr.group(1)] = max(replied.get(thr.group(1), t), t)

        status, data = imap.uid("SEARCH", "X-GM-RAW", '"in:inbox category:primary newer_than:2d -from:me"')
        uids = (data[0] or b"").split() if status == "OK" else []
        found = []
        if uids:
            status, rows = imap.uid("FETCH", b",".join(uids[-40:]),
                                    "(X-GM-THRID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS "
                                    "(FROM SUBJECT DATE LIST-UNSUBSCRIBE LIST-ID PRECEDENCE AUTO-SUBMITTED)])")
            for row in rows or []:
                if not isinstance(row, tuple):
                    continue
                meta = row[0].decode(errors="replace")
                msg = email.message_from_bytes(row[1], policy=email.policy.compat32)
                if _is_automated(msg) or _text(msg.get("Subject")).upper() == "BUDGET":
                    continue
                thr = re.search(r"X-GM-THRID (\d+)", meta)
                thread = thr.group(1) if thr else ""
                when = re.search(r'INTERNALDATE "([^"]+)"', meta)
                received = datetime(*imaplib.Internaldate2tuple(f'INTERNALDATE "{when.group(1)}"'.encode())[:6]) if when else now
                if thread in replied and replied[thread] >= received:
                    continue
                name, addr = email.utils.parseaddr(_text(msg.get("From")))
                if addr.lower() == address.lower():
                    continue
                found.append({
                    "thread": thread, "from": name or addr, "from_address": addr,
                    "subject": _text(msg.get("Subject")) or "(no subject)",
                    "received": received.isoformat(timespec="minutes"),
                    "unread": "\\Seen" not in meta,
                    "link": f"https://mail.google.com/mail/u/?authuser={address}#all/{int(thread):x}" if thread else None,
                })
        # One per conversation, newest first.
        seen, out = set(), []
        for m in sorted(found, key=lambda m: m["received"], reverse=True):
            if m["thread"] not in seen:
                seen.add(m["thread"])
                out.append(m)
        return out[:MAX_SHOWN]
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def demo_emails(now: datetime) -> list[dict]:
    t = lambda h: (now - timedelta(hours=h)).isoformat(timespec="minutes")   # noqa: E731
    return [
        {"thread": "1", "from": "Prof. Ana Ruiz", "from_address": "ana.ruiz@uni.example", "subject": "Re: Statistics project groups",
         "received": t(2), "unread": True, "link": None},
        {"thread": "2", "from": "Lucía", "from_address": "lucia@example.com", "subject": "Dinner on Thursday?",
         "received": t(9), "unread": False, "link": None},
        {"thread": "3", "from": "Secretaría", "from_address": "secretaria@uni.example", "subject": "Documentación pendiente de matrícula",
         "received": t(20), "unread": True, "link": None},
    ]


def get(conn: sqlite3.Connection, now: datetime | None = None, force: bool = False) -> dict:
    """{"enabled", "items", "error"} for the brief. Cached for a few minutes."""
    now = now or datetime.now()
    if config.demo():
        return {"enabled": True, "items": demo_emails(now), "error": None}
    cfg = get_config(conn)
    if not (cfg["enabled"] and cfg["address"]):
        return {"enabled": False, "items": [], "error": None}
    row = conn.execute("SELECT value, fetched_at FROM cache WHERE key = 'mail'").fetchone()
    if row and not force and _time.time() - row["fetched_at"] < CACHE_SECONDS:
        return json.loads(row["value"])
    password = get_password(cfg["address"])
    if not password:
        return {"enabled": True, "items": [], "error": "Add your Gmail app password in Settings"}
    try:
        result = {"enabled": True, "items": fetch_needs_reply(cfg["address"], password, now), "error": None}
    except Exception as exc:
        log.info("Gmail check failed: %s", exc)
        result = {"enabled": True, "items": json.loads(row["value"])["items"] if row else [], "error": str(exc)}
    conn.execute("INSERT INTO cache (key, value, fetched_at) VALUES ('mail', ?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value, fetched_at = excluded.fetched_at",
                 (json.dumps(result), _time.time()))
    conn.commit()
    return result
