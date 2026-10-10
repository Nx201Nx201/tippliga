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
import handler, { leagueStandings } from "./netlify/functions/api.mjs";

function fixture(matchID, groupID, groupName, kickoff, finished = false) {
  return {
    matchID,
    matchDateTimeUTC: kickoff.toISOString(),
    group: { groupID, groupName, groupOrderID: groupID },
    team1: { teamId: matchID * 2, teamName: "Heim", shortName: "Heim", teamIconUrl: "" },
    team2: { teamId: matchID * 2 + 1, teamName: "Auswärts", shortName: "Auswärts", teamIconUrl: "" },
    matchIsFinished: finished,
    matchResults: [],
  };
}

test("Bundesliga season follows Berlin calendar date", () => {
  assert.equal(seasonFor(new Date("2026-08-01T12:00:00Z")), 2026);
  assert.equal(seasonFor(new Date("2026-02-01T12:00:00Z")), 2025);
});

test("scoring gives Bundesliga points for the right outcome and one for a partial score", () => {
  assert.equal(scorePrediction([2, 1], [2, 1]), 3);
  assert.equal(scorePrediction([1, 2], [0, 2]), 3);
  assert.equal(scorePrediction([4, 2], [1, 0]), 3);
  assert.equal(scorePrediction([1, 1], [2, 2]), 1);
  assert.equal(scorePrediction([2, 0], [2, 2]), 1);
  assert.equal(scorePrediction([0, 0], [0, 0]), 1);
  assert.equal(scorePrediction([0, 3], [2, 2]), 0);
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

test("league table awards 3-1-0 points using only finished match results", () => {
  const homeWin = fixture(1, 1, "1. Spieltag", new Date(), true);
  homeWin.matchResults = [
    { resultTypeID: 2, resultOrderID: 2, pointsTeam1: 2, pointsTeam2: 0 },
  ];
  const draw = fixture(2, 2, "2. Spieltag", new Date(), true);
  draw.team1.teamId = 3;
  draw.team1.teamName = "Dritter";
  draw.team2.teamId = homeWin.team1.teamId;
  draw.matchResults = [
    { resultTypeID: 2, resultOrderID: 2, pointsTeam1: 1, pointsTeam2: 1 },
  ];
  const table = leagueStandings([homeWin, draw]);
  assert.equal(table[0].name, "Heim");
  assert.equal(table[0].played, 2);
  assert.equal(table[0].points, 4);
  assert.equal(table[0].goalDifference, 2);
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

test("state endpoint rejects unsupported competition codes", async () => {
  const response = await handler(new Request(
    "https://example.net/api/state?competition=not-a-competition",
  ));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Dieser Wettbewerb wird nicht unterstützt.",
  });
});

test("moderation endpoints reject unauthenticated requests", async () => {
  const readResponse = await handler(new Request("https://example.net/api/admin"));
  assert.equal(readResponse.status, 403);
  const writeResponse = await handler(new Request("https://example.net/api/admin/user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: 1, banned: true }),
  }));
  assert.equal(writeResponse.status, 403);
  const deleteResponse = await handler(new Request("https://example.net/api/admin/user/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: 1 }),
  }));
  assert.equal(deleteResponse.status, 403);
});

test("function validates registration before requiring a database", async () => {
  const response = await handler(new Request("https://example.net/api/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tippliga-Cookie-Consent": "accepted",
    },
    body: JSON.stringify({ username: "x" }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Benutzername/);
});

test("login and registration require explicit necessary-cookie consent", async () => {
  for (const path of ["/api/login", "/api/register"]) {
    const response = await handler(new Request(`https://example.net${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /notwendige Cookies/);
  }
});
