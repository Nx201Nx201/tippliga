# Tippliga auf Vercel

Vercel kann dieselbe Anwendung und API wie Netlify hosten. Damit bestehende Konten und Tipps erhalten bleiben, verbinde Vercel mit derselben PostgreSQL-Datenbank:

1. Importiere dieses GitHub-Repository in Vercel und verwende das Repository-Verzeichnis als Root Directory. [vercel.json](./vercel.json) setzt das Framework-Preset auf **Other** (`framework: null`), baut die statischen Dateien nach `public/` und lässt Vercel `api/[...path].mjs` als Node.js-Function erkennen.
2. `.vercelignore` schließt Render-/Python-Dateien aus dem Vercel-Deployment aus. `server.py` ist der HTTP-Server für Render und darf nicht als Vercel-Function ausgeführt werden.
3. Trage in Vercel unter **Settings → Environment Variables** `DATABASE_URL` mit exakt dem bereits bei Netlify verwendeten Neon-PostgreSQL-Verbindungswert für **Production** ein. Erstelle keine neue Datenbank und ändere den bestehenden Wert nicht. Nutze für Preview/Development eine separate Testdatenbank, damit Vorschau-Deployments nicht in die Live-Daten schreiben.
4. Setze optional `TIPPLIGA_ADMIN_USERNAME` und die benötigten `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` und `SMTP_FROM`-Werte.
5. Push die Änderungen zu GitHub und deploye dann Vercel erneut. Prüfe im Build-Log, dass `server.py` nicht als Function ausgewählt wird und `api/[...path].mjs` als Node.js-Function bereitgestellt wird. Prüfe anschließend `https://<deine-domain>/api/health`; erwartet wird `{"ok":true}`. Erst danach Anmeldung, bestehende Konten und Ranglisten testen.

Die Konten, Tipps und Entwürfe liegen in PostgreSQL, nicht im Vercel-Dateisystem. Solange `DATABASE_URL` auf dieselbe Datenbank zeigt, verwendet Vercel die bestehenden Daten weiter. Die lokal ignorierte SQLite-Datei wird von der Vercel-Function nicht als Datenbank verwendet. Netlify bleibt währenddessen unverändert erreichbar.

Die Wettbewerbstabelle wird aus den bei OpenLigaDB vorhandenen Ergebnissen berechnet. Wettbewerbe ohne Spieldaten bleiben auswählbar und zeigen einen Hinweis, dass aktuell keine Spiele verfügbar sind. Vorhandene Vereinswappen werden aus dem Spielplan-Feed geladen; wenn ein Wappen fehlt oder nicht geladen werden kann, zeigt die Seite ein automatisch erzeugtes Ersatzwappen.
