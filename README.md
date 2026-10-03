# HKL-Plan

Web-App zur Planung des Herzkatheterlabors (HKL). Die Oberfläche (`index.html`)
ist eine eigenständige Single-Page-App. Neu ist ein **Docker-Backend mit
serverseitigem Zustand**: HKL-Einträge, die im Webinterface geändert werden,
persistieren nicht nur im `localStorage` des Browsers, sondern **serverseitig**
und damit geräte- und browserübergreifend.

Produktiv erreichbar unter: **https://hkl.kardio.wiki**

---

## Architektur

```
Browser (index.html)
   │  GET/PUT /api/state   (Sync-Layer, Debounce + 5s-Poll, ETag)
   ▼
nginx-proxy (TLS, hkl.kardio.wiki)  ──► hkl-plan-Container (Node, :4180)
   │  Let's Encrypt (companion)              │  liefert index.html aus
   │                                         │  /api/state  ← state.json
   ▼                                         ▼
443/HTTPS                          Docker-Volume  hkl-plan-data  (/data)
```

- **Backend** (`server.js`): reine Node-Standardbibliothek, keine Abhängigkeiten.
  Liefert die statische App aus und speichert den kompletten App-Zustand
  (`{ cases, config, rooms, settings, notfallLog }`) atomar als
  `data/state.json`. Bei jedem Schreibvorgang wird ein Backup unter
  `data/backups/` angelegt (die letzten 40 bleiben erhalten).
- **Frontend-Sync** (`Sync` in `index.html`): lädt beim Start den Server-Zustand,
  schreibt Änderungen debounced per `PUT` zurück (optimistische Sperre via
  `If-Match`/ETag) und pollt alle 5 s auf fremde Änderungen. Ist kein Backend
  erreichbar (z. B. Öffnen per `file://`), arbeitet die App wie bisher rein
  lokal weiter. Ein kleines Status-Badge unten rechts zeigt den Sync-Zustand.

### API

| Methode | Pfad          | Zweck                                                        |
|---------|---------------|-------------------------------------------------------------|
| GET     | `/api/state`  | Aktuellen Zustand holen (`204` wenn noch keiner existiert; `304` bei `If-None-Match`). |
| PUT     | `/api/state`  | Zustand speichern. `If-Match: <etag>` für optimistische Sperre (`409` bei Konflikt). |
| DELETE  | `/api/state`  | Serverseitigen Zustand löschen (mit Backup).                |
| GET     | `/api/health` | Health-Probe (Docker-Healthcheck, Backend-Erkennung).      |

---

## Lokal starten

Ohne Docker (Node ≥ 18):

```bash
# index.html muss unter DOCS_DIR/index.html liegen:
mkdir -p web && cp index.html web/
DOCS_DIR=./web DATA_DIR=./data npm start
# → http://127.0.0.1:4180
```

Mit Docker:

```bash
docker compose up -d --build     # → http://localhost:4180
```

---

## Tests

Test-Suite ohne externe Abhängigkeiten (nur `node:test` / `node:assert`,
Node ≥ 18):

```bash
npm test
```

Abgedeckt sind:

- **`test/server.test.js`** – Integrationstests gegen den echten Server
  (als Kindprozess, temporäre `DOCS_DIR`/`DATA_DIR`). Prüft alle
  Server-Funktionen über HTTP: `/api/health`, den kompletten
  `/api/state`-Lebenszyklus (GET/PUT/POST/DELETE), ETag/`If-None-Match` (304),
  optimistische Sperre via `If-Match` (409-Konflikt), Zustandsvalidierung
  (400), Backups, gleichzeitige Schreibvorgänge (Lock), sowie die statische
  Auslieferung inkl. MIME-Typen, Verzeichnis-Index, HEAD, 404/405 und
  Path-Traversal-Schutz.
- **`test/frontend.test.js`** – Unit-Tests der reinen Hilfsfunktionen aus
  `index.html`. Das Inline-`<script>` wird über `test/load-frontend.js` in
  einer `node:vm`-Sandbox mit minimalen Browser-Stubs ausgewertet (kein
  jsdom); getestet werden die deterministischen, seiteneffektfreien Funktionen
  (Datum/Uhrzeit, Formatierung, Fall-Logik, Farb-/HTML-Helfer,
  Konfigurationsprüfung). DOM-rendernde bzw. auf den mutierten Laufzeit-`state`
  angewiesene Funktionen sind hier bewusst ausgeklammert.

---

## Produktiv-Deployment (162.19.250.88)

Die App läuft hinter dem bereits vorhandenen **jwilder/nginx-proxy** +
**letsencrypt-nginx-proxy-companion** im externen Docker-Netz `proxy`.
Routing und Zertifikat steuern die `VIRTUAL_HOST`/`LETSENCRYPT_*`-Variablen in
`docker-compose.prod.yml`.

```bash
cd ~/server/hkl
docker compose -f docker-compose.prod.yml up -d --build
```

### TLS / Let's Encrypt

Der letsencrypt-companion stellt für `hkl.kardio.wiki` automatisch ein
Zertifikat per **HTTP-01-Challenge** aus – identisch zu den übrigen
`*.kardio.wiki`-Subdomains auf diesem Server.

> **Hinweis Wildcard:** Ein echtes Wildcard-Zertifikat (`*.kardio.wiki`) verlangt
> eine **DNS-01-Challenge** mit API-Zugang zum DNS-Provider. Dieser Zugang ist auf
> dem Server nicht hinterlegt, daher wird – wie bei allen bestehenden Subdomains –
> ein reguläres Einzel-Host-Zertifikat verwendet. Für `hkl.kardio.wiki` ist das
> funktional gleichwertig (gültiges Let's-Encrypt-HTTPS). Soll später wirklich auf
> Wildcard umgestellt werden, sind DNS-Provider-API-Credentials im Companion zu
> hinterlegen (`acme.sh`-DNS-Plugin).

### Schreibschutz (Lesen offen, Schreiben geschützt)

Damit der Plan öffentlich angezeigt, aber nicht von Fremden verändert werden
kann, ist im nginx-proxy eine Custom-Location hinterlegt
(`deploy/nginx/hkl.kardio.wiki_location` → `/etc/nginx/vhost.d/…`):
Schreibzugriffe sind aus dem **Klinik-Netz 149.249.0.0/16** frei und sonst nur
mit **HTTP Basic Auth** möglich. Reine Anzeige (GET) ist immer offen.

Basic-Auth-Benutzer anlegen/ändern (auf dem Server):

```bash
# htpasswd-Datei erzeugen (Paket apache2-utils) und in das vhost.d-Volume kopieren
htpasswd -cB hkl.kardio.wiki.htpasswd hkl
docker cp hkl.kardio.wiki.htpasswd nginx-proxy:/etc/nginx/vhost.d/
docker exec nginx-proxy nginx -s reload
```

---

## CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` prüft bei jedem Push die Backend-Syntax und
deployt bei Push auf `main` automatisch auf den Server (git pull + `docker
compose up -d --build`). Erforderliche **Repository-Secrets**:

| Secret         | Bedeutung                          |
|----------------|------------------------------------|
| `SSH_HOST`     | Server-IP/Host (151.80.56.152)     |
| `SSH_USER`     | SSH-Benutzer                       |
| `SSH_KEY`      | privater SSH-Key (Passwort-Login ist auf dem Server aus) |

> Secrets werden unter **Settings → Secrets and variables → Actions** gesetzt
> (`gh secret set SSH_HOST -R Bosock/HKL-plan` …). Dazu sind Admin-Rechte am
> Repository nötig.