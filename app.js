let state = null;
let authMode = "login";

const leaderboardBody = document.querySelector("#leaderboard-body");
const playerCount = document.querySelector("#player-count");
const fixturesList = document.querySelector("#fixtures-list");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const authError = document.querySelector("#auth-error");
const submitStatus = document.querySelector("#submit-status");

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Die Anfrage ist fehlgeschlagen.");
  return data;
}

function initials(name) {
  return name.slice(0, 2).toUpperCase();
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

function makeTeam(name, shortName, logoUrl, position) {
  const wrapper = document.createElement("div");
  wrapper.className = position;
  const team = document.createElement("div");
  team.className = "fixture-team";
  const badge = document.createElement("span");
  badge.className = "fixture-team-badge";
  if (logoUrl) {
    const logo = document.createElement("img");
    logo.className = "club-crest";
    logo.src = logoUrl;
    logo.alt = `${name} Vereinswappen`;
    logo.loading = "lazy";
    logo.referrerPolicy = "no-referrer";
    logo.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "crest-fallback";
      fallback.textContent = initials(shortName || name);
      badge.replaceChildren(fallback);
    }, { once: true });
    badge.append(logo);
  } else {
    const fallback = document.createElement("span");
    fallback.className = "crest-fallback";
    fallback.textContent = initials(shortName || name);
    badge.append(fallback);
  }
  const label = document.createElement("span");
  label.textContent = name;
  team.append(badge, label);
  wrapper.append(team);
  return wrapper;
}

function scoreBox(match, side, label) {
  const input = document.createElement("input");
  input.className = "score-input";
  input.type = "number";
  input.min = "0";
  input.max = "20";
  input.step = "1";
  input.inputMode = "numeric";
  input.dataset.matchId = String(match.id);
  input.dataset.side = side;
  input.setAttribute("aria-label", `${label} ${match.home} – ${match.away}`);

  const prediction = state?.tips?.[String(match.id)];
  const started = Date.parse(match.date) <= Date.now();
  const result = match.result;
  if (prediction) {
    input.value = String(prediction[side]);
  } else if (result) {
    input.value = String(result[side]);
  }
  input.disabled = !state?.me || started || match.finished;
  return input;
}

function renderFixtures() {
  if (!state?.matches?.length) {
    fixturesList.replaceChildren();
    const message = document.createElement("p");
    message.className = "fixture-error";
    message.textContent = "Für den aktuellen Spieltag sind derzeit keine Spiele verfügbar.";
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
  if (state?.me) {
    button.textContent = "Abmelden";
    welcome.textContent = `Hi, ${state.me.firstName}`;
    note.textContent = "Tipps sind bis zum Anpfiff des jeweiligen Spiels möglich.";
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
  if (!logoUrl) {
    badge.textContent = initials(shortName || name);
    return;
  }
  const logo = document.createElement("img");
  logo.className = "club-crest";
  logo.src = logoUrl;
  logo.alt = `${name} Vereinswappen`;
  logo.referrerPolicy = "no-referrer";
  logo.addEventListener("error", () => {
    badge.textContent = initials(shortName || name);
  }, { once: true });
  badge.append(logo);
}

function render() {
  renderAccount();
  renderLeaderboard();
  renderFixtures();
  renderNextMatch();
  const roundNumber = state?.matchday?.match(/\d+/)?.[0] || "–";
  document.querySelector("#hero-round").innerHTML = `${roundNumber}<span>.</span>`;
  document.querySelector("#round-widget").setAttribute("aria-label", `Spieltag ${roundNumber}`);
  document.querySelector("#season-label").textContent = state?.season || "—";
  document.querySelector("#matchday-label").textContent = state?.matchday
    ? `${state.matchday.toUpperCase()} · DEIN GEFÜHL. DEIN TIPP.`
    : "DEIN GEFÜHL. DEIN TIPP.";
}

async function refresh() {
  try {
    state = await api("/api/state");
    render();
  } catch (error) {
    fixturesList.replaceChildren();
    const message = document.createElement("p");
    message.className = "fixture-error";
    message.textContent = error.message;
    fixturesList.append(message);
    document.querySelector("#tip-login-note").textContent = "Der Server oder Spielplan ist gerade nicht erreichbar.";
    submitStatus.textContent = error.message;
  }
}

function openAuth(mode = "login") {
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
  const submit = document.querySelector("#auth-submit");
  submit.disabled = true;
  const form = new FormData(authForm);
  try {
    if (authMode === "register") {
      await api("/api/register", {
        username: form.get("username"),
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        email: form.get("email"),
        address: form.get("address"),
        phone: form.get("phone"),
        password: form.get("password"),
      });
    } else {
      await api("/api/login", {
        identity: form.get("username"),
        password: form.get("password"),
      });
    }
    authDialog.close();
    await refresh();
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
  const activeInputs = [...document.querySelectorAll(".score-input:not(:disabled)")];
  if (!activeInputs.length) {
    submitStatus.textContent = "Für diesen Spieltag sind keine offenen Tipps mehr möglich.";
    return;
  }
  if (activeInputs.some((input) => input.value === "" || !input.validity.valid)) {
    submitStatus.textContent = "Bitte tippe jedes noch offene Spiel mit einem Ergebnis von 0 bis 20.";
    return;
  }
  const predictions = new Map();
  for (const input of activeInputs) {
    if (!predictions.has(input.dataset.matchId)) predictions.set(input.dataset.matchId, {});
    predictions.get(input.dataset.matchId)[input.dataset.side] = Number(input.value);
  }
  const tips = [...predictions.entries()].map(([matchId, score]) => ({
    matchId: Number(matchId),
    home: score.home,
    away: score.away,
  }));
  try {
    const result = await api("/api/tips", { tips });
    if (result.emailStatus === "sent") {
      submitStatus.textContent = "Tipps gespeichert und per E-Mail versendet.";
    } else if (result.emailStatus === "failed") {
      submitStatus.textContent = "Tipps gespeichert, aber der E-Mail-Versand ist fehlgeschlagen. Bitte Admin kontaktieren.";
    } else {
      submitStatus.textContent = "Tipps auf dem Server gespeichert. E-Mail-Versand ist noch nicht eingerichtet.";
    }
    await refresh();
  } catch (error) {
    submitStatus.textContent = error.message;
  }
});

refresh();
window.setInterval(refresh, 5 * 60 * 1000);
