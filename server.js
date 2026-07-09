// Backend-Server für den HKL-Plan.
//
// Zweck: Die Web-App (index.html) ist bislang rein client-seitig — Änderungen
// an den HKL-Einträgen (state = { cases, config, rooms, settings, notfallLog })
// liegen sonst nur im localStorage des jeweiligen Browsers. Dieser Server
//   1. liefert die statische App aus (Ersatz für `python3 -m http.server`) und
//   2. persistiert den kompletten App-Zustand serverseitig als JSON-Datei
//      (data/state.json), sodass Änderungen aus dem Webinterface geräte- und
//      browserübergreifend erhalten bleiben ("server-side state").
//
// Reine Node-Standardbibliothek, keine Abhängigkeiten:
//   node server.js
//
// Konfiguration per Umgebungsvariablen:
//   PORT      (Default 4180)
//   HOST      (Default 127.0.0.1 — nur lokal erreichbar)
//   DOCS_DIR  (Default ./web  — Verzeichnis mit index.html)
//   DATA_DIR  (Default ./data — persistenter Zustand + Backups)

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 4180;
const HOST = process.env.HOST || "127.0.0.1";
const DOCS_DIR = path.resolve(process.env.DOCS_DIR || path.join(__dirname, "web"));
// Reales (symlink-aufgelöstes) Wurzelverzeichnis — Basis für die
// Traversal-/Symlink-Prüfung beim Ausliefern statischer Dateien.
const DOCS_REAL = await fs.realpath(DOCS_DIR).catch(() => DOCS_DIR);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const STATE_FILE = path.join(DATA_DIR, "state.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 40;
const MAX_BODY = 32 * 1024 * 1024; // 32 MB Schutzgrenze

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

// --- Helfer -----------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Body zu groß"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// Schwacher ETag aus der Änderungszeit — genügt für optimistische Sperre und
// If-None-Match beim Poll.
function etagOf(stat) { return `"${Math.round(stat.mtimeMs)}"`; }

// Atomar schreiben: erst in eine eindeutige Temp-Datei, dann umbenennen.
// Der Name ist pro Prozess eindeutig (pid + monotone Sequenz), damit auch ohne
// Lock keine zwei Schreibvorgänge dieselbe Temp-Datei treffen.
let _tmpSeq = 0;
async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++_tmpSeq}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Mutex: serialisiert alle Mutationen von STATE_FILE (Backup + Schreiben/Löschen
// als eine kritische Sektion), damit gleichzeitige PUT/DELETE-Anfragen sich nicht
// überschneiden und die Datei nie in einem inkonsistenten Zustand landet.
let _stateChain = Promise.resolve();
function withStateLock(fn) {
  const run = _stateChain.then(fn, fn);
  _stateChain = run.then(() => {}, () => {}); // Kette bricht bei Fehlern nicht ab
  return run;
}

// Vor Überschreiben/Löschen eine Sicherung anlegen und alte Backups beschneiden.
async function backupState() {
  if (!(await exists(STATE_FILE))) return;
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.copyFile(STATE_FILE, path.join(BACKUP_DIR, `state-${ts}.json`));
  const entries = (await fs.readdir(BACKUP_DIR))
    .filter((n) => n.startsWith("state-") && n.endsWith(".json"))
    .sort();
  for (const stale of entries.slice(0, -MAX_BACKUPS)) {
    await fs.unlink(path.join(BACKUP_DIR, stale)).catch(() => {});
  }
}

// Plausibilitätsprüfung des App-Zustands: erwartet ein Objekt mit cases-Array
// (Struktur der Web-App: { cases:[], settings:{}, config:{}, rooms:{}, notfallLog:[] }).
function validState(v) {
  return v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.cases);
}

// --- API --------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  // Kompletter App-Zustand (server-side state)
  if (pathname === "/api/state") {
    if (req.method === "GET") {
      if (!(await exists(STATE_FILE))) {
        // Noch kein serverseitiger Zustand — Client seedet mit seinem lokalen.
        return res.writeHead(204, { "Cache-Control": "no-store" }).end();
      }
      const st = await fs.stat(STATE_FILE);
      const tag = etagOf(st);
      // Poll-Optimierung: unveränderter Zustand → 304 ohne Body.
      if (req.headers["if-none-match"] === tag) {
        return res.writeHead(304, { ETag: tag, "Cache-Control": "no-store" }).end();
      }
      const raw = await fs.readFile(STATE_FILE, "utf8");
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ETag: tag,
      });
      return res.end(raw);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const buf = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(buf.toString("utf8") || "null");
      } catch {
        return sendJson(res, 400, { ok: false, error: "Ungültiges JSON" });
      }
      if (!validState(parsed)) {
        return sendJson(res, 400, { ok: false, error: "Erwartet einen App-Zustand mit cases-Array" });
      }
      // Optimistische Sperre: If-Match gegen die aktuelle Datei prüfen (innerhalb
      // des Locks, gegen Lost-Update). Fehlt If-Match, wird ohne Prüfung
      // geschrieben (rückwärtskompatibel / Erstsync).
      let conflict = false, newEtag = null;
      await withStateLock(async () => {
        const ifMatch = req.headers["if-match"];
        if (ifMatch && ifMatch !== "*" && (await exists(STATE_FILE))) {
          const cur = etagOf(await fs.stat(STATE_FILE));
          if (ifMatch !== cur) { conflict = true; return; }
        }
        await backupState();
        await writeFileAtomic(STATE_FILE, JSON.stringify(parsed));
        newEtag = etagOf(await fs.stat(STATE_FILE));
      });
      if (conflict) {
        return sendJson(res, 409, { ok: false, error: "Konflikt: Der Zustand wurde zwischenzeitlich geändert. Bitte neu laden." });
      }
      return sendJson(res, 200, { ok: true, cases: parsed.cases.length, etag: newEtag });
    }
    if (req.method === "DELETE") {
      await withStateLock(async () => {
        if (await exists(STATE_FILE)) {
          await backupState();
          await fs.unlink(STATE_FILE);
        }
      });
      return res.writeHead(204).end();
    }
    res.writeHead(405, { Allow: "GET, PUT, DELETE" });
    return res.end();
  }

  // Health-Probe (vom Frontend zur Backend-Erkennung + Docker-Healthcheck genutzt)
  if (pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, name: "hkl-backend", time: new Date().toISOString() });
  }

  return sendJson(res, 404, { ok: false, error: "Unbekannter API-Endpunkt" });
}

// --- Statische Dateien ------------------------------------------------------

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Lexische Vorprüfung gegen Traversal.
  const filePath = path.join(DOCS_REAL, rel);
  if (filePath !== DOCS_REAL && !filePath.startsWith(DOCS_REAL + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  // Realen Pfad auflösen (folgt Symlinks) und erneut auf die Wurzel begrenzen —
  // verhindert Ausbruch über einen Symlink innerhalb von web/.
  let real, stat;
  try {
    real = await fs.realpath(filePath);
    stat = await fs.stat(real);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  if (real !== DOCS_REAL && !real.startsWith(DOCS_REAL + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (stat.isDirectory()) {
    return serveStatic(req, res, path.posix.join(rel, "index.html"));
  }
  const type = MIME[path.extname(real).toLowerCase()] || "application/octet-stream";
  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-cache" });
    return res.end();
  }
  // Erst lesen, dann Content-Length aus der tatsächlichen Bytelänge setzen
  // (kein Header/Body-Mismatch, falls die Datei zwischen stat und read wechselt).
  const data = await fs.readFile(real);
  res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-cache" });
  res.end(data);
}

// --- Server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname);
    } else {
      await serveStatic(req, res, pathname);
    }
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (!res.headersSent) sendJson(res, status, { ok: false, error: String(err && err.message || err) });
    else res.end();
    if (status >= 500) console.error(err);
  } finally {
    console.log(`${req.method} ${pathname} → ${res.statusCode}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`HKL-Backend läuft auf http://${HOST}:${PORT}`);
  console.log(`  Statisch:  ${DOCS_DIR}`);
  console.log(`  Daten:     ${STATE_FILE}`);
});
