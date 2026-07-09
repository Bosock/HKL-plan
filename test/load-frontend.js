// Lädt das Inline-<script> aus index.html in eine node:vm-Sandbox, damit die
// reinen Hilfsfunktionen der Web-App ohne Browser/DOM unit-getestet werden
// können. Reine Node-Standardbibliothek, keine Abhängigkeiten (kein jsdom).
//
// Funktionsweise:
//   * Der einzige Top-Level-Seiteneffekt des Scripts ist
//       document.addEventListener("DOMContentLoaded", () => Sync.boot(init));
//     Da DOMContentLoaded in der Sandbox nie feuert, laufen init()/boot() nicht
//     — es werden lediglich alle Funktionen und Konstanten definiert.
//   * Mit `function`-Deklarationen definierte Helfer landen als Eigenschaften am
//     Sandbox-Global und sind so von außen aufrufbar. Sie schließen lexikalisch
//     über ihre Konstanten (WD, MONTHS, STATUS_MAP, DEFAULT_PHASES, state …), die
//     dadurch weiter korrekt wirken, auch wenn `state.config` (wie im Startzustand)
//     null ist und die Funktionen auf ihre Defaults zurückfallen.

import vm from "node:vm";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, "..", "index.html");

// Universeller, verkettbarer DOM-Element-Stub: jeder Property-Zugriff liefert
// wieder etwas Aufrufbares/Verkettbares, Zuweisungen sind No-Ops. Reicht für
// den (minimalen) DOM-Kontakt beim Laden des Scripts.
function makeElement() {
  const store = { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } };
  const handler = {
    get(_t, prop) {
      if (prop in store) return store[prop];
      if (prop === "value" || prop === "textContent" || prop === "innerHTML") return "";
      if (prop === "children" || prop === "childNodes") return [];
      if (prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined;
      // Alles andere: aufrufbare Funktion, die wieder ein Element liefert.
      return (...args) => {
        if (prop === "querySelectorAll" || prop === "getElementsByClassName") return [];
        if (prop === "getAttribute") return null;
        return makeElement();
      };
    },
    set(_t, prop, val) { store[prop] = val; return true; },
  };
  return new Proxy(function () {}, handler);
}

function makeDocument() {
  return {
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
    createElementNS() { return makeElement(); },
    createTextNode() { return makeElement(); },
    documentElement: makeElement(),
    body: makeElement(),
    head: makeElement(),
  };
}

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

let cached = null;

export async function loadFrontend() {
  if (cached) return cached;
  const html = await fs.readFile(INDEX, "utf8");
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>", open);
  if (open === -1 || close === -1) throw new Error("<script>-Block in index.html nicht gefunden");
  const code = html.slice(open + "<script>".length, close);

  const sandbox = {
    document: makeDocument(),
    localStorage: makeLocalStorage(),
    sessionStorage: makeLocalStorage(),
    navigator: { userAgent: "node-test", clipboard: { writeText() { return Promise.resolve(); } } },
    location: { href: "http://localhost/", search: "", hash: "", reload() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    fetch: () => Promise.reject(new Error("fetch im Test deaktiviert")),
    alert() {}, confirm: () => false, prompt: () => null,
    console,
    URL,
    Blob: class { constructor() {} },
    FileReader: class { readAsText() {} },
    scrollTo() {},
  };
  vm.createContext(sandbox);
  // window/self auf das Sandbox-Global zeigen lassen, bevor das App-Script läuft.
  vm.runInContext("var window=this; var self=this; var globalThis=this;", sandbox);
  vm.runInContext(code, sandbox, { filename: "index.html:inline-script", timeout: 10000 });

  cached = sandbox;
  return sandbox;
}
