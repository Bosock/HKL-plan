// Integrationstests für server.js (Backend / server-side state).
//
// Reine Node-Standardbibliothek (node:test, node:assert), keine Abhängigkeiten
// — passend zur Projekt-Philosophie ("keine Abhängigkeiten"). Getestet wird der
// echte Server als Kindprozess gegen temporäre DOCS_DIR/DATA_DIR-Verzeichnisse,
// wodurch alle Funktionen von server.js (sendJson, readBody, exists, etagOf,
// writeFileAtomic, withStateLock, backupState, validState, handleApi,
// serveStatic sowie der Request-Handler) über HTTP abgedeckt werden.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "server.js");

let child, base, docsDir, dataDir;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitFor(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (async function poll() {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch { /* Server noch nicht bereit */ }
      if (Date.now() - start > timeoutMs) return reject(new Error("Server-Timeout"));
      setTimeout(poll, 60);
    })();
  });
}

before(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hkl-test-"));
  docsDir = path.join(root, "web");
  dataDir = path.join(root, "data");
  await fs.mkdir(docsDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  // Statische Testdateien
  await fs.writeFile(path.join(docsDir, "index.html"), "<!doctype html><h1>HKL</h1>");
  await fs.writeFile(path.join(docsDir, "app.js"), "console.log('hi');");
  await fs.mkdir(path.join(docsDir, "sub"), { recursive: true });
  await fs.writeFile(path.join(docsDir, "sub", "index.html"), "<h2>sub</h2>");
  // Datei AUSSERHALB der DOCS_DIR — darf per Traversal nie ausgeliefert werden.
  await fs.writeFile(path.join(root, "secret.txt"), "TOPSECRET");

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DOCS_DIR: docsDir, DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(`${base}/api/health`);
});

after(() => {
  if (child && !child.killed) child.kill("SIGKILL");
});

// --- API: /api/health ------------------------------------------------------

test("GET /api/health liefert ok + Backend-Name", async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.name, "hkl-backend");
  assert.ok(typeof j.time === "string" && !Number.isNaN(Date.parse(j.time)));
});

// --- API: /api/state Lebenszyklus ------------------------------------------

test("GET /api/state ohne Zustand → 204", async () => {
  const r = await fetch(`${base}/api/state`);
  assert.equal(r.status, 204);
});

test("PUT /api/state mit ungültigem JSON → 400", async () => {
  const r = await fetch(`${base}/api/state`, { method: "PUT", body: "{kaputt" });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /JSON/);
});

test("PUT /api/state ohne cases-Array → 400 (validState)", async () => {
  for (const body of [JSON.stringify({ foo: 1 }), JSON.stringify([1, 2]), "null"]) {
    const r = await fetch(`${base}/api/state`, { method: "PUT", body });
    assert.equal(r.status, 400, `body=${body}`);
    const j = await r.json();
    assert.equal(j.ok, false);
  }
});

test("PUT /api/state mit gültigem Zustand → 200 + etag, dann GET round-trip", async () => {
  const state = { cases: [{ id: "c1", nachname: "Meyer" }], config: {}, rooms: {}, settings: {}, notfallLog: [] };
  const put = await fetch(`${base}/api/state`, { method: "PUT", body: JSON.stringify(state) });
  assert.equal(put.status, 200);
  const pj = await put.json();
  assert.equal(pj.ok, true);
  assert.equal(pj.cases, 1);
  assert.ok(pj.etag, "etag vorhanden");

  const get = await fetch(`${base}/api/state`);
  assert.equal(get.status, 200);
  assert.ok(get.headers.get("etag"), "ETag-Header gesetzt");
  const back = await get.json();
  assert.deepEqual(back, state, "gespeicherter Zustand exakt zurückgeliefert");
});

test("GET /api/state mit passendem If-None-Match → 304", async () => {
  const g1 = await fetch(`${base}/api/state`);
  const tag = g1.headers.get("etag");
  await g1.arrayBuffer();
  const g2 = await fetch(`${base}/api/state`, { headers: { "If-None-Match": tag } });
  assert.equal(g2.status, 304);
});

test("PUT mit falschem If-Match → 409 Konflikt", async () => {
  const state = { cases: [{ id: "x" }] };
  const r = await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "If-Match": '"0"' },
    body: JSON.stringify(state),
  });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /Konflikt/);
});

test("PUT mit korrektem If-Match → 200", async () => {
  const g = await fetch(`${base}/api/state`);
  const tag = g.headers.get("etag");
  await g.arrayBuffer();
  const state = { cases: [{ id: "y" }, { id: "z" }] };
  const r = await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "If-Match": tag },
    body: JSON.stringify(state),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.cases, 2);
});

test("POST /api/state wird wie PUT behandelt", async () => {
  const state = { cases: [] };
  const r = await fetch(`${base}/api/state`, { method: "POST", body: JSON.stringify(state) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.cases, 0);
});

test("PATCH /api/state → 405 mit Allow-Header", async () => {
  const r = await fetch(`${base}/api/state`, { method: "PATCH", body: "{}" });
  assert.equal(r.status, 405);
  assert.match(r.headers.get("allow") || "", /PUT/);
});

test("Backups werden vor Überschreiben angelegt", async () => {
  // Nach mehreren PUTs muss mindestens ein Backup existieren.
  for (let i = 0; i < 3; i++) {
    await fetch(`${base}/api/state`, { method: "PUT", body: JSON.stringify({ cases: [{ n: i }] }) });
  }
  const backups = await fs.readdir(path.join(dataDir, "backups"));
  const stateBackups = backups.filter((n) => n.startsWith("state-") && n.endsWith(".json"));
  assert.ok(stateBackups.length >= 1, `erwartet ≥1 Backup, gefunden ${stateBackups.length}`);
});

test("Gleichzeitige PUTs bleiben durch den Lock konsistent", async () => {
  const puts = Array.from({ length: 8 }, (_, i) =>
    fetch(`${base}/api/state`, { method: "PUT", body: JSON.stringify({ cases: Array(i + 1).fill({ x: i }) }) }),
  );
  const results = await Promise.all(puts);
  for (const r of results) assert.equal(r.status, 200);
  // Endzustand muss valides, vollständig lesbares JSON sein (kein Torso).
  const g = await fetch(`${base}/api/state`);
  const j = await g.json();
  assert.ok(Array.isArray(j.cases));
});

test("DELETE /api/state → 204, danach GET → 204", async () => {
  const del = await fetch(`${base}/api/state`, { method: "DELETE" });
  assert.equal(del.status, 204);
  const get = await fetch(`${base}/api/state`);
  assert.equal(get.status, 204);
});

test("Unbekannter API-Endpunkt → 404", async () => {
  const r = await fetch(`${base}/api/gibtsnicht`);
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.equal(j.ok, false);
});

// --- Statische Auslieferung ------------------------------------------------

test("GET / liefert index.html", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/html/);
  const body = await r.text();
  assert.match(body, /HKL/);
});

test("GET /app.js mit korrektem MIME-Type", async () => {
  const r = await fetch(`${base}/app.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /javascript/);
});

test("Verzeichnis wird auf index.html aufgelöst", async () => {
  const r = await fetch(`${base}/sub`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /sub/);
});

test("HEAD / → 200 mit Content-Length, ohne Body", async () => {
  const r = await fetch(`${base}/`, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.ok(Number(r.headers.get("content-length")) > 0);
  const body = await r.text();
  assert.equal(body, "");
});

test("Fehlende Datei → 404", async () => {
  const r = await fetch(`${base}/gibtsnicht.txt`);
  assert.equal(r.status, 404);
});

test("Path-Traversal liefert keine Datei außerhalb der DOCS_DIR", async () => {
  // Der Server begrenzt die Auslieferung auf die Wurzel (WHATWG-URL-
  // Normalisierung + lexische Prüfung + realpath-Prüfung). Keine dieser
  // Traversal-Varianten darf die Datei außerhalb von web/ preisgeben.
  const attempts = [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/sub/../../secret.txt",
  ];
  for (const p of attempts) {
    const r = await fetch(`${base}${p}`);
    assert.notEqual(r.status, 200, `Traversal ${p} darf nicht 200 sein`);
    const body = await r.text();
    assert.ok(!body.includes("TOPSECRET"), `Traversal ${p} leakt secret.txt`);
  }
});

test("Nicht erlaubte Methode auf statischer Route → 405", async () => {
  const r = await fetch(`${base}/`, { method: "PUT", body: "x" });
  assert.equal(r.status, 405);
  assert.match(r.headers.get("allow") || "", /GET/);
});
