let state = null;
let authMode = "login";
const COOKIE_CONSENT_KEY = "tippliga-cookie-consent";
const COMPETITION_KEY = "tippliga-competition";
const FALLBACK_COMPETITIONS = [
  ["bl1", "1. Bundesliga", "Bundesliga (1.–3. Liga)", "league"],
  ["bl2", "2. Bundesliga", "Bundesliga (1.–3. Liga)", "league"],
  ["bl3", "3. Liga", "Bundesliga (1.–3. Liga)", "league"],
  ["rln", "Regionalliga Nord", "4. Liga (Regionalligen)", "league"],
  ["rlno", "Regionalliga Nordost", "4. Liga (Regionalligen)", "league"],
  ["rlw", "Regionalliga West", "4. Liga (Regionalligen)", "league"],
  ["rlsw", "Regionalliga Südwest", "4. Liga (Regionalligen)", "league"],
  ["regio-bayern", "Regionalliga Bayern", "4. Liga (Regionalligen)", "league"],
  ["DFBN", "DFB-Nationalspiele", "Länderspiele", "international"],
  ["FTS", "Freundschafts-/Testspiele", "Länderspiele", "international"],
  ["nla", "Nations League A", "Länderspiele", "international"],
  ["wm26", "Weltmeisterschaft 2026", "Länderspiele", "international"],
].map(([code, name, category, kind]) => ({ code, name, category, kind, available: false }));
let cookieConsent = "unknown";
let authAfterCookieConsent = false;
let competitions = [];
let selectedCompetitionCode = "bl1";
let refreshSequence = 0;

const leaderboardBody = document.querySelector("#leaderboard-body");
const playerCount = document.querySelector("#player-count");
const fixturesList = document.querySelector("#fixtures-list");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const authError = document.querySelector("#auth-error");
const submitStatus = document.querySelector("#submit-status");
const cookieDialog = document.querySelector("#cookie-dialog");
let draftSaveTimeout = null;
let draftSyncPromise = Promise.resolve();

try {
  const savedConsent = localStorage.getItem(COOKIE_CONSENT_KEY);
  if (savedConsent === "accepted" || savedConsent === "declined") cookieConsent = savedConsent;
} catch (error) {
  console.error("Could not read the cookie consent preference:", error);
}

function hasCookieConsent() {
  return cookieConsent === "accepted";
}

function saveCookieConsent(value) {
  cookieConsent = value;
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, value);
  } catch (error) {
    console.error("Could not save the cookie consent preference:", error);
    submitStatus.textContent = "Deine Cookie-Auswahl kann in diesem Browser nicht dauerhaft gespeichert werden.";
  }
}

function openCookieSettings(forAuthentication = false) {
  authAfterCookieConsent = forAuthentication;
  if (!cookieDialog.open) cookieDialog.showModal();
}

function draftKey() {
  const username = state?.me?.username.toLowerCase() || "guest";
  const competitionSuffix = selectedCompetitionCode === "bl1" ? "" : `:${selectedCompetitionCode}`;
  return `tippliga-draft:${username}${competitionSuffix}`;
}

function loadDraft() {
  if (!state?.season || !state?.matchday) return {};
  const predictions = Object.fromEntries(
    Object.entries(state.draft || {}).map(([matchId, scores]) => [matchId, { ...scores }]),
  );
  try {
    const key = draftKey();
    const stored = localStorage.getItem(key);
    if (!stored) return predictions;
    const draft = JSON.parse(stored);
    if (draft.season !== state.season || draft.matchday !== state.matchday
      || (draft.competitionCode || "bl1") !== selectedCompetitionCode) {
      localStorage.removeItem(key);
      return predictions;
    }
    for (const [matchId, scores] of Object.entries(draft.predictions || {})) {
      predictions[matchId] = { ...predictions[matchId], ...scores };
    }
    return predictions;
  } catch (error) {
    if (error instanceof SyntaxError) {
      localStorage.removeItem(draftKey());
      return predictions;
    }
    console.error("Could not load the local tip draft:", error);
    submitStatus.textContent = "Entwürfe können in diesem Browser nicht gespeichert werden.";
    return predictions;
  }
}

function saveDraftInput(input) {
  if (!state?.me || input.disabled) return;
  const predictions = loadDraft();
  const matchId = input.dataset.matchId;
  predictions[matchId] ||= {};
  if (input.value === "") {
    delete predictions[matchId][input.dataset.side];
    if (!Object.keys(predictions[matchId]).length) delete predictions[matchId];
  } else {
    predictions[matchId][input.dataset.side] = input.value;
  }
  state.draft = predictions;
  try {
    localStorage.setItem(draftKey(), JSON.stringify({
      season: state.season,
      matchday: state.matchday,
      competitionCode: selectedCompetitionCode,
      predictions,
    }));
  } catch (error) {
    console.error("Could not save the local tip draft:", error);
    submitStatus.textContent = "Entwurf konnte auf diesem Gerät nicht gespeichert werden.";
  }
}

async function syncDraft() {
  if (!state?.me) return;
  const competitionCode = selectedCompetitionCode;
  const predictions = loadDraft();
  const payload = Object.entries(predictions).map(([matchId, scores]) => ({
    matchId: Number(matchId),
    home: scores.home ?? null,
    away: scores.away ?? null,
  }));
  const request = draftSyncPromise.then(() => api("/api/draft", {
    competitionCode,
    predictions: payload,
  }));
  draftSyncPromise = request.catch(() => {});
  await request;
}

function scheduleDraftSync() {
  window.clearTimeout(draftSaveTimeout);
  draftSaveTimeout = window.setTimeout(() => {
    syncDraft().catch((error) => {
      console.error("Could not synchronize the tip draft:", error);
      submitStatus.textContent = "Entwurf bleibt auf diesem Gerät, konnte aber nicht mit dem Server synchronisiert werden.";
    });
  }, 400);
}

function removeSubmittedDraft(tips, storageKey, season, matchday, competitionCode) {
  try {
    const stored = localStorage.getItem(storageKey);
    const draft = stored ? JSON.parse(stored) : {};
    const predictions = { ...(draft.predictions || {}) };
    for (const tip of tips) delete predictions[String(tip.matchId)];
    if (Object.keys(predictions).length) {
      localStorage.setItem(storageKey, JSON.stringify({
        season,
        matchday,
        competitionCode,
        predictions,
      }));
    } else {
      localStorage.removeItem(storageKey);
    }
    if (state?.season === season && state?.matchday === matchday
      && selectedCompetitionCode === competitionCode) {
      state.draft = predictions;
    }
  } catch (error) {
    console.error("Could not remove submitted tips from the local draft:", error);
    return false;
  }
  return true;
}

async function api(path, body) {
  const headers = body === undefined ? {} : { "Content-Type": "application/json" };
  if ((path === "/api/login" || path === "/api/register") && hasCookieConsent()) {
    headers["X-Tippliga-Cookie-Consent"] = "accepted";
  }
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "Die Anfrage ist fehlgeschlagen.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function initials(name) {
  return name.slice(0, 2).toUpperCase();
}

function createFallbackCrest(name, shortName) {
  const palette = ["#2364aa", "#a83232", "#28734a", "#7546a8", "#b36b1f", "#267c83", "#a13d72", "#59636f"];
  const label = shortName || name;
  let hash = 0;
  for (const character of name.toLowerCase()) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("crest-fallback");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${name} – Ersatzwappen`);

  const shield = document.createElementNS(svg.namespaceURI, "path");
  shield.setAttribute("d", "M24 2 44 9v13c0 12-8 20-20 24C12 42 4 34 4 22V9z");
  shield.setAttribute("fill", palette[hash % palette.length]);
  shield.setAttribute("stroke", "#ffffff");
  shield.setAttribute("stroke-opacity", ".72");
  shield.setAttribute("stroke-width", "2");

  const stripe = document.createElementNS(svg.namespaceURI, "path");
  stripe.setAttribute("d", "m7 16 29-10 6 2v7L7 29z");
  stripe.setAttribute("fill", palette[(hash + 3) % palette.length]);
  stripe.setAttribute("opacity", ".8");

  const text = document.createElementNS(svg.namespaceURI, "text");
  text.setAttribute("x", "24");
  text.setAttribute("y", "32");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", "#ffffff");
  text.setAttribute("font-family", "Arial, sans-serif");
  text.setAttribute("font-size", label.length > 2 ? "12" : "15");
  text.setAttribute("font-weight", "700");
  text.textContent = initials(label);

  svg.append(shield, stripe, text);
  return svg;
}

function createTeamCrest(name, shortName, logoUrl) {
  if (!logoUrl) return createFallbackCrest(name, shortName);
  const logo = document.createElement("img");
  logo.className = "club-crest";
  logo.src = logoUrl;
  logo.alt = `${name} Vereinswappen`;
  logo.loading = "lazy";
  logo.referrerPolicy = "no-referrer";
  logo.addEventListener("error", () => {
    logo.replaceWith(createFallbackCrest(name, shortName));
  }, { once: true });
  return logo;
}

function renderLeaderboard() {
  const players = state?.leaderboard || [];
  leaderboardBody.replaceChildren(...players.map((player, index) => {
    const row = document.createElement("tr");
    const rank = document.createElement("td");
    rank.textContent = String(index + 1).padStart(2, "0");
    if (index < 3) rank.classList.add("podium");

    const nameCell = document.createElement("td");
    const playerInfo = document.createElement("div");
    playerInfo.className = "player-cell";
    const avatar = document.createElement("span");
    avatar.className = `avatar${index === 0 ? " gold" : ""}`;
    avatar.textContent = initials(player.username);
    const name = document.createElement("span");
    name.className = "player-name";
    name.textContent = player.username;
    playerInfo.append(avatar, name);
    if (state?.me?.username.toLowerCase() === player.username.toLowerCase()) {
      const tag = document.createElement("span");
      tag.className = "you-tag";
      tag.textContent = "DU";
      playerInfo.append(tag);
    }
    nameCell.append(playerInfo);

    const matchdaysCell = document.createElement("td");
    matchdaysCell.textContent = String(player.matchdays).padStart(2, "0");
    const pointsCell = document.createElement("td");
    pointsCell.textContent = String(player.points).padStart(2, "0");
    row.append(rank, nameCell, matchdaysCell, pointsCell);
    return row;
  }));
  playerCount.textContent = `${players.length} ECHTE TIPPER:INNEN`;
  if (!players.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "Noch niemand registriert – sei die oder der Erste!";
    row.append(cell);
    leaderboardBody.append(row);
    playerCount.textContent = "DIE LIGA STARTET MIT DIR";
  }
}

function renderLeagueTable() {
  const panel = document.querySelector("#league-table-panel");
  const body = document.querySelector("#league-table-body");
  const competition = state?.competition;
  const standings = state?.standings || [];
  panel.hidden = false;
  document.querySelector("#league-table-title").textContent = competition?.kind === "league"
    ? `${competition.name} · Tabelle`
    : `${competition?.name || "Wettbewerb"} · Keine Ligatabelle`;
  if (competition?.kind !== "league") {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = "Für diesen Wettbewerb gibt es keine Vereinstabelle.";
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  if (!standings.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = state?.matches?.length
      ? "Für diese Liga liegen bisher noch keine abgeschlossenen Spielergebnisse vor."
      : `Für ${competition?.name || "diese Liga"} liefert die Datenquelle derzeit keinen Spielplan. Tabelle und Tipps erscheinen, sobald Spieldaten verfügbar sind.`;
    row.append(cell);
    body.replaceChildren(row);
    return;
  }
  body.replaceChildren(...standings.map((team, index) => {
    const row = document.createElement("tr");
    const values = [
      String(index + 1),
      team.name,
      String(team.played),
      String(team.wins),
      String(team.draws),
      String(team.losses),
      `${team.goalsFor}:${team.goalsAgainst}`,
      team.goalDifference > 0 ? `+${team.goalDifference}` : String(team.goalDifference),
      String(team.points),
    ];
    for (const [columnIndex, value] of values.entries()) {
      const cell = document.createElement("td");
      if (columnIndex === 1) {
        const teamInfo = document.createElement("span");
        teamInfo.className = "league-team-name";
        teamInfo.append(createTeamCrest(team.name, team.shortName, team.logo));
        const name = document.createElement("span");
        name.textContent = team.name;
        teamInfo.append(name);
        cell.append(teamInfo);
      } else {
        cell.textContent = value;
      }
      row.append(cell);
    }
    return row;
  }));
}

function makeTeam(name, shortName, logoUrl, position) {
  const wrapper = document.createElement("div");
  wrapper.className = position;
  const team = document.createElement("div");
  team.className = "fixture-team";
  const badge = document.createElement("span");
  badge.className = "fixture-team-badge";
  badge.append(createTeamCrest(name, shortName, logoUrl));
  const label = document.createElement("span");
  label.textContent = name;
  team.append(badge, label);
  wrapper.append(team);
  return wrapper;
}

function scoreBox(match, side, label) {
  const input = document.createElement("input");
  input.className = `score-input score-${side}`;
  input.type = "number";
  input.min = "0";
  input.max = "20";
  input.step = "1";
  input.inputMode = "numeric";
  input.dataset.matchId = String(match.id);
  input.dataset.side = side;
  input.setAttribute("aria-label", `${label} ${match.home} – ${match.away}`);

  const prediction = state?.tips?.[String(match.id)];
  const draftPrediction = loadDraft()[String(match.id)];
  const started = Date.parse(match.date) <= Date.now();
  const result = match.result;
  if (prediction) {
    input.value = String(prediction[side]);
  } else if (draftPrediction?.[side] !== undefined) {
    input.value = String(draftPrediction[side]);
  } else if (result) {
    input.value = String(result[side]);
  }
  input.disabled = Boolean(prediction) || !state?.me || started || match.finished;
  if (prediction) input.title = "Abgegeben und gesperrt; dieser Tipp kann nicht mehr geändert werden.";
  return input;
}

function renderFixtures() {
  if (!state?.matches?.length) {
    fixturesList.replaceChildren();
    const message = document.createElement("p");
    message.className = "fixture-error";
    message.textContent = state?.competition
      ? `Für ${state.competition.name} liefert die Datenquelle derzeit keinen Spielplan. Deshalb können hier noch keine Tipps abgegeben werden.`
      : "Für den aktuellen Spieltag sind derzeit keine Spiele verfügbar.";
    fixturesList.append(message);
    return;
  }
  fixturesList.replaceChildren(...state.matches.map((match) => {
    const row = document.createElement("div");
    row.className = "fixture";
    const time = document.createElement("div");
    time.className = "fixture-time";
    const day = document.createElement("strong");
    day.textContent = match.day;
    const timeLabel = document.createElement("span");
    timeLabel.textContent = match.finished
      ? "BEENDET"
      : Date.parse(match.date) <= Date.now() ? "LÄUFT" : `${match.time} UHR`;
    time.append(day, timeLabel);

    const home = makeTeam(match.home, match.homeShort, match.homeLogo, "fixture-home");
    const homeScore = scoreBox(match, "home", "Heimtore");
    const separator = document.createElement("span");
    separator.className = "score-separator";
    separator.textContent = ":";
    const awayScore = scoreBox(match, "away", "Auswärtstore");
    const away = makeTeam(match.away, match.awayShort, match.awayLogo, "fixture-away");
    row.append(time, home, homeScore, separator, awayScore, away);
    return row;
  }));
}

function renderAccount() {
  const button = document.querySelector("#account-button");
  const welcome = document.querySelector("#welcome-label");
  const note = document.querySelector("#tip-login-note");
  document.querySelector("#admin-panel").hidden = !state?.me?.isAdmin;
  if (state?.me) {
    button.textContent = "Abmelden";
    welcome.textContent = `Hi, ${state.me.firstName}`;
    note.textContent = "Entwürfe bleiben auf diesem Gerät. Abgeschickte Tipps sind gesperrt.";
  } else {
    button.textContent = "Anmelden";
    welcome.textContent = "";
    note.textContent = "Melde dich an, um deine Tipps abzugeben.";
  }
}

function renderNextMatch() {
  const match = state?.matches?.find((item) => !item.finished && Date.parse(item.date) > Date.now())
    || state?.matches?.find((item) => !item.finished);
  if (!match) {
    document.querySelector("#next-match-label").textContent = "SPIELTAG ABGESCHLOSSEN";
    document.querySelector("#next-match-time").textContent = state?.matchday || "Kein Spiel angesetzt";
    return;
  }
  document.querySelector("#next-match-label").textContent = `NÄCHSTES SPIEL · ${state.matchday.toUpperCase()}`;
  document.querySelector("#next-match-time").textContent = `${match.day} · ${match.time} UHR`;
  document.querySelector("#next-home").textContent = match.home;
  document.querySelector("#next-away").textContent = match.away;
  setTeamBadge(document.querySelector("#next-home-badge"), match.home, match.homeShort, match.homeLogo);
  setTeamBadge(document.querySelector("#next-away-badge"), match.away, match.awayShort, match.awayLogo);
}

function setTeamBadge(badge, name, shortName, logoUrl) {
  badge.replaceChildren();
  badge.append(createTeamCrest(name, shortName, logoUrl));
}

fixturesList.addEventListener("input", (event) => {
  if (event.target.matches(".score-input")) {
    saveDraftInput(event.target);
    scheduleDraftSync();
  }
});

function render() {
  renderCompetitionButtons();
  renderAccount();
  renderLeaderboard();
  renderLeagueTable();
  renderFixtures();
  renderNextMatch();
  const roundNumber = state?.matchday?.match(/\d+/)?.[0] || "–";
  document.querySelector("#hero-round").innerHTML = `${roundNumber}<span>.</span>`;
  document.querySelector("#round-widget").setAttribute("aria-label", `Spieltag ${roundNumber}`);
  document.querySelector("#season-label").textContent = state?.season || "—";
  document.querySelector("#table-season-label").textContent = state?.season || "—";
  document.querySelector("#matchday-label").textContent = state?.matchday
    ? `${(state.competition?.name || "WETTBEWERB").toUpperCase()} · ${state.matchday.toUpperCase()} · DEIN TIPP.`
    : "DEIN GEFÜHL. DEIN TIPP.";
}

async function refresh() {
  const requestId = ++refreshSequence;
  const competitionCode = selectedCompetitionCode;
  try {
    const nextState = await api(`/api/state?competition=${encodeURIComponent(competitionCode)}`);
    if (requestId !== refreshSequence) return;
    state = nextState;
    render();
    await refreshAdminPanel();
  } catch (error) {
    if (requestId !== refreshSequence) return;
    fixturesList.replaceChildren();
    const message = document.createElement("p");
    message.className = "fixture-error";
    message.textContent = error.message;
    fixturesList.append(message);
    document.querySelector("#tip-login-note").textContent = "Der Server oder Spielplan ist gerade nicht erreichbar.";
    submitStatus.textContent = error.message;
  }
}

function renderCompetitionButtons() {
  const navs = [
    document.querySelector("#competition-buttons"),
    document.querySelector("#table-competition-buttons"),
  ].filter(Boolean);
  if (!navs.length) return;
  const categories = [...new Set(competitions.map((item) => item.category))];
  for (const nav of navs) {
    nav.replaceChildren(...categories.map((category) => {
      const group = document.createElement("div");
      group.className = "competition-group";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", category);
      const label = document.createElement("span");
      label.className = "competition-category";
      label.textContent = category;
      group.append(label);
      for (const competition of competitions.filter((item) => item.category === category)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "competition-button";
        button.textContent = competition.available
          ? competition.name
          : `${competition.name} · Spielplan fehlt`;
        button.setAttribute("aria-pressed", String(competition.code === selectedCompetitionCode));
        if (!competition.available) {
          button.title = "Die Datenquelle liefert aktuell keine Spiele für diesen Wettbewerb. Du kannst ihn auswählen; Tippen und Tabelle sind erst mit Spieldaten möglich.";
        }
        button.addEventListener("click", () => {
          if (competition.code === selectedCompetitionCode) return;
          selectedCompetitionCode = competition.code;
          try {
            localStorage.setItem(COMPETITION_KEY, selectedCompetitionCode);
          } catch (error) {
            console.error("Could not save the selected competition:", error);
          }
          if (state) {
            state = {
              ...state,
              competition: null,
              matchday: null,
              matches: [],
              leaderboard: [],
              tips: {},
              draft: {},
            };
          }
          renderCompetitionButtons();
          render();
          submitStatus.textContent = "";
          refresh();
        });
        group.append(button);
      }
      return group;
    }));
  }
}

function setAppView(view) {
  const isTablesView = view === "tabellen";
  document.body.dataset.appView = isTablesView ? "tabellen" : "main";
  document.querySelector(".hero").hidden = isTablesView;
  document.querySelector("#rangliste").hidden = isTablesView;
  document.querySelector("#tippen").hidden = isTablesView;
  document.querySelector("#tabellen").hidden = !isTablesView;
  for (const link of document.querySelectorAll(".nav-link[data-app-view]")) {
    const active = link.dataset.appView === view;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

document.querySelector(".main-nav").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-app-view]");
  if (!link) return;
  event.preventDefault();
  setAppView(link.dataset.appView);
  history.replaceState(null, "", link.getAttribute("href"));
  document.querySelector(link.getAttribute("href"))?.scrollIntoView({ behavior: "smooth", block: "start" });
});

setAppView(location.hash === "#tabellen" ? "tabellen" : "main");

async function initialize() {
  try {
    const savedCompetition = localStorage.getItem(COMPETITION_KEY);
    if (savedCompetition) selectedCompetitionCode = savedCompetition;
  } catch (error) {
    console.error("Could not read the selected competition:", error);
  }
  try {
    const data = await api("/api/competitions");
    competitions = data.competitions;
    if (!competitions.some((item) => item.code === selectedCompetitionCode && item.available)) {
      selectedCompetitionCode = competitions.find((item) => item.code === "bl1")?.code
        || competitions[0]?.code
        || "bl1";
    }
    renderCompetitionButtons();
  } catch (error) {
    submitStatus.textContent = error.message;
    competitions = FALLBACK_COMPETITIONS;
    renderCompetitionButtons();
  }
  await refresh();
}

async function refreshAdminPanel() {
  const panel = document.querySelector("#admin-panel");
  if (panel.hidden) return;
  const status = document.querySelector("#admin-status");
  try {
    const data = await api("/api/admin");
    const users = document.querySelector("#admin-users");
    users.replaceChildren(...data.users.map((user) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = user.username;
      if (user.username.toLowerCase() === state.me.username.toLowerCase()) {
        const label = document.createElement("span");
        label.className = "admin-disabled";
        label.textContent = "Administratorkonto";
        row.append(name, label);
        return row;
      }
      const button = document.createElement("button");
      button.className = "button button-outline";
      button.type = "button";
      button.dataset.userId = String(user.id);
      button.dataset.banned = String(user.isBanned);
      button.textContent = user.isBanned ? "Entsperren" : "Sperren";
      const deleteButton = document.createElement("button");
      deleteButton.className = "button button-outline";
      deleteButton.type = "button";
      deleteButton.dataset.deleteUserId = String(user.id);
      deleteButton.dataset.username = user.username;
      deleteButton.textContent = "Löschen";
      const actions = document.createElement("div");
      actions.className = "admin-actions";
      actions.append(button, deleteButton);
      row.append(name, actions);
      return row;
    }));
    const blockedNames = document.querySelector("#blocked-username-list");
    blockedNames.replaceChildren(...data.blockedUsernames.map((username) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = username;
      const button = document.createElement("button");
      button.className = "button button-outline";
      button.type = "button";
      button.dataset.unblockUsername = username;
      button.textContent = "Freigeben";
      row.append(name, button);
      return row;
    }));
    status.textContent = "";
  } catch (error) {
    console.error("Could not load admin moderation data:", error);
    status.textContent = error.message;
  }
}

document.querySelector("#admin-users").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-user-id]");
  if (!button) return;
  const status = document.querySelector("#admin-status");
  try {
    await api("/api/admin/user", {
      userId: Number(button.dataset.userId),
      banned: button.dataset.banned !== "true",
    });
    await refresh();
    status.textContent = "Spielerkonto aktualisiert.";
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#admin-users").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-delete-user-id]");
  if (!button) return;
  const username = button.dataset.username;
  if (!window.confirm(`Konto „${username}“ wirklich endgültig löschen? Alle zugehörigen Tipps und Entwürfe werden ebenfalls gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.`)) {
    return;
  }
  const status = document.querySelector("#admin-status");
  try {
    await api("/api/admin/user/delete", { userId: Number(button.dataset.deleteUserId) });
    await refresh();
    status.textContent = `Konto „${username}“ und seine Tipps wurden gelöscht.`;
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#blocked-username-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-unblock-username]");
  if (!button) return;
  const status = document.querySelector("#admin-status");
  try {
    await api("/api/admin/username", {
      username: button.dataset.unblockUsername,
      blocked: false,
    });
    status.textContent = "Benutzername wieder freigegeben.";
    await refreshAdminPanel();
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#blocked-username-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const username = new FormData(form).get("username").trim();
  const status = document.querySelector("#admin-status");
  try {
    await api("/api/admin/username", { username, blocked: true });
    form.reset();
    status.textContent = "Benutzername für neue Registrierungen gesperrt.";
    await refreshAdminPanel();
  } catch (error) {
    status.textContent = error.message;
  }
});

function openAuth(mode = "login") {
  if (!hasCookieConsent()) {
    openCookieSettings(true);
    return;
  }
  authMode = mode;
  authError.textContent = "";
  authForm.reset();
  document.querySelector("#auth-title").innerHTML = mode === "login"
    ? "Willkommen<br>zurück<span class=\"yellow-dot\">.</span>"
    : "Dabei sein<br>ist alles<span class=\"yellow-dot\">.</span>";
  document.querySelector("#auth-description").textContent = mode === "login"
    ? "Melde dich mit deinem Benutzernamen oder deiner E-Mail an."
    : "Erstelle dein Konto für die gemeinsame Tippliga.";
  document.querySelector("#auth-submit").innerHTML = mode === "login"
    ? "Anmelden <span aria-hidden=\"true\">→</span>"
    : "Konto erstellen <span aria-hidden=\"true\">→</span>";
  document.querySelector("#auth-toggle").innerHTML = mode === "login"
    ? "Noch kein Konto? <strong>Jetzt registrieren</strong>"
    : "Schon dabei? <strong>Zur Anmeldung</strong>";
  document.querySelector("#username").placeholder = mode === "login"
    ? "Benutzername oder E-Mail" : "Dein Benutzername";
  document.querySelector("#username").autocomplete = mode === "login" ? "username" : "username";
  document.querySelector("#password").autocomplete = mode === "login" ? "current-password" : "new-password";
  document.querySelectorAll("[data-register-only]").forEach((field) => {
    field.hidden = mode !== "register";
    field.querySelectorAll("input").forEach((input) => {
      input.disabled = mode !== "register";
    });
  });
  authDialog.showModal();
  document.querySelector("#username").focus();
}

document.querySelector("#accept-cookies").addEventListener("click", () => {
  saveCookieConsent("accepted");
  cookieDialog.close();
  if (authAfterCookieConsent) openAuth();
  authAfterCookieConsent = false;
});

document.querySelector("#decline-cookies").addEventListener("click", async () => {
  saveCookieConsent("declined");
  cookieDialog.close();
  authAfterCookieConsent = false;
  let status = "Ohne notwendige Cookies kannst du dich nicht anmelden oder registrieren.";
  if (state?.me) {
    try {
      await api("/api/logout", {});
      await refresh();
    } catch (error) {
      status = `Abmeldung nach der Ablehnung fehlgeschlagen: ${error.message}`;
    }
  }
  submitStatus.textContent = status;
});

document.querySelector("#cookie-settings").addEventListener("click", () => {
  openCookieSettings();
});
cookieDialog.addEventListener("cancel", (event) => event.preventDefault());

document.querySelector("#account-button").addEventListener("click", async () => {
  if (!state?.me) {
    openAuth();
    return;
  }
  try {
    await api("/api/logout", {});
    submitStatus.textContent = "Du bist abgemeldet.";
    await refresh();
  } catch (error) {
    submitStatus.textContent = error.message;
  }
});

document.querySelector("#auth-toggle").addEventListener("click", () => {
  openAuth(authMode === "login" ? "register" : "login");
});
document.querySelector("#close-dialog").addEventListener("click", () => authDialog.close());
authDialog.addEventListener("click", (event) => {
  if (event.target === authDialog) authDialog.close();
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.textContent = "";
  if (!hasCookieConsent()) {
    authDialog.close();
    openCookieSettings(true);
    return;
  }
  const submit = document.querySelector("#auth-submit");
  submit.disabled = true;
  const form = new FormData(authForm);
  try {
    let authenticatedUser;
    if (authMode === "register") {
      authenticatedUser = await api("/api/register", {
        username: form.get("username"),
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        email: form.get("email"),
        address: form.get("address"),
        phone: form.get("phone"),
        password: form.get("password"),
      });
    } else {
      authenticatedUser = await api("/api/login", {
        identity: form.get("username"),
        password: form.get("password"),
      });
    }
    const authenticatedState = await api(
      `/api/state?competition=${encodeURIComponent(selectedCompetitionCode)}`,
    );
    if (authenticatedState.me?.username.toLowerCase() !== authenticatedUser.username.toLowerCase()) {
      throw new Error("Die Anmeldung hat nicht geklappt. Bitte erlaube Cookies in deinen Browser-Einstellungen und versuche es erneut.");
    }
    authDialog.close();
    state = authenticatedState;
    render();
    await refreshAdminPanel();
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector("#submit-tips").addEventListener("click", async () => {
  if (!state?.me) {
    submitStatus.textContent = "Bitte melde dich zuerst an, um Tipps abzugeben.";
    openAuth();
    return;
  }
  window.clearTimeout(draftSaveTimeout);
  try {
    await syncDraft();
  } catch (error) {
    console.error("Could not synchronize the tip draft before submission:", error);
  }
  const activeInputs = [...document.querySelectorAll(".score-input:not(:disabled)")];
  if (!activeInputs.length) {
    submitStatus.textContent = "Für diesen Spieltag sind keine offenen Tipps mehr möglich.";
    return;
  }
  const predictions = new Map();
  const invalidMatchIds = new Set();
  for (const input of activeInputs) {
    const matchId = input.dataset.matchId;
    if (!predictions.has(matchId)) predictions.set(matchId, {});
    if (input.value !== "" && !input.validity.valid) invalidMatchIds.add(matchId);
    if (input.value !== "" && input.validity.valid) {
      predictions.get(matchId)[input.dataset.side] = Number(input.value);
    }
  }
  if (invalidMatchIds.size) {
    submitStatus.textContent = "Korrigiere bitte ungültige Ergebnisse. Erlaubt sind ganze Zahlen von 0 bis 20.";
    return;
  }
  const completePredictions = [...predictions.entries()].filter(([, score]) =>
    Number.isInteger(score.home) && Number.isInteger(score.away));
  if (!completePredictions.length) {
    submitStatus.textContent = "Gib mindestens für ein Spiel beide Ergebnisse ein. Andere Spiele kannst du leer lassen und später tippen.";
    return;
  }
  const tips = completePredictions.map(([matchId, score]) => ({
    matchId: Number(matchId),
    home: score.home,
    away: score.away,
  }));
  const competitionCode = selectedCompetitionCode;
  const storageKey = draftKey();
  const draftSeason = state.season;
  const draftMatchday = state.matchday;
  try {
    const result = await api("/api/tips", {
      competitionCode,
      tips,
    });
    const draftRemoved = removeSubmittedDraft(
      tips, storageKey, draftSeason, draftMatchday, competitionCode,
    );
    const incompleteCount = [...predictions.values()].filter((score) =>
      (score.home === undefined) !== (score.away === undefined)).length;
    let message;
    if (result.emailStatus === "sent") {
      message = "Tipps gespeichert und per E-Mail versendet.";
    } else if (result.emailStatus === "failed") {
      message = "Tipps gespeichert, aber der E-Mail-Versand ist fehlgeschlagen. Bitte Admin kontaktieren.";
    } else {
      message = "Tipps auf dem Server gespeichert. E-Mail-Versand ist noch nicht eingerichtet.";
    }
    if (incompleteCount) {
      const skippedMessage = incompleteCount === 1
        ? "Ein teilweise ausgefülltes Spiel wurde übersprungen."
        : `${incompleteCount} teilweise ausgefüllte Spiele wurden übersprungen.`;
      message += ` ${skippedMessage} Ergänze sie und schicke sie später ab.`;
    } else if (completePredictions.length < predictions.size) {
      message += " Die übrigen Spiele kannst du später tippen.";
    }
    submitStatus.textContent = message;
    if (!draftRemoved) submitStatus.textContent += " Der Entwurf auf diesem Gerät konnte nicht gelöscht werden.";
    await refresh();
  } catch (error) {
    if (error.status === 409) await refresh();
    submitStatus.textContent = error.message;
  }
});

if (cookieConsent === "unknown") openCookieSettings();
initialize();
window.setInterval(refresh, 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});
