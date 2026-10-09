import test from "node:test";
import assert from "node:assert/strict";
import {
  currentMatchday,
  resultOf,
  publicMatch,
  scorePrediction,
  seasonFor,
  validateRegistration,
} from "./netlify/functions/helpers.mjs";
import handler from "./netlify/functions/api.mjs";

function fixture(matchID, groupID, groupName, kickoff, finished = false) {
  return {
    matchID,
    matchDateTimeUTC: kickoff.toISOString(),
    group: { groupID, groupName, groupOrderID: groupID },
    team1: { teamName: "Heim", shortName: "Heim", teamIconUrl: "" },
    team2: { teamName: "Auswärts", shortName: "Auswärts", teamIconUrl: "" },
    matchIsFinished: finished,
    matchResults: [],
  };
}

test("Bundesliga season follows Berlin calendar date", () => {
  assert.equal(seasonFor(new Date("2026-08-01T12:00:00Z")), 2026);
  assert.equal(seasonFor(new Date("2026-02-01T12:00:00Z")), 2025);
});

test("scoring handles exact scores, tendencies, and draws", () => {
  assert.equal(scorePrediction([2, 1], [2, 1]), 3);
  assert.equal(scorePrediction([4, 2], [1, 0]), 1);
  assert.equal(scorePrediction([1, 1], [0, 0]), 1);
  assert.equal(scorePrediction([0, 2], [2, 0]), 0);
});

test("finished results prefer the final result entry", () => {
  const match = fixture(1, 1, "1. Spieltag", new Date(), true);
  match.matchResults = [
    { resultTypeID: 1, resultOrderID: 1, pointsTeam1: 1, pointsTeam2: 0 },
    { resultTypeID: 2, resultOrderID: 2, pointsTeam1: 2, pointsTeam2: 1 },
  ];
  assert.deepEqual(resultOf(match), [2, 1]);
});

test("public match includes German local date and the expected client fields", () => {
  const match = fixture(21, 4, "4. Spieltag", new Date("2026-10-10T13:30:00Z"));
  const result = publicMatch(match);
  assert.equal(result.day, "SA, 10. OKT");
  assert.equal(result.time, "15:30");
  assert.equal(result.home, "Heim");
  assert.equal(result.result, null);
});

test("current matchday selects the nearest group with an open match", () => {
  const now = new Date("2026-10-09T10:00:00Z");
  const previous = fixture(1, 1, "1. Spieltag", new Date("2026-10-01T10:00:00Z"), true);
  const next = fixture(2, 2, "2. Spieltag", new Date("2026-10-10T10:00:00Z"));
  const selected = currentMatchday([previous, next], now);
  assert.equal(selected.group.groupName, "2. Spieltag");
  assert.deepEqual(selected.matches.map(({ matchID }) => matchID), [2]);
});

test("registration validates required fields and normalizes email", () => {
  const fields = validateRegistration({
    username: "Tipp_User",
    email: "  USER@example.de ",
    firstName: "Vorname",
    lastName: "Nachname",
    password: "langes-passwort",
  });
  assert.equal(fields.email, "user@example.de");
  assert.equal(fields.username, "Tipp_User");
  assert.throws(() => validateRegistration({ username: "x" }), /Benutzername/);
});

test("function returns JSON for unknown API routes", async () => {
  const response = await handler(new Request("https://example.net/api/unknown"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "API-Endpunkt nicht gefunden." });
});

test("function validates registration before requiring a database", async () => {
  const response = await handler(new Request("https://example.net/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "x" }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Benutzername/);
});
