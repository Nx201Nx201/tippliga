import http.client
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server import DatabaseConnection, Handler, TippligaServer, score_prediction


def fixture(match_id, group_id, group_name, kickoff, home, away, finished=False, result=None):
    return {
        "matchID": match_id,
        "matchDateTimeUTC": kickoff.isoformat(),
        "group": {"groupID": group_id, "groupName": group_name, "groupOrderID": group_id},
        "team1": {"teamName": home, "shortName": home, "teamIconUrl": "https://upload.wikimedia.org/home.png"},
        "team2": {"teamName": away, "shortName": away, "teamIconUrl": "https://upload.wikimedia.org/away.png"},
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
        feed = type("TestFeed", (), {"get": lambda _self, _season: matches})()
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

    def request(self, method, path, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        payload = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if payload else {}
        if self.cookie:
            headers["Cookie"] = self.cookie
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        data = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw.decode()
        cookie = response.getheader("Set-Cookie")
        if cookie and "Max-Age=0" not in cookie:
            self.cookie = cookie.split(";", 1)[0]
        connection.close()
        return response.status, data

    def register(self):
        return self.request("POST", "/api/register", {
            "username": "TestTipp",
            "firstName": "Mara",
            "lastName": "Muster",
            "email": "mara@example.de",
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

    def test_tip_rejects_match_outside_current_round(self):
        self.assertEqual(self.register()[0], 201)
        status, error = self.request("POST", "/api/tips", {
            "tips": [{"matchId": 100, "home": 2, "away": 1}],
        })
        self.assertEqual(status, 400)
        self.assertIn("aktuellen Spieltag", error["error"])

    def test_scoring_exact_tendency_and_wrong_outcome(self):
        self.assertEqual(score_prediction((2, 1), (2, 1)), 3)
        self.assertEqual(score_prediction((4, 2), (1, 0)), 1)
        self.assertEqual(score_prediction((1, 1), (0, 0)), 1)
        self.assertEqual(score_prediction((0, 2), (2, 0)), 0)

    def test_health_and_sensitive_server_files(self):
        status, health = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(health["ok"])

        status, _ = self.request("GET", "/server.py")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
