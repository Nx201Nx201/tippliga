const berlinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function seasonFor(date = new Date()) {
  const parts = Object.fromEntries(berlinDate.formatToParts(date).map(({ type, value }) => [type, value]));
  const year = Number(parts.year);
  return Number(parts.month) >= 7 ? year : year - 1;
}

export function resultOf(match) {
  if (!match.matchIsFinished) return null;
  const results = match.matchResults || [];
  const finalResult = results.find((result) => result.resultTypeID === 2)
    || [...results].sort((a, b) => (b.resultOrderID || 0) - (a.resultOrderID || 0))[0];
  return finalResult
    ? [Number(finalResult.pointsTeam1), Number(finalResult.pointsTeam2)]
    : null;
}

export function scorePrediction(predicted, actual) {
  if (predicted[0] === actual[0] && predicted[1] === actual[1]) {
    return actual[0] === actual[1] ? 1 : 3;
  }
  if (predicted[0] === actual[0] || predicted[1] === actual[1]) return 1;
  const predictedOutcome = Math.sign(predicted[0] - predicted[1]);
  const actualOutcome = Math.sign(actual[0] - actual[1]);
  return predictedOutcome === actualOutcome ? 1 : 0;
}

export function currentMatchday(matches, now = new Date()) {
  if (!matches.length) throw new Error("Der Spielplan enthält noch keine Spiele.");
  const groups = new Map();
  for (const match of matches) {
    const group = match.group || {};
    if (group.groupID === undefined || group.groupID === null) continue;
    const id = Number(group.groupID);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(match);
  }
  if (!groups.size) throw new Error("Im Spielplan fehlen Spieltagsangaben.");

  const kickoffOf = (match) => new Date(match.matchDateTimeUTC);
  const openGroups = [...groups.values()]
    .map((group) => ({
      group,
      kickoff: Math.min(...group.filter((match) => !match.matchIsFinished).map(kickoffOf)),
    }))
    .filter(({ kickoff }) => Number.isFinite(kickoff));

  const candidates = openGroups
    .filter(({ kickoff }) => kickoff >= now.getTime() - 8 * 60 * 60 * 1000)
    .sort((a, b) => a.kickoff - b.kickoff);
  let selected = candidates[0]?.group;

  if (!selected && openGroups.length) {
    selected = openGroups.sort((a, b) => a.kickoff - b.kickoff)[0].group;
  }
  if (!selected) {
    selected = [...groups.values()].sort((a, b) => {
      const aOrder = Math.max(...a.map((match) => Number(match.group.groupOrderID) || 0));
      const bOrder = Math.max(...b.map((match) => Number(match.group.groupOrderID) || 0));
      return bOrder - aOrder;
    })[0];
  }

  selected.sort((a, b) => kickoffOf(a) - kickoffOf(b));
  return { group: selected[0].group, matches: selected };
}

export function publicMatch(match) {
  const kickoff = new Date(match.matchDateTimeUTC);
  const local = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(kickoff);
  const values = Object.fromEntries(local.map(({ type, value }) => [type, value]));
  const weekdays = { Mo: "MO", Di: "DI", Mi: "MI", Do: "DO", Fr: "FR", Sa: "SA", So: "SO" };
  const months = ["JAN", "FEB", "MÄR", "APR", "MAI", "JUN", "JUL", "AUG", "SEP", "OKT", "NOV", "DEZ"];
  let homeLogo = match.team1.teamIconUrl || null;
  let awayLogo = match.team2.teamIconUrl || null;
  const leverkusenLogo = "https://upload.wikimedia.org/wikipedia/en/5/59/Bayer_04_Leverkusen_logo.svg";
  if (match.team1.teamName === "Bayer 04 Leverkusen") homeLogo = leverkusenLogo;
  if (match.team2.teamName === "Bayer 04 Leverkusen") awayLogo = leverkusenLogo;
  const result = resultOf(match);

  return {
    id: Number(match.matchID),
    date: kickoff.toISOString(),
    day: `${weekdays[values.weekday.replace(".", "")] || values.weekday.toUpperCase()}, ${values.day}. ${months[Number(values.month) - 1]}`,
    time: `${values.hour}:${values.minute}`,
    home: match.team1.teamName,
    away: match.team2.teamName,
    homeShort: match.team1.shortName,
    awayShort: match.team2.shortName,
    homeLogo,
    awayLogo,
    matchday: match.group.groupName,
    matchdayId: Number(match.group.groupID),
    finished: Boolean(match.matchIsFinished),
    result: result ? { home: result[0], away: result[1] } : null,
  };
}

export class RegistrationValidationError extends Error {}

export function validateRegistration(data) {
  const username = String(data.username ?? "").trim();
  const email = String(data.email ?? "").trim().toLowerCase();
  const firstName = String(data.firstName ?? "").trim();
  const lastName = String(data.lastName ?? "").trim();
  const address = String(data.address ?? "").trim();
  const phone = String(data.phone ?? "").trim();
  const password = data.password;
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(username)) {
    throw new RegistrationValidationError("Benutzername: 3–24 Zeichen (Buchstaben, Zahlen, Punkt, _ oder -).");
  }
  if (typeof password !== "string" || password.length < 10 || password.length > 256) {
    throw new RegistrationValidationError("Das Passwort muss mindestens 10 Zeichen lang sein.");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    throw new RegistrationValidationError("Bitte gib eine gültige E-Mail-Adresse ein.");
  }
  for (const [label, value] of [["Vorname", firstName], ["Nachname", lastName]]) {
    if (!value || value.length > 80 || [...value].some((char) => char.charCodeAt(0) < 32)) {
      throw new RegistrationValidationError(`${label} ist erforderlich und darf höchstens 80 Zeichen lang sein.`);
    }
  }
  if (address.length > 240 || phone.length > 40) {
    throw new RegistrationValidationError("Adresse oder Telefonnummer ist zu lang.");
  }
  return { username, email, firstName, lastName, address, phone, password };
}
