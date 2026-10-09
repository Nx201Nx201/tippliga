import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import pg from "pg";
import {
  currentMatchday,
  publicMatch,
  resultOf,
  RegistrationValidationError,
  scorePrediction,
  seasonFor,
  validateRegistration,
} from "./helpers.mjs";

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const sessionDays = 30;
const fixtureCache = new Map();
let pool;
let schemaPromise;

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS tips (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  match_id BIGINT NOT NULL,
  matchday TEXT NOT NULL,
  home_goals INTEGER NOT NULL CHECK (home_goals BETWEEN 0 AND 20),
  away_goals INTEGER NOT NULL CHECK (away_goals BETWEEN 0 AND 20),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, season, match_id)
);
CREATE INDEX IF NOT EXISTS tips_season_idx ON tips (season, match_id);
CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGSERIAL PRIMARY KEY,
  client_hash TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS login_attempts_client_time_idx
  ON login_attempts (client_hash, attempted_at);
`;

function database() {
  if (!process.env.DATABASE_URL) throw new Error("Die Datenbankverbindung DATABASE_URL fehlt.");
  pool ||= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  schemaPromise ||= pool.query(schema).catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  return pool;
}

async function readyDatabase() {
  const db = database();
  await schemaPromise;
  return db;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data: https://upload.wikimedia.org https://i.imgur.com https://assets.dfb.de https://www.bundesliga-reisefuehrer.de https://www.bundesliga.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      ...extraHeaders,
    },
  });
}

async function requestBody(request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 32_768) {
    throw new Error("Die Anfrage ist leer oder zu groß.");
  }
  const text = await request.text();
  if (!text || new TextEncoder().encode(text).byteLength > 32_768) {
    throw new Error("Die Anfrage ist leer oder zu groß.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Ungültige Anfrage.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Ungültige Anfrage.");
  }
  return data;
}

function cookieToken(request) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === "tippliga_session") {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function currentUser(request) {
  const token = cookieToken(request);
  if (!token) return null;
  const db = await readyDatabase();
  const result = await db.query(
    `SELECT u.id, u.username, u.email, u.first_name, u.last_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [hash(token)],
  );
  return result.rows[0] || null;
}

async function issueSession(userId) {
  const token = randomBytes(32).toString("base64url");
  const db = await readyDatabase();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [hash(token), userId],
  );
  await db.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  return `tippliga_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionDays * 86400}`;
}

async function clearSession(request) {
  const token = cookieToken(request);
  if (token) {
    const db = await readyDatabase();
    await db.query("DELETE FROM sessions WHERE token_hash = $1", [hash(token)]);
  }
  return "tippliga_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

async function fixturesFor(season) {
  const cached = fixtureCache.get(season);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) return cached.matches;
  const response = await fetch(`https://api.openligadb.de/getmatchdata/bl1/${season}`, {
    headers: { "User-Agent": "Tippliga/1.0 (Bundesliga tip game)" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Die Spielplan-Quelle antwortete mit HTTP ${response.status}.`);
  const matches = await response.json();
  if (!Array.isArray(matches)) throw new Error("Die Spielplan-Quelle hat ein unerwartetes Format geliefert.");
  fixtureCache.set(season, { timestamp: Date.now(), matches });
  return matches;
}

async function stateFor(request) {
  const season = seasonFor();
  const matches = await fixturesFor(season);
  const { group, matches: activeMatches } = currentMatchday(matches);
  const active = activeMatches.map(publicMatch);
  const user = await currentUser(request);
  const db = await readyDatabase();
  const leaderboard = await db.query(
    `SELECT u.id, u.username, COUNT(DISTINCT t.matchday)::int AS matchdays
     FROM users u LEFT JOIN tips t ON t.user_id = u.id AND t.season = $1
     GROUP BY u.id ORDER BY lower(u.username)`,
    [season],
  );
  const tips = user
    ? await db.query(
      `SELECT match_id, home_goals, away_goals FROM tips
       WHERE user_id = $1 AND season = $2 AND matchday = $3`,
      [user.id, season, group.groupName],
    )
    : { rows: [] };
  const allTips = await db.query(
    "SELECT user_id, match_id, home_goals, away_goals FROM tips WHERE season = $1",
    [season],
  );
  const results = new Map(matches.map((match) => [Number(match.matchID), resultOf(match)]));
  const userScores = new Map();
  for (const tip of allTips.rows) {
    const result = results.get(Number(tip.match_id));
    if (!result) continue;
    const userId = String(tip.user_id);
    userScores.set(
      userId,
      (userScores.get(userId) || 0)
        + scorePrediction([tip.home_goals, tip.away_goals], result),
    );
  }
  const ranked = leaderboard.rows.map((row) => ({
    username: row.username,
    matchdays: row.matchdays,
    points: userScores.get(String(row.id)) || 0,
  })).sort((a, b) => b.points - a.points || a.username.toLowerCase().localeCompare(b.username.toLowerCase()));
  const seasonLabel = `${season}/${String(season + 1).slice(-2)}`;
  return {
    season: seasonLabel,
    matchday: group.groupName,
    matches: active,
    leaderboard: ranked,
    me: user ? {
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
    } : null,
    tips: Object.fromEntries(tips.rows.map((tip) => [String(tip.match_id), {
      home: tip.home_goals,
      away: tip.away_goals,
    }])),
  };
}

async function register(data) {
  const fields = validateRegistration(data);
  const passwordSalt = randomBytes(16);
  const passwordKey = await scrypt(fields.password, passwordSalt, 64, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const encodedPassword = `scrypt$${passwordSalt.toString("hex")}$${Buffer.from(passwordKey).toString("hex")}`;
  const db = await readyDatabase();
  const client = await db.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const inserted = await client.query(
      `INSERT INTO users (username, email, first_name, last_name, address, phone, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [fields.username, fields.email, fields.firstName, fields.lastName, fields.address, fields.phone, encodedPassword],
    );
    const token = randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [hash(token), inserted.rows[0].id],
    );
    await client.query("COMMIT");
    inTransaction = false;
    const setCookie = `tippliga_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionDays * 86400}`;
    return json({ ok: true, username: fields.username }, 201, { "Set-Cookie": setCookie });
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK");
    if (error.code === "23505") {
      return json({ error: "Benutzername oder E-Mail-Adresse ist bereits registriert." }, 409);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function verifyPassword(password, stored) {
  const [algorithm, saltHex, digestHex] = String(stored).split("$");
  if (algorithm !== "scrypt" || !/^[\da-f]{32}$/i.test(saltHex || "")
      || !/^[\da-f]{128}$/i.test(digestHex || "")) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), 64, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }));
  const expected = Buffer.from(digestHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function allowLoginAttempt(request) {
  const forwardedIp = request.headers.get("x-nf-client-connection-ip")
    || "unknown";
  const clientHash = hash(forwardedIp);
  const db = await readyDatabase();
  await db.query("DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL '10 minutes'");
  await db.query("INSERT INTO login_attempts (client_hash) VALUES ($1)", [clientHash]);
  const result = await db.query(
    `SELECT COUNT(*)::int AS attempts FROM login_attempts
     WHERE client_hash = $1 AND attempted_at > NOW() - INTERVAL '1 minute'`,
    [clientHash],
  );
  return result.rows[0].attempts <= 10;
}

async function login(data, request) {
  if (!await allowLoginAttempt(request)) {
    return json({ error: "Zu viele Anmeldeversuche. Bitte warte eine Minute." }, 429);
  }
  const identity = String(data.identity ?? "").trim();
  const password = data.password;
  if (!identity || typeof password !== "string" || !password || password.length > 256) {
    return json({ error: "Bitte Benutzername/E-Mail und Passwort eingeben." }, 400);
  }
  const db = await readyDatabase();
  const result = await db.query(
    `SELECT id, username, password_hash FROM users
     WHERE lower(username) = lower($1) OR lower(email) = lower($1)`,
    [identity],
  );
  const user = result.rows[0];
  if (!user || !await verifyPassword(password, user.password_hash)) {
    return json({ error: "Anmeldedaten stimmen nicht." }, 401);
  }
  const setCookie = await issueSession(user.id);
  return json({ ok: true, username: user.username }, 200, { "Set-Cookie": setCookie });
}

async function sendTipEmail(username, matchday, lines) {
  const config = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    sender: process.env.SMTP_FROM,
  };
  if (!Object.values(config).every(Boolean)) return "not_configured";
  let transport;
  try {
    transport = nodemailer.createTransport({
      host: config.host,
      port: Number(config.port),
      secure: Number(config.port) === 465,
      requireTLS: Number(config.port) === 587,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      auth: { user: config.user, pass: config.password },
    });
    await transport.sendMail({
      from: config.sender,
      to: "nx201nx201@outlook.de",
      subject: `Tippliga: ${matchday} – Tipps von ${username}`,
      text: `Tipps von ${username} für ${matchday}\n\n${lines.join("\n")}`,
    });
    return "sent";
  } catch (error) {
    console.error("Tip email delivery failed:", error);
    return "failed";
  } finally {
    transport?.close();
  }
}

async function saveTips(data, request) {
  const user = await currentUser(request);
  if (!user) return json({ error: "Bitte melde dich zuerst an." }, 401);
  const submitted = data.tips;
  if (!Array.isArray(submitted) || !submitted.length || submitted.length > 20) {
    return json({ error: "Bitte gib mindestens einen gültigen Tipp ab." }, 400);
  }
  const season = seasonFor();
  const matches = await fixturesFor(season);
  const { group, matches: activeMatches } = currentMatchday(matches);
  const currentById = new Map(activeMatches.map((match) => [Number(match.matchID), match]));
  const seen = new Set();
  const rows = [];
  const lines = [];
  const now = Date.now();

  for (const item of submitted) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return json({ error: "Ungültiger Tipp." }, 400);
    }
    const { matchId, home, away } = item;
    if (![matchId, home, away].every(Number.isSafeInteger)) {
      return json({ error: "Bitte ganze Zahlen für Spiel und Ergebnis angeben." }, 400);
    }
    if (seen.has(matchId) || home < 0 || home > 20 || away < 0 || away > 20) {
      return json({ error: "Jedes Ergebnis muss eine ganze Zahl zwischen 0 und 20 sein." }, 400);
    }
    const match = currentById.get(matchId);
    if (!match) return json({ error: "Ein Tipp gehört nicht zum aktuellen Spieltag." }, 400);
    if (match.matchIsFinished || new Date(match.matchDateTimeUTC).getTime() <= now) {
      return json({ error: "Für ein bereits begonnenes Spiel kann kein Tipp mehr abgegeben werden." }, 400);
    }
    seen.add(matchId);
    rows.push([user.id, season, matchId, group.groupName, home, away]);
    lines.push(`${match.team1.shortName} ${home}:${away} ${match.team2.shortName}`);
  }

  const db = await readyDatabase();
  const valuePlaceholders = rows.map((_, index) => {
    const offset = index * 6;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
  }).join(", ");
  await db.query(
    `INSERT INTO tips (user_id, season, match_id, matchday, home_goals, away_goals)
     VALUES ${valuePlaceholders}
     ON CONFLICT (user_id, season, match_id) DO UPDATE SET
       home_goals = EXCLUDED.home_goals, away_goals = EXCLUDED.away_goals, updated_at = NOW()`,
    rows.flat(),
  );
  const emailStatus = await sendTipEmail(user.username, group.groupName, lines);
  return json({ ok: true, emailStatus });
}

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/health") {
    try {
      await (await readyDatabase()).query("SELECT 1");
      return json({ ok: true });
    } catch (error) {
      console.error("Health check failed:", error);
      return json({ ok: false }, 503);
    }
  }
  if (request.method === "GET" && path === "/api/state") {
    try {
      return json(await stateFor(request));
    } catch (error) {
      console.error("State request failed:", error);
      return json({
        error: "Der aktuelle Bundesliga-Spielplan oder die Datenbank ist gerade nicht verfügbar.",
      }, 502);
    }
  }
  if (path.startsWith("/api/") && request.method === "POST") {
    let data;
    try {
      data = await requestBody(request);
    } catch (error) {
      return json({ error: error.message }, 400);
    }
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) return json({ error: "Ungültige Anfragequelle." }, 403);
      } catch {
        return json({ error: "Ungültige Anfragequelle." }, 403);
      }
    }
    if (path === "/api/register") {
      try {
        return await register(data);
      } catch (error) {
        if (error instanceof RegistrationValidationError) {
          return json({ error: error.message }, 400);
        }
        console.error("Registration failed:", error);
        return json({ error: "Konto konnte nicht gespeichert werden." }, 500);
      }
    }
    if (path === "/api/login") {
      try {
        return await login(data, request);
      } catch (error) {
        console.error("Login failed:", error);
        return json({ error: "Anmeldung ist gerade nicht möglich." }, 500);
      }
    }
    if (path === "/api/logout") {
      try {
        return json({ ok: true }, 200, { "Set-Cookie": await clearSession(request) });
      } catch (error) {
        console.error("Logout failed:", error);
        return json({ error: "Abmeldung ist gerade nicht möglich." }, 500);
      }
    }
    if (path === "/api/tips") {
      try {
        return await saveTips(data, request);
      } catch (error) {
        console.error("Saving tips failed:", error);
        return json({ error: "Tipps konnten nicht sicher gespeichert werden." }, 502);
      }
    }
  }
  return json({ error: "API-Endpunkt nicht gefunden." }, 404);
}

export default handle;
export const config = { path: "/api/*" };
