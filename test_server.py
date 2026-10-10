import http.client
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server import DatabaseConnection, Handler, TippligaServer, league_standings, score_prediction


def fixture(match_id, group_id, group_name, kickoff, home, away, finished=False, result=None):
    return {
        "matchID": match_id,
        "matchDateTimeUTC": kickoff.isoformat(),
        "group": {"groupID": group_id, "groupName": group_name, "groupOrderID": group_id},
        "team1": {"teamId": match_id * 2, "teamName": home, "shortName": home, "teamIconUrl": "https://upload.wikimedia.org/home.png"},
        "team2": {"teamId": match_id * 2 + 1, "teamName": away, "shortName": away, "teamIconUrl": "https://upload.wikimedia.org/away.png"},
        "matchIsFinished": finished,
        "matchResults": ([{
            "resultTypeID": 2,
            "resultOrderID": 2,
            "pointsTeam1": result[0],
            "pointsTeam2": result[1],
        }] if result else []),
    }


class TippligaServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        now = datetime.now(timezone.utc)
        matches = [
            fixture(100, 1, "1. Spieltag", now - timedelta(days=7),
                    "Heim Alt", "Auswärts Alt", finished=True, result=(2, 1)),
            fixture(200, 2, "2. Spieltag", now + timedelta(days=2),
                    "Heim Neu", "Auswärts Neu"),
        ]
        def get_fixtures(_self, _season, competition="bl1"):
            if competition in {"rlw", "rlsw", "regio-bayern"}:
                return []
            return matches

        feed = type("TestFeed", (), {"get": get_fixtures})()
        db_path = Path(self.temp_dir.name) / "test.sqlite3"
        self.server = TippligaServer(("127.0.0.1", 0), Handler, db_path, feed)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.cookie = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_dir.cleanup()

    def request(self, method, path, body=None, consent=True):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        if path in {"/api/register", "/api/login"} and consent:
            headers["X-Tippliga-Cookie-Consent"] = "accepted"
        if self.cookie:
            headers["Cookie"] = self.cookie
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        data = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw.decode()
        cookies = {}
        for item in (self.cookie or "").split("; "):
            if "=" in item:
                name, value = item.split("=", 1)
                cookies[name] = value
        for name, value in response.getheaders():
            if name.lower() != "set-cookie":
                continue
            cookie_pair = value.split(";", 1)[0]
            cookie_name, cookie_value = cookie_pair.split("=", 1)
            if "Max-Age=0" in value:
                cookies.pop(cookie_name, None)
            else:
                cookies[cookie_name] = cookie_value
        self.cookie = "; ".join(f"{name}={value}" for name, value in cookies.items()) or None
        connection.close()
        return response.status, data

    def register(self, username="TestTipp", email="mara@example.de"):
        return self.request("POST", "/api/register", {
            "username": username,
            "firstName": "Mara",
            "lastName": "Muster",
            "email": email,
            "address": "",
            "phone": "",
            "password": "sicheres-test-passwort",
        })

    def test_postgres_adapter_translates_sqlite_placeholders(self):
        class FakeConnection:
            def execute(self, statement, parameters):
                self.statement = statement
                self.parameters = parameters

        connection = FakeConnection()
        database = DatabaseConnection(connection, postgres=True)
        database.execute("SELECT * FROM tips WHERE user_id = ? AND season = ?", (7, 2026))
        self.assertEqual(
            connection.statement,
            "SELECT * FROM tips WHERE user_id = %s AND season = %s",
        )
        self.assertEqual(connection.parameters, (7, 2026))

    def test_league_standings_are_calculated_from_finished_matches(self):
        first = fixture(
            1, 1, "1. Spieltag", datetime.now(timezone.utc) - timedelta(days=2),
            "Team Eins", "Team Zwei", finished=True, result=(2, 0),
        )
        second = fixture(
            2, 2, "2. Spieltag", datetime.now(timezone.utc) - timedelta(days=1),
            "Team Drei", "Team Eins", finished=True, result=(1, 1),
        )
        first["team1"]["teamId"] = 1
        first["team2"]["teamId"] = 2
        second["team1"]["teamId"] = 3
        second["team2"]["teamId"] = 1
        standings = league_standings([first, second])
        self.assertEqual(standings[0]["name"], "Team Eins")
        self.assertEqual(standings[0]["played"], 2)
        self.assertEqual(standings[0]["points"], 4)
        self.assertEqual(standings[0]["goalDifference"], 2)

    def test_authentication_requires_cookie_consent(self):
        status, error = self.request("POST", "/api/register", {
            "username": "NoConsent",
        }, consent=False)
        self.assertEqual(status, 403)
        self.assertIn("notwendige Cookies", error["error"])

        status, error = self.request("POST", "/api/login", {
            "identity": "TestTipp",
            "password": "sicheres-test-passwort",
        }, consent=False)
        self.assertEqual(status, 403)
        self.assertIn("notwendige Cookies", error["error"])

    def test_registration_requires_real_fields_and_persists_account(self):
        status, error = self.request("POST", "/api/register", {
            "username": "not valid",
            "password": "sicheres-test-passwort",
        })
        self.assertEqual(status, 400)
        self.assertIn("Benutzername", error["error"])

        status, created = self.register()
        self.assertEqual(status, 201)
        self.assertTrue(created["ok"])

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["me"]["firstName"], "Mara")
        self.assertEqual([player["username"] for player in state["leaderboard"]], ["TestTipp"])
        self.assertEqual(state["matchday"], "2. Spieltag")
        self.assertEqual(state["matches"][0]["home"], "Heim Neu")
        self.assertEqual(state["matches"][0]["homeShort"], "Heim Neu")
        self.assertEqual(state["matches"][0]["homeLogo"], "https://upload.wikimedia.org/home.png")

    def test_login_by_email_and_server_saved_tips_update_points(self):
        self.assertEqual(self.register()[0], 201)
        self.request("POST", "/api/logout", {})
        self.cookie = None
        status, response = self.request("POST", "/api/login", {
            "identity": "mara@example.de",
            "password": "sicheres-test-passwort",
        })
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])

        status, saved = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 200, "home": 1, "away": 0}],
        })
        self.assertEqual(status, 200)
        self.assertEqual(saved["emailStatus"], "not_configured")

        status, error = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 200, "home": 4, "away": 0}],
        })
        self.assertEqual(status, 409)
        self.assertIn("nicht mehr geändert", error["error"])

        with self.server.database() as db:
            user_id = db.execute("SELECT id FROM users WHERE username = 'TestTipp'").fetchone()["id"]
            db.execute(
                """INSERT INTO tips(user_id, season, match_id, matchday, home_goals,
                                    away_goals, updated_at)
                   VALUES (?, ?, 100, '1. Spieltag', 2, 1, ?)""",
                (user_id, datetime.now(timezone.utc).year,
                 datetime.now(timezone.utc).isoformat()),
            )

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["leaderboard"][0]["points"], 3)
        self.assertEqual(state["tips"]["200"], {"home": 1, "away": 0})

    def test_draft_is_restored_from_server_and_removed_after_submission(self):
        self.assertEqual(self.register()[0], 201)
        status, saved = self.request("POST", "/api/draft", {
            "predictions": [{"matchId": 200, "home": 3, "away": None}],
        })
        self.assertEqual(status, 200)
        self.assertTrue(saved["ok"])

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["draft"], {"200": {"home": 3}})

        status, _ = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 200, "home": 3, "away": 1}],
        })
        self.assertEqual(status, 200)

        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual(state["draft"], {})
        self.assertEqual(state["tips"]["200"], {"home": 3, "away": 1})

    def test_competitions_keep_tips_and_leaderboards_separate(self):
        self.assertEqual(self.register()[0], 201)
        for competition_code, score in (("bl1", (1, 0)), ("bl2", (0, 1))):
            status, result = self.request("POST", "/api/tips", {
                "competitionCode": competition_code,
                "tips": [{"matchId": 200, "home": score[0], "away": score[1]}],
            })
            self.assertEqual(status, 200, result)
            status, state = self.request(
                "GET", f"/api/state?competition={competition_code}"
            )
            self.assertEqual(status, 200)
            self.assertEqual(state["competition"]["code"], competition_code)
            self.assertEqual(state["tips"]["200"], {
                "home": score[0], "away": score[1],
            })

        status, catalog = self.request("GET", "/api/competitions")
        self.assertEqual(status, 200)
        self.assertIn("bl1", [item["code"] for item in catalog["competitions"]])
        self.assertIn("bl2", [item["code"] for item in catalog["competitions"]])
        by_code = {item["code"]: item for item in catalog["competitions"]}
        self.assertIn("bl3", by_code)
        self.assertEqual(by_code["bl3"]["category"], "Bundesliga (1.–3. Liga)")
        self.assertTrue(by_code["rlw"]["available"] is False)
        self.assertTrue(by_code["rlsw"]["available"] is False)
        for code in ("rln", "rlno", "rlw", "rlsw", "regio-bayern"):
            self.assertIn(code, by_code)

        status, unavailable_state = self.request("GET", "/api/state?competition=rlw")
        self.assertEqual(status, 200)
        self.assertEqual(unavailable_state["competition"]["code"], "rlw")
        self.assertEqual(unavailable_state["matches"], [])
        self.assertEqual(unavailable_state["standings"], [])
        self.assertEqual(unavailable_state["matchday"], "Noch keine Spiele verfügbar")

    def test_legacy_sqlite_tips_and_drafts_migrate_to_bl1(self):
        legacy_path = Path(self.temp_dir.name) / "legacy.sqlite3"
        connection = sqlite3.connect(legacy_path)
        connection.executescript("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL,
                first_name TEXT NOT NULL, last_name TEXT NOT NULL, address TEXT, phone TEXT,
                password_hash TEXT NOT NULL, created_at TEXT NOT NULL
            );
            INSERT INTO users VALUES (1, 'Legacy', 'legacy@example.de', 'Alt', 'Konto',
                NULL, NULL, 'hash', '2026-01-01T00:00:00+00:00');
            CREATE TABLE tips (
                user_id INTEGER NOT NULL, season INTEGER NOT NULL, match_id INTEGER NOT NULL,
                matchday TEXT NOT NULL, home_goals INTEGER NOT NULL, away_goals INTEGER NOT NULL,
                updated_at TEXT NOT NULL, PRIMARY KEY(user_id, season, match_id)
            );
            INSERT INTO tips VALUES (1, 2026, 200, '2. Spieltag', 2, 1, '2026-01-01');
            CREATE TABLE tip_drafts (
                user_id INTEGER NOT NULL, season INTEGER NOT NULL, matchday TEXT NOT NULL,
                predictions TEXT NOT NULL, updated_at TEXT NOT NULL,
                PRIMARY KEY(user_id, season, matchday)
            );
            INSERT INTO tip_drafts VALUES
                (1, 2026, '2. Spieltag', '{"200":{"home":3}}', '2026-01-01');
        """)
        connection.commit()
        connection.close()

        migrated_server = TippligaServer(
            ("127.0.0.1", 0), Handler, legacy_path, self.server.fixture_feed
        )
        try:
            with migrated_server.database() as db:
                legacy_tip = db.execute(
                    """SELECT competition_code FROM tips
                       WHERE user_id = 1 AND season = 2026 AND match_id = 200"""
                ).fetchone()
                self.assertEqual(legacy_tip["competition_code"], "bl1")
                db.execute(
                    """INSERT INTO tips(user_id, season, competition_code, match_id, matchday,
                                        home_goals, away_goals, updated_at)
                       VALUES (1, 2026, 'bl2', 200, '2. Spieltag', 1, 0, '2026-01-02')"""
                )
                migrated_draft = db.execute(
                    """SELECT predictions FROM competition_tip_drafts
                       WHERE user_id = 1 AND season = 2026 AND competition_code = 'bl1'"""
                ).fetchone()
                self.assertEqual(json.loads(migrated_draft["predictions"]), {"200": {"home": 3}})
        finally:
            migrated_server.server_close()

    def test_admin_can_suspend_players_and_block_registration_names(self):
        self.server.admin_username = "adminowner"
        self.assertEqual(self.register("adminowner", "admin@example.de")[0], 201)
        admin_cookie = self.cookie
        self.cookie = None
        self.assertEqual(self.register()[0], 201)
        player_cookie = self.cookie
        with self.server.database() as db:
            player_id = db.execute("SELECT id FROM users WHERE username = 'TestTipp'").fetchone()["id"]

        self.cookie = admin_cookie
        status, admin_state = self.request("GET", "/api/state")
        self.assertTrue(admin_state["me"]["isAdmin"])
        status, data = self.request("GET", "/api/admin")
        self.assertEqual(status, 200)
        self.assertEqual(len(data["users"]), 2)
        admin_id = next(user["id"] for user in data["users"] if user["username"] == "adminowner")
        status, error = self.request("POST", "/api/admin/user", {
            "userId": admin_id,
            "banned": True,
        })
        self.assertEqual(status, 400)
        status, error = self.request("POST", "/api/admin/username", {
            "username": "ADMINOWNER",
            "blocked": True,
        })
        self.assertEqual(status, 400)
        status, error = self.request("POST", "/api/admin/user/delete", {
            "userId": admin_id,
        })
        self.assertEqual(status, 400)

        status, result = self.request("POST", "/api/admin/user", {
            "userId": player_id,
            "banned": True,
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        player_device = dict(
            item.split("=", 1) for item in player_cookie.split("; ")
        )["tippliga_device"]
        with self.server.database() as db:
            blocked = db.execute(
                "SELECT blocked_until FROM blocked_devices WHERE device_hash = ?",
                (hashlib.sha256(player_device.encode("ascii")).hexdigest(),),
            ).fetchone()
            admin_device = dict(
                item.split("=", 1) for item in admin_cookie.split("; ")
            )["tippliga_device"]
            self.assertIsNone(db.execute(
                "SELECT device_hash FROM blocked_devices WHERE device_hash = ?",
                (hashlib.sha256(admin_device.encode("ascii")).hexdigest(),),
            ).fetchone())
        blocked_until = datetime.fromisoformat(blocked["blocked_until"])
        self.assertGreater(blocked_until, datetime.now(timezone.utc) + timedelta(days=29))
        self.assertLess(blocked_until, datetime.now(timezone.utc) + timedelta(days=31))

        self.cookie = player_cookie
        status, state = self.request("GET", "/api/state")
        self.assertIsNone(state["me"])
        self.assertEqual([entry["username"] for entry in state["leaderboard"]], ["adminowner"])
        status, error = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 200, "home": 1, "away": 0}],
        })
        self.assertEqual(status, 401)
        status, error = self.request("POST", "/api/login", {
            "identity": "adminowner",
            "password": "sicheres-test-passwort",
        })
        self.assertEqual(status, 403)
        self.assertIn("Gerät", error["error"])
        status, error = self.request("POST", "/api/register", {
            "username": "NeuesKonto",
            "firstName": "Neu",
            "lastName": "Konto",
            "email": "neueskonto@example.de",
            "password": "sicheres-test-passwort",
        })
        self.assertEqual(status, 403)

        self.cookie = admin_cookie
        status, result = self.request("POST", "/api/admin/username", {
            "username": "BadName",
            "blocked": True,
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.cookie = None
        status, error = self.register("BadName", "badname@example.de")
        self.assertEqual(status, 400)
        self.assertIn("nicht erlaubt", error["error"])

        self.cookie = admin_cookie
        status, result = self.request("POST", "/api/admin/user", {
            "userId": player_id,
            "banned": False,
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.cookie = None
        status, result = self.request("POST", "/api/login", {
            "identity": "TestTipp",
            "password": "sicheres-test-passwort",
        })
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])

    def test_admin_can_delete_account_without_banning_and_remove_tips(self):
        self.server.admin_username = "adminowner"
        self.assertEqual(self.register("adminowner", "admin@example.de")[0], 201)
        admin_cookie = self.cookie
        self.cookie = None
        self.assertEqual(self.register()[0], 201)
        status, saved = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 200, "home": 2, "away": 1}],
        })
        self.assertEqual(status, 200)
        with self.server.database() as db:
            user_id = db.execute("SELECT id FROM users WHERE username = 'TestTipp'").fetchone()["id"]

        self.cookie = admin_cookie
        status, result = self.request("POST", "/api/admin/user/delete", {"userId": user_id})
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        with self.server.database() as db:
            self.assertIsNone(db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone())
            self.assertIsNone(db.execute("SELECT user_id FROM tips WHERE user_id = ?", (user_id,)).fetchone())
            self.assertIsNone(db.execute("SELECT user_id FROM user_devices WHERE user_id = ?", (user_id,)).fetchone())

    def test_non_admin_cannot_access_moderation(self):
        self.assertEqual(self.register()[0], 201)
        status, error = self.request("GET", "/api/admin")
        self.assertEqual(status, 403)
        self.assertIn("Administration", error["error"])
        status, error = self.request("POST", "/api/admin/user/delete", {"userId": 1})
        self.assertEqual(status, 403)

    def test_tip_rejects_match_outside_current_round(self):
        self.assertEqual(self.register()[0], 201)
        status, error = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 100, "home": 2, "away": 1}],
        })
        self.assertEqual(status, 400)
        self.assertIn("aktuellen Spieltag", error["error"])

    def test_scoring_bundesliga_points_for_correct_outcome_and_partial_score(self):
        self.assertEqual(score_prediction((2, 1), (2, 1)), 3)
        self.assertEqual(score_prediction((1, 2), (0, 2)), 3)
        self.assertEqual(score_prediction((4, 2), (1, 0)), 3)
        self.assertEqual(score_prediction((1, 1), (2, 2)), 1)
        self.assertEqual(score_prediction((2, 0), (2, 2)), 1)
        self.assertEqual(score_prediction((0, 0), (0, 0)), 1)
        self.assertEqual(score_prediction((0, 3), (2, 2)), 0)
        self.assertEqual(score_prediction((0, 2), (2, 0)), 0)

    def test_health_and_sensitive_server_files(self):
        status, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])

        status, _ = self.request("GET", "/server.py")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
