# Tippliga

Eine private Bundesliga-Tipprunde mit Benutzerkonten, serverseitig gespeicherten Tipps, Rangliste und aktuellem Spielplan von OpenLigaDB. Es gibt keine Geld-, Einsatz- oder Auszahlungsfunktion.

## Lokal starten

Voraussetzung: Python 3.10 oder neuer.

```sh
cd Tippliga
python3 server.py
```

Dann `http://127.0.0.1:8000` öffnen. Konten, Sitzungen und Tipps landen in `data/tippliga.sqlite3`; die Datenbank wird beim ersten Start erstellt. Die Seite fragt den Bundesliga-Spielplan der laufenden Saison bei OpenLigaDB ab und aktualisiert den Cache alle zehn Minuten. Für Spielplan-Daten ist eine Internetverbindung erforderlich. Wenn die Datenquelle nicht erreichbar ist, zeigt die Seite einen Fehler, statt Beispielspiele vorzutäuschen.

## Öffentlich im Internet mit Netlify hosten

Netlify stellt die Webseite als statische Dateien bereit und führt die API als serverlose JavaScript-Funktion aus. Konten, Sitzungen und Tipps werden in Neon-PostgreSQL gespeichert, nicht auf dem kurzlebigen Dateisystem der Funktion.

1. Bei [Neon](https://neon.tech/) ein kostenloses PostgreSQL-Projekt erstellen und die **gepoolte** Verbindungszeichenfolge kopieren.
2. Bei [Netlify](https://app.netlify.com/) einloggen, **Add new site → Import an existing project** auswählen und das GitHub-Repository `nx201nx201/tippliga` verbinden.
3. Netlify erkennt `netlify.toml`. Bevor du veröffentlichst, trage in den Site-Einstellungen unter **Environment variables** `DATABASE_URL` mit der Neon-Verbindungszeichenfolge ein. Füge die URL nicht in GitHub oder in eine Projektdatei ein.
4. Deployen und die von Netlify angezeigte Website öffnen. Die Datenbanktabellen werden beim ersten API-Aufruf angelegt.

Netlify bietet einen kostenlosen Tarif mit Functions an, aber dessen Nutzung ist begrenzt. Die veröffentlichte Preisseite garantiert nicht, dass jede Konto-Anmeldung ohne Zahlungsdaten-Verifizierung möglich ist. Falls Netlify eine Kreditkarte verlangt, nicht eingeben; der kostenlose Tarif lässt sich nicht durch die App erzwingen. Neon Free und Netlify Free unterliegen jeweils den aktuellen Limits und Bedingungen.

Die lokale SQLite-Datenbank wird nicht zu Neon kopiert. Die gehostete Anwendung startet deshalb mit einer leeren Datenbank; vorhandene lokale Konten und Tipps werden nicht hochgeladen.

## Alternative: öffentlich mit Render hosten

Die App ist für Render mit einem kostenlosen Web-Service und einer externen PostgreSQL-Datenbank vorbereitet (`render.yaml`). SQLite bleibt die lokale Standarddatenbank; sobald `DATABASE_URL` gesetzt ist, verwendet die App PostgreSQL.

1. Bei [Neon](https://neon.tech/) ein kostenloses PostgreSQL-Projekt erstellen und dort die Verbindungszeichenfolge (Connection string) kopieren. Neons Free-Tarif ist laut aktueller Preisseite dauerhaft kostenlos und erfordert keine Kreditkarte; Limits und Tarifbedingungen können sich ändern.
2. In Render **New + → Blueprint** wählen, das GitHub-Repository verbinden und `render.yaml` bestätigen. Beim Anlegen fragt Render nach `DATABASE_URL`; dort die kopierte Neon-Verbindungszeichenfolge einfügen. Nicht in GitHub oder in diese Datei eintragen.
3. Der Blueprint verwendet den kostenlosen Render-Web-Service. Er schläft bei Inaktivität ein und kann beim ersten Aufruf danach etwa eine Minute zum Aufwachen brauchen. Die Konten und Tipps werden in Neon gespeichert, nicht im flüchtigen Dateisystem von Render.
4. Nach erfolgreichem Start die von Render angezeigte `onrender.com`-Adresse öffnen. Eine eigene Domain kannst du später unter **Settings → Custom Domains** hinzufügen.
5. Für E-Mail-Benachrichtigungen unter **Environment** die `SMTP_*` Variablen aus dem Abschnitt unten setzen und erneut deployen. Ohne diese Zugangsdaten werden Tipps gespeichert, aber keine E-Mail versendet.

`COOKIE_SECURE=1`, der beschränkte Datei-Server und `/api/health` sind in der Render-Konfiguration enthalten. Render Free und Neon Free haben Nutzungsgrenzen und keine Produktionsgarantie. Wenn Render trotzdem eine Kreditkarte verlangt, nicht fortfahren oder Zahlungsdaten eingeben; prüfe zuerst, dass im Blueprint der kostenlose Service ausgewählt ist. Eine Konto-Verifizierung durch Render lässt sich durch diese App-Änderung nicht umgehen.

Die lokale SQLite-Datenbank wird nicht zu Neon kopiert. Der gehostete Dienst startet daher mit einer leeren Datenbank; vorhandene lokale Konten und Tipps werden nicht hochgeladen.

Für Netlify wird stattdessen der separate Funktions-Backend-Einstieg `netlify/functions/api.mjs` verwendet; der normale Python-Webserver ist nicht die Netlify-API.

Die Spieltagskarten zeigen vollständige Vereinsnamen und Vereinswappen der Bundesliga-Datenquelle. Die Bilddateien werden von den in der Content-Security-Policy freigegebenen Wappen-Hosts geladen.

## Konten und Tipps

- Registrierung benötigt Benutzername, Vorname, Nachname, E-Mail und ein Passwort mit mindestens 10 Zeichen. Adresse und Telefonnummer sind optional.
- Login akzeptiert Benutzername **oder** E-Mail-Adresse. Passwörter werden serverseitig mit scrypt gehasht; Sitzungen sind zufällige, serverseitig gespeicherte HttpOnly-Cookies.
- Namen, E-Mail-Adressen, optionale Kontaktdaten und Tipps bleiben auf dem eigenen Server. Nur der Benutzername und die errechneten Punkte erscheinen in der Rangliste.
- Tipps lassen sich nur für noch nicht begonnene Spiele des aktuellen Spieltags speichern. Exakter Tipp: 3 Punkte; richtige Tendenz: 1 Punkt.
- Neue Konten starten ohne Punkte; es gibt keine Demo-Nutzer.
- Die Rangliste wird automatisch aus allen registrierten Konten, gespeicherten Tipps und den offiziellen Endergebnissen berechnet. Sobald OpenLigaDB ein Spiel als beendet mit Endergebnis meldet, wird der Punktestand bei der nächsten Aktualisierung neu berechnet. Der Browser aktualisiert die Anzeige alle fünf Minuten; der Server hält Spieldaten zehn Minuten im Cache.

## E-Mail-Benachrichtigung

Tipps werden immer in der Datenbank gespeichert. Eine zusätzliche Benachrichtigung an `nx201nx201@outlook.de` wird nur versendet, wenn der Server mit SMTP-Zugangsdaten gestartet wird. Für Netlify trägst du diese Variablen unter **Environment variables** der Site ein:

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.

Für lokalen Start mit dem Python-Server:

```sh
SMTP_HOST=smtp.example.com \
SMTP_PORT=587 \
SMTP_USER=... \
SMTP_PASSWORD=... \
SMTP_FROM=tippliga@example.com \
python3 server.py
```

Ohne SMTP-Konfiguration meldet die App ausdrücklich, dass keine E-Mail verschickt wurde. SMTP-Kennwörter nicht in Quellcode oder Versionsverwaltung speichern. Die Registrierung nimmt eine E-Mail-Adresse auf, verifiziert deren Besitz aber nicht; vor öffentlichem Betrieb ist zusätzlich ein E-Mail-Verifikations- und Passwort-zurücksetzen-Ablauf einzurichten.

## Tests

```sh
cd Tippliga
python3 -m unittest -v
npm test
```
