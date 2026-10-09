# Tippliga

Eine private Bundesliga-Tipprunde mit Benutzerkonten, serverseitig gespeicherten Tipps, Rangliste und aktuellem Spielplan von OpenLigaDB. Es gibt keine Geld-, Einsatz- oder Auszahlungsfunktion.

## Lokal starten

Voraussetzung: Python 3.10 oder neuer.

```sh
cd Tippliga
python3 server.py
```

Dann `http://127.0.0.1:8000` öffnen. Konten, Sitzungen und Tipps landen in `data/tippliga.sqlite3`; die Datenbank wird beim ersten Start erstellt. Die Seite fragt den Bundesliga-Spielplan der laufenden Saison bei OpenLigaDB ab und aktualisiert den Cache alle zehn Minuten. Für Spielplan-Daten ist eine Internetverbindung erforderlich. Wenn die Datenquelle nicht erreichbar ist, zeigt die Seite einen Fehler, statt Beispielspiele vorzutäuschen.

## Öffentlich im Internet mit Render hosten

Die App ist jetzt für Render vorbereitet (`render.yaml`). Für die Veröffentlichung:

1. Den Inhalt dieses `Tippliga`-Ordners in ein eigenes GitHub-Repository hochladen. `data/` und lokale Datenbanken werden durch `.gitignore` ausgeschlossen.
2. Bei Render **New + → Blueprint** wählen, das Repository verbinden und `render.yaml` bestätigen. Der Blueprint verwendet einen Web-Service mit dauerhaftem Speicher für SQLite. Der notwendige Service-/Speicher-Tarif ist nicht kostenlos; Render zeigt die aktuellen Kosten vor dem Erstellen an.
3. Nach dem ersten Start in Render **Settings → Custom Domains** öffnen und deine Domain eintragen. Die von Render angezeigten DNS-Einträge beim Domain-Anbieter setzen. HTTPS wird von Render für die verbundene Domain bereitgestellt.
4. Für E-Mail-Benachrichtigungen unter **Environment** die `SMTP_*` Variablen aus dem Abschnitt unten setzen und erneut deployen. Ohne diese Zugangsdaten werden Tipps gespeichert, aber keine E-Mail versendet.

`COOKIE_SECURE=1`, der beschränkte Datei-Server und `/api/health` sind in der Render-Konfiguration enthalten. Ohne Render-Konto-, Repository- und Domainzugriff kann der Dienst nicht von hier aus veröffentlicht oder mit deiner Domain verbunden werden.

**Nicht einfach bei Vercel hochladen:** Die aktuelle App ist ein dauerhafter Python-Webserver mit SQLite-Datei. Vercels Serverless-Funktionen bieten dieser SQLite-Datei keinen persistenten Speicher. Für Vercel müsste der Server in Functions zerlegt und SQLite durch einen externen PostgreSQL-Dienst ersetzt werden. Für den vorhandenen Stand ist Render der direkte Weg.

Die Spieltagskarten zeigen vollständige Vereinsnamen und Vereinswappen der Bundesliga-Datenquelle. Die Bilddateien werden von den in der Content-Security-Policy freigegebenen Wappen-Hosts geladen.

## Konten und Tipps

- Registrierung benötigt Benutzername, Vorname, Nachname, E-Mail und ein Passwort mit mindestens 10 Zeichen. Adresse und Telefonnummer sind optional.
- Login akzeptiert Benutzername **oder** E-Mail-Adresse. Passwörter werden serverseitig mit scrypt gehasht; Sitzungen sind zufällige, serverseitig gespeicherte HttpOnly-Cookies.
- Namen, E-Mail-Adressen, optionale Kontaktdaten und Tipps bleiben auf dem eigenen Server. Nur der Benutzername und die errechneten Punkte erscheinen in der Rangliste.
- Tipps lassen sich nur für noch nicht begonnene Spiele des aktuellen Spieltags speichern. Exakter Tipp: 3 Punkte; richtige Tendenz: 1 Punkt.
- Neue Konten starten ohne Punkte; es gibt keine Demo-Nutzer.
- Die Rangliste wird automatisch aus allen registrierten Konten, gespeicherten Tipps und den offiziellen Endergebnissen berechnet. Sobald OpenLigaDB ein Spiel als beendet mit Endergebnis meldet, wird der Punktestand bei der nächsten Aktualisierung neu berechnet. Der Browser aktualisiert die Anzeige alle fünf Minuten; der Server hält Spieldaten zehn Minuten im Cache.

## E-Mail-Benachrichtigung

Tipps werden immer in der Datenbank gespeichert. Eine zusätzliche Benachrichtigung an `nx201nx201@outlook.de` wird nur versendet, wenn der Server mit SMTP-Zugangsdaten gestartet wird:

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
```
