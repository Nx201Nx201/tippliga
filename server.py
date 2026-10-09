#!/usr/bin/env python3
"""Tippliga web server: accounts, saved tips, and live Bundesliga fixtures."""

from __future__ import annotations

import hashlib
import hmac
import http.cookies
import json
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "data" / "tippliga.sqlite3"
OPENLIGADB = "https://api.openligadb.de/getmatchdata/bl1"
COOKIE_NAME = "tippliga_session"
SESSION_DAYS = 30
FIXTURE_CACHE_SECONDS = 600
BERLIN = ZoneInfo("Europe/Berlin")
MAIL_TO = "nx201nx201@outlook.de"
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,24}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tips (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    matchday TEXT NOT NULL,
    home_goals INTEGER NOT NULL CHECK(home_goals BETWEEN 0 AND 20),
    away_goals INTEGER NOT NULL CHECK(away_goals BETWEEN 0 AND 20),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id, season, match_id)
);
CREATE INDEX IF NOT EXISTS tips_season_idx ON tips(season, match_id);
"""


def season_for(day: date) -> int:
    return day.year if day.month >= 7 else day.year - 1


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def password_matches(password: str, stored: str) -> bool:
    try:
        algorithm, salt_hex, digest_hex = stored.split("$", 2)
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1
        )
        return hmac.compare_digest(actual.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def result_of(match: dict) -> tuple[int, int] | None:
    if not match.get("matchIsFinished"):
        return None
    results = match.get("matchResults") or []
    final = next((item for item in results if item.get("resultTypeID") == 2), None)
    if final is None and results:
        final = max(results, key=lambda item: item.get("resultOrderID", 0))
    if final is None:
        return None
    return int(final["pointsTeam1"]), int(final["pointsTeam2"])


def score_prediction(predicted: tuple[int, int], actual: tuple[int, int]) -> int:
    if predicted == actual:
        return 3
    if (
        (predicted[0] > predicted[1]) == (actual[0] > actual[1])
        and (predicted[0] < predicted[1]) == (actual[0] < actual[1])
    ):
        return 1
    return 0


def current_matchday(matches: list[dict], now: datetime | None = None) -> tuple[dict, list[dict]]:
    if not matches:
        raise ValueError("Der Spielplan enthält noch keine Spiele.")
    now = now or datetime.now(timezone.utc)
    groups: dict[int, list[dict]] = {}
    for match in matches:
        group = match.get("group") or {}
        group_id = group.get("groupID")
        if group_id is not None:
            groups.setdefault(int(group_id), []).append(match)
    if not groups:
        raise ValueError("Im Spielplan fehlen Spieltagsangaben.")

    candidates = []
    for group_matches in groups.values():
        open_matches = [m for m in group_matches if not m.get("matchIsFinished")]
        if not open_matches:
            continue
        kickoffs = [datetime.fromisoformat(m["matchDateTimeUTC"]).replace(tzinfo=timezone.utc)
                    for m in open_matches]
        nearest = min(kickoffs)
        if nearest >= now - timedelta(hours=8):
            candidates.append((nearest, group_matches))
    if candidates:
        selected = min(candidates, key=lambda item: item[0])[1]
    else:
        upcoming = []
        for group_matches in groups.values():
            open_matches = [m for m in group_matches if not m.get("matchIsFinished")]
            if open_matches:
                kickoff = min(
                    datetime.fromisoformat(m["matchDateTimeUTC"]).replace(tzinfo=timezone.utc)
                    for m in open_matches
                )
                upcoming.append((kickoff, group_matches))
        selected = min(upcoming, key=lambda item: item[0])[1] if upcoming else max(
            groups.values(),
            key=lambda group: max(m["group"]["groupOrderID"] for m in group),
        )

    selected.sort(key=lambda m: m["matchDateTimeUTC"])
    return selected[0]["group"], selected


def public_match(match: dict) -> dict:
    kickoff = datetime.fromisoformat(match["matchDateTimeUTC"]).replace(tzinfo=timezone.utc)
    local = kickoff.astimezone(BERLIN)
    group = match["group"]
    result = result_of(match)
    home_team = match["team1"]
    away_team = match["team2"]
    home_logo = home_team.get("teamIconUrl")
    away_logo = away_team.get("teamIconUrl")
    if home_team.get("teamName") == "Bayer 04 Leverkusen":
        home_logo = "https://upload.wikimedia.org/wikipedia/en/5/59/Bayer_04_Leverkusen_logo.svg"
    if away_team.get("teamName") == "Bayer 04 Leverkusen":
        away_logo = "https://upload.wikimedia.org/wikipedia/en/5/59/Bayer_04_Leverkusen_logo.svg"
    german_months = ("JAN", "FEB", "MÄR", "APR", "MAI", "JUN",
                     "JUL", "AUG", "SEP", "OKT", "NOV", "DEZ")
    german_weekdays = ("MO", "DI", "MI", "DO", "FR", "SA", "SO")
    return {
        "id": int(match["matchID"]),
        "date": kickoff.isoformat(),
        "day": f'{german_weekdays[local.weekday()]}, {local.day:02d}. {german_months[local.month - 1]}',
        "time": local.strftime("%H:%M"),
        "home": home_team["teamName"],
        "away": away_team["teamName"],
        "homeShort": home_team["shortName"],
        "awayShort": away_team["shortName"],
        "homeLogo": home_logo,
        "awayLogo": away_logo,
        "matchday": group["groupName"],
        "matchdayId": int(group["groupID"]),
        "finished": bool(match["matchIsFinished"]),
        "result": {"home": result[0], "away": result[1]} if result else None,
    }


class FixtureFeed:
    def __init__(self, fetcher=None):
        self.fetcher = fetcher or self._fetch
        self.cache: dict[int, tuple[float, list[dict]]] = {}
        self.lock = threading.Lock()

    @staticmethod
    def _fetch(season: int) -> list[dict]:
        request = urllib.request.Request(
            f"{OPENLIGADB}/{season}",
            headers={"User-Agent": "Tippliga/1.0 (Bundesliga tip game)"},
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read(5_000_000))
        if not isinstance(data, list):
            raise ValueError("Die Spielplan-Quelle hat ein unerwartetes Format geliefert.")
        return data

    def get(self, season: int) -> list[dict]:
        with self.lock:
            cached = self.cache.get(season)
            if cached and time.monotonic() - cached[0] < FIXTURE_CACHE_SECONDS:
                return cached[1]
        matches = self.fetcher(season)
        with self.lock:
            self.cache[season] = (time.monotonic(), matches)
        return matches


class TippligaServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, db_path=DEFAULT_DB, fixture_feed=None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.fixture_feed = fixture_feed or FixtureFeed()
        self.login_attempts: dict[str, list[float]] = {}
        self.login_lock = threading.Lock()
        with self.database() as db:
            db.executescript(SCHEMA)
        super().__init__(address, handler)

    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    @contextmanager
    def database(self):
        db = self.connect()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()


class Handler(SimpleHTTPRequestHandler):
    server: TippligaServer

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print(f"{self.log_date_time_string()} {self.address_string()} {fmt % args}")

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; "
            "img-src 'self' data: https://upload.wikimedia.org https://i.imgur.com "
            "https://assets.dfb.de https://www.bundesliga-reisefuehrer.de https://www.bundesliga.com; "
            "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        )
        super().end_headers()

    def _json(self, status: HTTPStatus, data: dict, headers: dict | None = None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 32_768:
                raise ValueError("Die Anfrage ist leer oder zu groß.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Ungültige Anfrage.")
            return data
        except (ValueError, json.JSONDecodeError) as exc:
            raise ValueError("Ungültige Anfrage.") from exc

    def _session_token(self):
        cookie_header = self.headers.get("Cookie", "")
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(cookie_header)
        except http.cookies.CookieError:
            return None
        morsel = cookie.get(COOKIE_NAME)
        return morsel.value if morsel else None

    def _current_user(self):
        token = self._session_token()
        if not token:
            return None
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        with self.server.database() as db:
            return db.execute(
                """SELECT users.id, users.username, users.email, users.first_name,
                          users.last_name
                   FROM sessions JOIN users ON users.id = sessions.user_id
                   WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
                (digest, datetime.now(timezone.utc).isoformat()),
            ).fetchone()

    def _set_session(self, user_id: int):
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        with self.server.database() as db:
            db.execute(
                "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (digest, user_id, expires.isoformat()),
            )
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (datetime.now(timezone.utc).isoformat(),))
        cookie = f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DAYS * 86400}"
        if os.environ.get("COOKIE_SECURE", "").lower() in {"1", "true", "yes"}:
            cookie += "; Secure"
        return {"Set-Cookie": cookie}

    def _clear_session(self, token: str | None):
        if token:
            digest = hashlib.sha256(token.encode("ascii")).hexdigest()
            with self.server.database() as db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (digest,))
        cookie = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        if os.environ.get("COOKIE_SECURE", "").lower() in {"1", "true", "yes"}:
            cookie += "; Secure"
        return {"Set-Cookie": cookie}

    def _allow_login_attempt(self):
        now = time.monotonic()
        client = self.client_address[0]
        with self.server.login_lock:
            attempts = [stamp for stamp in self.server.login_attempts.get(client, []) if now - stamp < 60]
            if len(attempts) >= 10:
                self.server.login_attempts[client] = attempts
                return False
            attempts.append(now)
            self.server.login_attempts[client] = attempts
            return True

    def _season_matches(self):
        return self.server.fixture_feed.get(season_for(datetime.now(BERLIN).date()))

    def _state(self):
        matches = self._season_matches()
        group, active_matches = current_matchday(matches)
        active = [public_match(match) for match in active_matches]
        user = self._current_user()
        with self.server.database() as db:
            leaderboard = db.execute(
                """SELECT u.id, u.username, COUNT(DISTINCT t.matchday) AS matchdays
                   FROM users u LEFT JOIN tips t ON t.user_id = u.id AND t.season = ?
                   GROUP BY u.id ORDER BY u.username COLLATE NOCASE""",
                (season_for(datetime.now(BERLIN).date()),),
            ).fetchall()
            tips = []
            if user:
                tips = [dict(row) for row in db.execute(
                    """SELECT match_id, home_goals, away_goals FROM tips
                       WHERE user_id = ? AND season = ? AND matchday = ?""",
                    (user["id"], season_for(datetime.now(BERLIN).date()), group["groupName"]),
                )]
            all_tips = db.execute(
                """SELECT user_id, match_id, home_goals, away_goals FROM tips
                   WHERE season = ?""",
                (season_for(datetime.now(BERLIN).date()),),
            ).fetchall()

        results = {int(match["matchID"]): result_of(match) for match in matches}
        user_scores: dict[int, int] = {}
        for tip in all_tips:
            result = results.get(tip["match_id"])
            if result is None:
                continue
            predicted = (tip["home_goals"], tip["away_goals"])
            points = score_prediction(predicted, result)
            user_scores[tip["user_id"]] = user_scores.get(tip["user_id"], 0) + points

        ranked = [
            {"username": row["username"], "matchdays": row["matchdays"],
             "points": user_scores.get(row["id"], 0)}
            for row in leaderboard
        ]
        ranked.sort(key=lambda player: (-player["points"], player["username"].casefold()))
        return {
            "season": f"{season_for(datetime.now(BERLIN).date())}/{str(season_for(datetime.now(BERLIN).date()) + 1)[-2:]}",
            "matchday": group["groupName"],
            "matches": active,
            "leaderboard": ranked,
            "me": {
                "username": user["username"],
                "firstName": user["first_name"],
                "lastName": user["last_name"],
            } if user else None,
            "tips": {str(tip["match_id"]): {
                "home": tip["home_goals"], "away": tip["away_goals"]
            } for tip in tips},
        }

    def _send_tip_email(self, username: str, matchday: str, lines: list[str]):
        config = {
            "host": os.environ.get("SMTP_HOST"),
            "port": os.environ.get("SMTP_PORT"),
            "user": os.environ.get("SMTP_USER"),
            "password": os.environ.get("SMTP_PASSWORD"),
            "sender": os.environ.get("SMTP_FROM"),
        }
        if not all(config.values()):
            return "not_configured"
        message = EmailMessage()
        message["Subject"] = f"Tippliga: {matchday} – Tipps von {username}"
        message["From"] = config["sender"]
        message["To"] = MAIL_TO
        message.set_content(f"Tipps von {username} für {matchday}\n\n" + "\n".join(lines))
        try:
            with smtplib.SMTP(config["host"], int(config["port"]), timeout=10) as smtp:
                smtp.starttls()
                smtp.login(config["user"], config["password"])
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException, ValueError):
            return "failed"
        return "sent"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/health":
            try:
                with self.server.database() as db:
                    db.execute("SELECT 1")
                self._json(HTTPStatus.OK, {"ok": True})
            except sqlite3.Error:
                self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False})
            return
        if path == "/api/state":
            try:
                self._json(HTTPStatus.OK, self._state())
            except (OSError, urllib.error.URLError, TimeoutError, ValueError, KeyError, sqlite3.Error) as exc:
                self._json(HTTPStatus.BAD_GATEWAY, {
                    "error": f"Der aktuelle Bundesliga-Spielplan ist gerade nicht verfügbar: {exc}"
                })
            return
        if path.startswith("/api/"):
            self._json(HTTPStatus.NOT_FOUND, {"error": "API-Endpunkt nicht gefunden."})
            return
        if path not in {"/", "/index.html", "/styles.css", "/app.js"}:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Seite nicht gefunden."})
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            data = self._body()
        except ValueError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        if path in {"/api/register", "/api/login", "/api/logout", "/api/tips"}:
            origin = self.headers.get("Origin")
            host = self.headers.get("Host")
            if origin and host and urlsplit(origin).netloc != host:
                self._json(HTTPStatus.FORBIDDEN, {"error": "Ungültige Anfragequelle."})
                return

        if path == "/api/register":
            self._register(data)
        elif path == "/api/login":
            self._login(data)
        elif path == "/api/logout":
            self._json(HTTPStatus.OK, {"ok": True}, self._clear_session(self._session_token()))
        elif path == "/api/tips":
            self._save_tips(data)
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "API-Endpunkt nicht gefunden."})

    def _register(self, data: dict):
        username = str(data.get("username", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        first_name = str(data.get("firstName", "")).strip()
        last_name = str(data.get("lastName", "")).strip()
        address = str(data.get("address", "")).strip()
        phone = str(data.get("phone", "")).strip()
        password = data.get("password", "")
        if not USERNAME_RE.fullmatch(username):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Benutzername: 3–24 Zeichen (Buchstaben, Zahlen, Punkt, _ oder -)."})
            return
        if not isinstance(password, str) or not 10 <= len(password) <= 256:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Das Passwort muss mindestens 10 Zeichen lang sein."})
            return
        if not EMAIL_RE.fullmatch(email) or len(email) > 254:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Bitte gib eine gültige E-Mail-Adresse ein."})
            return
        for label, value in (("Vorname", first_name), ("Nachname", last_name)):
            if not value or len(value) > 80 or any(ord(char) < 32 for char in value):
                self._json(HTTPStatus.BAD_REQUEST, {"error": f"{label} ist erforderlich und darf höchstens 80 Zeichen lang sein."})
                return
        if len(address) > 240 or len(phone) > 40:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Adresse oder Telefonnummer ist zu lang."})
            return
        try:
            encoded_password = password_hash(password)
            with self.server.database() as db:
                cursor = db.execute(
                    """INSERT INTO users(username, email, first_name, last_name, address,
                                          phone, password_hash, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (username, email, first_name, last_name, address, phone,
                     encoded_password, datetime.now(timezone.utc).isoformat()),
                )
            headers = self._set_session(cursor.lastrowid)
            self._json(HTTPStatus.CREATED, {"ok": True, "username": username}, headers)
        except sqlite3.IntegrityError:
            self._json(HTTPStatus.CONFLICT, {"error": "Benutzername oder E-Mail-Adresse ist bereits registriert."})
        except sqlite3.Error as exc:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Konto konnte nicht gespeichert werden: {exc}"})

    def _login(self, data: dict):
        if not self._allow_login_attempt():
            self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Zu viele Anmeldeversuche. Bitte warte eine Minute."})
            return
        identity = str(data.get("identity", "")).strip()
        password = data.get("password", "")
        if not identity or not isinstance(password, str):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Bitte Benutzername/E-Mail und Passwort eingeben."})
            return
        with self.server.database() as db:
            user = db.execute(
                "SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE",
                (identity, identity),
            ).fetchone()
        if not user or not password_matches(password, user["password_hash"]):
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Anmeldedaten stimmen nicht."})
            return
        self._json(HTTPStatus.OK, {"ok": True, "username": user["username"]},
                   self._set_session(user["id"]))

    def _save_tips(self, data: dict):
        user = self._current_user()
        if not user:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Bitte melde dich zuerst an."})
            return
        submitted = data.get("tips")
        if not isinstance(submitted, list) or not submitted or len(submitted) > 20:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Bitte gib mindestens einen gültigen Tipp ab."})
            return
        try:
            matches = self._season_matches()
            group, active_matches = current_matchday(matches)
            current_by_id = {int(match["matchID"]): match for match in active_matches}
            values = []
            lines = []
            now = datetime.now(timezone.utc)
            seen = set()
            for item in submitted:
                if not isinstance(item, dict):
                    raise ValueError("Ungültiger Tipp.")
                match_id = item.get("matchId")
                home = item.get("home")
                away = item.get("away")
                if any(isinstance(value, bool) or not isinstance(value, int)
                       for value in (match_id, home, away)):
                    raise ValueError("Bitte ganze Zahlen für Spiel und Ergebnis angeben.")
                if match_id in seen or not 0 <= home <= 20 or not 0 <= away <= 20:
                    raise ValueError("Jedes Ergebnis muss eine ganze Zahl zwischen 0 und 20 sein.")
                match = current_by_id.get(match_id)
                if match is None:
                    raise ValueError("Ein Tipp gehört nicht zum aktuellen Spieltag.")
                kickoff = datetime.fromisoformat(match["matchDateTimeUTC"]).replace(tzinfo=timezone.utc)
                if match.get("matchIsFinished") or kickoff <= now:
                    raise ValueError("Für ein bereits begonnenes Spiel kann kein Tipp mehr abgegeben werden.")
                seen.add(match_id)
                values.append((user["id"], season_for(datetime.now(BERLIN).date()), match_id,
                               group["groupName"], home, away, now.isoformat()))
                lines.append(
                    f'{match["team1"]["shortName"]} {home}:{away} {match["team2"]["shortName"]}'
                )
            with self.server.database() as db:
                db.executemany(
                    """INSERT INTO tips(user_id, season, match_id, matchday, home_goals,
                                        away_goals, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(user_id, season, match_id) DO UPDATE SET
                         home_goals = excluded.home_goals, away_goals = excluded.away_goals,
                         updated_at = excluded.updated_at""",
                    values,
                )
            email_status = self._send_tip_email(user["username"], group["groupName"], lines)
            self._json(HTTPStatus.OK, {
                "ok": True,
                "emailStatus": email_status,
            })
        except (ValueError, KeyError, TypeError) as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc) or "Ungültiger Tipp."})
        except (OSError, urllib.error.URLError, TimeoutError, sqlite3.Error) as exc:
            self._json(HTTPStatus.BAD_GATEWAY, {"error": f"Tipps konnten nicht sicher gespeichert werden: {exc}"})


def main():
    host = os.environ.get("TIPPLIGA_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", os.environ.get("TIPPLIGA_PORT", "8000")))
    db_path = Path(os.environ.get("TIPPLIGA_DB", str(DEFAULT_DB)))
    server = TippligaServer((host, port), Handler, db_path=db_path)
    print(f"Tippliga läuft auf http://{host}:{port}")
    print(f"SQLite-Datenbank: {db_path.resolve()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nTippliga wird beendet.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
