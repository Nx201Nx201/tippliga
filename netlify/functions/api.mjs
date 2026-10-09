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
const adminUsername = (process.env.TIPPLIGA_ADMIN_USERNAME || "Nx201Nx201").toLowerCase();
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
  is_banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;
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
CREATE TABLE IF NOT EXISTS tip_drafts (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  matchday TEXT NOT NULL,
  predictions JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, season, matchday)
);
CREATE TABLE IF NOT EXISTS blocked_usernames (
  username TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS user_devices (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash TEXT NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, device_hash)
);
CREATE TABLE IF NOT EXISTS blocked_devices (
  device_hash TEXT PRIMARY KEY,
  blocked_until TIMESTAMPTZ NOT NULL
);
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
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data: https://upload.wikimedia.org https://i.imgur.com https://assets.dfb.de https://www.bundesliga-reisefuehrer.de https://www.bundesliga.com; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  for (const [key, value] of Object.entries(extraHeaders)) {
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers,
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
  return cookieValue(request, "tippliga_session");
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function deviceToken(request) {
  const token = cookieValue(request, "tippliga_device");
  return token && /^[A-Za-z0-9_-]{40,50}$/.test(token) ? token : null;
}

function newDeviceToken(request) {
  return deviceToken(request) || randomBytes(32).toString("base64url");
}

async function deviceIsBlocked(token) {
  if (!token) return false;
  const db = await readyDatabase();
  await db.query("DELETE FROM blocked_devices WHERE blocked_until <= NOW()");
  const result = await db.query(
    "SELECT 1 FROM blocked_devices WHERE device_hash = $1 AND blocked_until > NOW()",
    [hash(token)],
  );
  return result.rowCount > 0;
}

function deviceCookie(token) {
  return `tippliga_device=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
}

function sessionCookie(token) {
  return `tippliga_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${sessionDays * 86400}`;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function currentUser(request) {
  const token = cookieToken(request);
  if (!token) return null;
  const device = deviceToken(request);
  if (device && await deviceIsBlocked(device)) return null;
  const db = await readyDatabase();
  const result = await db.query(
    `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.is_banned
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_banned = FALSE`,
    [hash(token)],
  );
  const user = result.rows[0];
  return user ? { ...user, isAdmin: user.username.toLowerCase() === adminUsername } : null;
}

async function issueSession(userId, device) {
  const token = randomBytes(32).toString("base64url");
  const db = await readyDatabase();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [hash(token), userId],
    );
    await client.query(
      `INSERT INTO user_devices (user_id, device_hash, last_seen)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = NOW()`,
      [userId, hash(device)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await db.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  return [sessionCookie(token), deviceCookie(device)];
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
     WHERE u.is_banned = FALSE
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
  const draftResult = user
    ? await db.query(
      `SELECT predictions FROM tip_drafts
       WHERE user_id = $1 AND season = $2 AND matchday = $3`,
      [user.id, season, group.groupName],
    )
    : { rows: [] };
  if (user) {
    await db.query(
      "DELETE FROM tip_drafts WHERE user_id = $1 AND season = $2 AND matchday <> $3",
      [user.id, season, group.groupName],
    );
  }
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
      isAdmin: user.isAdmin,
    } : null,
    tips: Object.fromEntries(tips.rows.map((tip) => [String(tip.match_id), {
      home: tip.home_goals,
      away: tip.away_goals,
    }])),
    draft: draftResult.rows[0]?.predictions || {},
  };
}

async function stateResponse(request) {
  const state = await stateFor(request);
  const user = await currentUser(request);
  if (!user) return json(state);
  const device = newDeviceToken(request);
  const db = await readyDatabase();
  await db.query(
    `INSERT INTO user_devices (user_id, device_hash, last_seen)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = NOW()`,
    [user.id, hash(device)],
  );
  return json(state, 200, deviceToken(request) ? {} : { "Set-Cookie": deviceCookie(device) });
}

async function register(data, request) {
  const fields = validateRegistration(data);
  const device = newDeviceToken(request);
  const db = await readyDatabase();
  if (deviceToken(request) && await deviceIsBlocked(device)) {
    return json({ error: "Dieses Gerät ist nach einer Kontosperre noch vorübergehend gesperrt." }, 403);
  }
  const blocked = await db.query(
    "SELECT 1 FROM blocked_usernames WHERE username = lower($1)",
    [fields.username],
  );
  if (blocked.rowCount) return json({ error: "Dieser Benutzername ist nicht erlaubt." }, 400);
  const passwordSalt = randomBytes(16);
  const passwordKey = await scrypt(fields.password, passwordSalt, 64, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const encodedPassword = `scrypt$${passwordSalt.toString("hex")}$${Buffer.from(passwordKey).toString("hex")}`;
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
    await client.query(
      `INSERT INTO user_devices (user_id, device_hash, last_seen)
       VALUES ($1, $2, NOW())`,
      [inserted.rows[0].id, hash(device)],
    );
    await client.query("COMMIT");
    inTransaction = false;
    return json({ ok: true, username: fields.username }, 201, {
      "Set-Cookie": [sessionCookie(token), deviceCookie(device)],
    });
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
  const device = newDeviceToken(request);
  if (deviceToken(request) && await deviceIsBlocked(device)) {
    return json({ error: "Dieses Gerät ist nach einer Kontosperre noch vorübergehend gesperrt." }, 403);
  }
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
    `SELECT id, username, password_hash, is_banned FROM users
     WHERE lower(username) = lower($1) OR lower(email) = lower($1)`,
    [identity],
  );
  const user = result.rows[0];
  if (!user || !await verifyPassword(password, user.password_hash)) {
    return json({ error: "Anmeldedaten stimmen nicht." }, 401);
  }
  if (user.is_banned) {
    return json({ error: "Dieses Konto wurde von der Administration gesperrt." }, 403);
  }
  return json({ ok: true, username: user.username }, 200, {
    "Set-Cookie": await issueSession(user.id, device),
  });
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
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query(
      `INSERT INTO tips (user_id, season, match_id, matchday, home_goals, away_goals)
       VALUES ${valuePlaceholders}
       ON CONFLICT (user_id, season, match_id) DO NOTHING`,
      rows.flat(),
    );
    if (saved.rowCount !== rows.length) {
      await client.query("ROLLBACK");
      return json({
        error: "Ein oder mehrere Tipps wurden bereits abgegeben und können nicht mehr geändert werden.",
      }, 409);
    }
    await client.query(
      "DELETE FROM tip_drafts WHERE user_id = $1 AND season = $2 AND matchday = $3",
      [user.id, season, group.groupName],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const emailStatus = await sendTipEmail(user.username, group.groupName, lines);
  return json({ ok: true, emailStatus });
}

async function saveDraft(data, request) {
  const user = await currentUser(request);
  if (!user) return json({ error: "Bitte melde dich zuerst an." }, 401);
  const submitted = data.predictions;
  if (!Array.isArray(submitted) || submitted.length > 20) {
    return json({ error: "Ungültiger Tipp-Entwurf." }, 400);
  }
  const season = seasonFor();
  const matches = await fixturesFor(season);
  const { group, matches: activeMatches } = currentMatchday(matches);
  const currentById = new Map(activeMatches.map((match) => [Number(match.matchID), match]));
  const predictions = {};
  const seen = new Set();
  const now = Date.now();

  for (const item of submitted) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || !Number.isSafeInteger(item.matchId) || seen.has(item.matchId)) {
      return json({ error: "Ungültiger Tipp-Entwurf." }, 400);
    }
    seen.add(item.matchId);
    const match = currentById.get(item.matchId);
    if (!match) return json({ error: "Ein Tipp gehört nicht zum aktuellen Spieltag." }, 400);
    if (match.matchIsFinished || new Date(match.matchDateTimeUTC).getTime() <= now) {
      return json({ error: "Ein bereits begonnenes Spiel kann nicht als Entwurf gespeichert werden." }, 400);
    }
    const scores = {};
    for (const side of ["home", "away"]) {
      const value = item[side];
      if (value === null || value === undefined || value === "") continue;
      const score = typeof value === "number" ? value : Number(value);
      if (!Number.isSafeInteger(score) || score < 0 || score > 20
          || String(score) !== String(value)) {
        return json({ error: "Ergebnisse müssen ganze Zahlen zwischen 0 und 20 sein." }, 400);
      }
      scores[side] = score;
    }
    if (Object.keys(scores).length) predictions[String(item.matchId)] = scores;
  }

  const db = await readyDatabase();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT match_id FROM tips
       WHERE user_id = $1 AND season = $2 AND match_id = ANY($3::bigint[])`,
      [user.id, season, Object.keys(predictions)],
    );
    for (const row of locked.rows) delete predictions[String(row.match_id)];
    if (Object.keys(predictions).length) {
      await client.query(
        `INSERT INTO tip_drafts (user_id, season, matchday, predictions, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         ON CONFLICT (user_id, season, matchday) DO UPDATE SET
           predictions = EXCLUDED.predictions, updated_at = NOW()`,
        [user.id, season, group.groupName, JSON.stringify(predictions)],
      );
    } else {
      await client.query(
        "DELETE FROM tip_drafts WHERE user_id = $1 AND season = $2 AND matchday = $3",
        [user.id, season, group.groupName],
      );
    }
    await client.query("COMMIT");
    return json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function adminUser(request) {
  const user = await currentUser(request);
  if (!user?.isAdmin) return null;
  const device = deviceToken(request);
  if (device) {
    const db = await readyDatabase();
    await db.query(
      `INSERT INTO user_devices (user_id, device_hash, last_seen)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = NOW()`,
      [user.id, hash(device)],
    );
  }
  return user;
}

async function adminData(request) {
  if (!await adminUser(request)) {
    return json({ error: "Nur die Administration darf diese Funktion verwenden." }, 403);
  }
  const db = await readyDatabase();
  const [users, blocked] = await Promise.all([
    db.query("SELECT id, username, is_banned FROM users ORDER BY lower(username)"),
    db.query("SELECT username FROM blocked_usernames ORDER BY username"),
  ]);
  return json({
    users: users.rows.map((user) => ({
      id: user.id,
      username: user.username,
      isBanned: user.is_banned,
    })),
    blockedUsernames: blocked.rows.map((row) => row.username),
  });
}

async function setUserBan(data, request) {
  const admin = await adminUser(request);
  if (!admin) {
    return json({ error: "Nur die Administration darf diese Funktion verwenden." }, 403);
  }
  if (!Number.isSafeInteger(data.userId) || data.userId < 1 || typeof data.banned !== "boolean") {
    return json({ error: "Ungültige Spielersperre." }, 400);
  }
  const db = await readyDatabase();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query("SELECT username FROM users WHERE id = $1 FOR UPDATE", [data.userId]);
    if (!target.rowCount) {
      await client.query("ROLLBACK");
      return json({ error: "Spielerkonto nicht gefunden." }, 404);
    }
    if (target.rows[0].username.toLowerCase() === adminUsername && data.banned) {
      await client.query("ROLLBACK");
      return json({ error: "Das Administratorkonto kann nicht gesperrt werden." }, 400);
    }
    if (data.banned) {
      await client.query(
        `INSERT INTO blocked_devices (device_hash, blocked_until)
         SELECT d.device_hash, NOW() + INTERVAL '30 days'
         FROM user_devices d
         WHERE d.user_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM user_devices admin_devices
             JOIN users admin ON admin.id = admin_devices.user_id
             WHERE lower(admin.username) = $2
               AND admin_devices.device_hash = d.device_hash
           )
         ON CONFLICT (device_hash) DO UPDATE SET
           blocked_until = GREATEST(blocked_devices.blocked_until, EXCLUDED.blocked_until)`,
        [data.userId, adminUsername],
      );
    }
    await client.query("UPDATE users SET is_banned = $1 WHERE id = $2", [data.banned, data.userId]);
    if (data.banned) await client.query("DELETE FROM sessions WHERE user_id = $1", [data.userId]);
    await client.query("COMMIT");
    return json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteUser(data, request) {
  if (!await adminUser(request)) {
    return json({ error: "Nur die Administration darf diese Funktion verwenden." }, 403);
  }
  if (!Number.isSafeInteger(data.userId) || data.userId < 1) {
    return json({ error: "Ungültiges Spielerkonto." }, 400);
  }
  const db = await readyDatabase();
  const result = await db.query(
    "DELETE FROM users WHERE id = $1 AND lower(username) <> $2 RETURNING id",
    [data.userId, adminUsername],
  );
  if (!result.rowCount) {
    const exists = await db.query("SELECT 1 FROM users WHERE id = $1", [data.userId]);
    return exists.rowCount
      ? json({ error: "Das Administratorkonto kann nicht gelöscht werden." }, 400)
      : json({ error: "Spielerkonto nicht gefunden." }, 404);
  }
  return json({ ok: true });
}

async function setBlockedUsername(data, request) {
  if (!await adminUser(request)) {
    return json({ error: "Nur die Administration darf diese Funktion verwenden." }, 403);
  }
  if (typeof data.username !== "string" || !/^[A-Za-z0-9_.-]{3,24}$/.test(data.username)
      || typeof data.blocked !== "boolean") {
    return json({ error: "Ungültiger Benutzername." }, 400);
  }
  const normalized = data.username.toLowerCase();
  if (normalized === adminUsername && data.blocked) {
    return json({ error: "Der Administratorname kann nicht blockiert werden." }, 400);
  }
  const db = await readyDatabase();
  if (data.blocked) {
    await db.query(
      "INSERT INTO blocked_usernames (username) VALUES ($1) ON CONFLICT (username) DO NOTHING",
      [normalized],
    );
  } else {
    await db.query("DELETE FROM blocked_usernames WHERE username = $1", [normalized]);
  }
  return json({ ok: true });
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
      return await stateResponse(request);
    } catch (error) {
      console.error("State request failed:", error);
      return json({
        error: "Der aktuelle Bundesliga-Spielplan oder die Datenbank ist gerade nicht verfügbar.",
      }, 502);
    }
  }
  if (request.method === "GET" && path === "/api/admin") {
    try {
      return await adminData(request);
    } catch (error) {
      console.error("Admin moderation data failed:", error);
      return json({ error: "Moderationsdaten konnten nicht geladen werden." }, 500);
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
        return await register(data, request);
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
    if (path === "/api/draft") {
      try {
        return await saveDraft(data, request);
      } catch (error) {
        console.error("Saving tip draft failed:", error);
        return json({ error: "Tipp-Entwurf konnte nicht gespeichert werden." }, 502);
      }
    }
    if (path === "/api/admin/user") {
      try {
        return await setUserBan(data, request);
      } catch (error) {
        console.error("Updating player suspension failed:", error);
        return json({ error: "Spielersperre konnte nicht gespeichert werden." }, 500);
      }
    }
    if (path === "/api/admin/user/delete") {
      try {
        return await deleteUser(data, request);
      } catch (error) {
        console.error("Deleting player account failed:", error);
        return json({ error: "Spielerkonto konnte nicht gelöscht werden." }, 500);
      }
    }
    if (path === "/api/admin/username") {
      try {
        return await setBlockedUsername(data, request);
      } catch (error) {
        console.error("Updating blocked username failed:", error);
        return json({ error: "Benutzername konnte nicht gespeichert werden." }, 500);
      }
    }
  }
  return json({ error: "API-Endpunkt nicht gefunden." }, 404);
}

export default handle;
export const config = { path: "/api/*" };
