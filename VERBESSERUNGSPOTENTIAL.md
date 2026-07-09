# Verbesserungspotential HKL-Plan

Analyse vom 2026-07-09. Bewertet Backend (`server.js`), Frontend (`index.html`),
Deployment (Docker, CI) und Tests. Gesamtbild: **solide gebaut** — der Server
ist sauber, dependency-frei und gut getestet (51 grüne Tests). Die Punkte unten
sind Optimierungen, keine akuten Defekte. Priorisiert nach Aufwand/Nutzen.

## Sofort erledigt (in diesem Branch)

- **Stale Duplikat `index .html` entfernt.** Eine ältere Kopie mit Leerzeichen im
  Namen (106 KB vs. 223 KB der echten `index.html`) lag im Repo und war
  git-getrackt. Wird nirgends referenziert (Dockerfile kopiert nur `index.html`),
  reines Verwirrungs-/Ballastrisiko — bei einer Bearbeitung leicht die falsche
  Datei erwischt.

## Hoher Nutzen, überschaubarer Aufwand

1. **Schreibschutz nicht nur in nginx.** Aktuell liegt die Write-Auth
   (Basic Auth / Klinik-Netz) ausschließlich im nginx-proxy. Ruft jemand den
   Container direkt an (Netzfehlkonfiguration, anderer Reverse-Proxy, lokaler
   Test gegen Prod-Volume), sind `PUT`/`DELETE /api/state` ungeschützt. Ein
   optionaler Server-seitiger Schutz (z. B. `WRITE_TOKEN` env → Header-Check für
   mutierende Methoden) wäre Defense-in-Depth für Patientendaten. Sicherheitskritisch.

2. **XSS-Oberfläche im Frontend auditieren.** ~98 `innerHTML =`-Zuweisungen.
   `escapeHtml()` existiert und wird an sichtbaren Stellen (Suchergebnisse,
   Status-Tags) verwendet — aber 98 Stellen sind zu viele, um sie per Blick
   abzusichern. Freitextfelder (Name, Station, Indikation, Notizen) landen in
   HTML. Systematisches Audit oder Umstellung heißer Pfade auf `textContent`
   empfohlen. Bei Klinikdaten relevant.

3. **Log-Rauschen reduzieren.** `server.js:279` loggt **jede** Anfrage inkl.
   des 5s-Polls jedes Clients. Bei mehreren offenen Tabs füllt das die
   Container-Logs mit `GET /api/state → 304`. Poll-/304-Antworten
   herausfiltern oder Log-Level per env steuern.

## Mittelfristig / strukturell

4. **Frontend ist eine 2496-Zeilen-Monolithdatei.** Alles inline (HTML, CSS, JS)
   in einer `index.html`. Funktioniert (dependency-frei ist auch ein Feature),
   erschwert aber Wartung, Diff-Reviews und Tests. Optionen: JS/CSS in eigene
   ausgelieferte Dateien splitten (der Server liefert bereits `.js`/`.css`),
   ohne Build-Step. Kein Muss, aber die größte langfristige Wartungslast.

5. **Kein `.editorconfig` / Formatter.** Frontend-Code ist stark verdichtet
   (mehrere Statements pro Zeile, z. B. `index.html:1627`). Ein Formatter würde
   Diffs lesbarer machen — bei einer Monolithdatei besonders wertvoll.

6. **Backups wachsen unbegrenzt in der Anzahl, aber Rotation ist zeit-blind.**
   `MAX_BACKUPS = 40` rotiert nach Anzahl (gut). Es gibt aber kein
   Alters-/Größenlimit — 40 große State-Dateien können das Volume füllen. Für
   den aktuellen Umfang unkritisch, bei Wachstum beobachten.

7. **Health-Endpoint ohne Version/Commit.** `/api/health` liefert nur
   `{ok, name, time}`. Ein `version`/`commit`-Feld (z. B. aus env beim Build)
   würde Deployment-Verifikation erleichtern (welcher Stand läuft?).

## Kleinigkeiten

8. **`MAX_BODY = 32 MB`** ist für einen JSON-State großzügig; ein realistischeres
   Limit (z. B. 4–8 MB) begrenzt die Angriffsfläche für Speicher-DoS.
9. **Keine Rate-Limits** auf mutierenden Endpunkten. Hinter Auth unkritisch,
   erwähnenswert falls Auth je entfällt.
10. **CI deployt per SSH-Passwort** (`SSH_PASSWORD`). SSH-Key-Auth wäre robuster
    und besser rotierbar als ein Passwort-Secret.

## Was gut ist (nicht anfassen)

- Atomares Schreiben (Temp + Rename), Mutex-Serialisierung der State-Mutationen,
  optimistische Sperre via `If-Match`/ETag — sauber gelöst.
- Path-Traversal-Schutz doppelt (lexisch + `realpath`), inkl. Symlink-Ausbruch.
- Poll-Optimierung mit `304 Not Modified`.
- Dependency-frei, non-root Container, Healthcheck, automatisches TLS.
- Gute Testabdeckung (Backend-API, Traversal, Frontend-Helfer, Last).
