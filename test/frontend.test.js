// Unit-Tests für die reinen Hilfsfunktionen der Web-App (index.html).
//
// Das Inline-<script> wird via test/load-frontend.js in einer node:vm-Sandbox
// ausgewertet (kein DOM/jsdom, keine Abhängigkeiten). Getestet werden die
// deterministischen, seiteneffektfreien Funktionen; DOM-rendernde bzw. auf den
// mutierten Laufzeit-`state` angewiesene Funktionen sind hier bewusst
// ausgeklammert (siehe README → Tests).
//
// Zeit-Helfer werden mit ISO-Strings OHNE "Z" geprüft, damit sie zeitzonen-
// unabhängig lokal interpretiert werden.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadFrontend } from "./load-frontend.js";

let s;
before(async () => { s = await loadFrontend(); });

// --- Datum/ISO -------------------------------------------------------------

test("iso formatiert ein Date als YYYY-MM-DD", () => {
  assert.equal(s.iso(new Date(2026, 6, 9)), "2026-07-09");
  assert.equal(s.iso(new Date(2026, 0, 5)), "2026-01-05");
});

test("parseIso ist die Umkehrung von iso", () => {
  for (const d of ["2026-07-09", "2026-01-01", "2024-12-31"]) {
    assert.equal(s.iso(s.parseIso(d)), d);
  }
});

test("addDays rechnet über Monatsgrenzen", () => {
  assert.equal(s.addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(s.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(s.addDays("2026-07-09", 0), "2026-07-09");
});

test("firstOfMonth liefert den Monatsersten", () => {
  assert.equal(s.firstOfMonth("2026-07-09"), "2026-07-01");
  assert.equal(s.firstOfMonth("2026-02-28"), "2026-02-01");
});

test("weekday passt zum getDay des Datums", () => {
  const WD = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
  assert.equal(s.weekday("2026-07-09"), WD[s.parseIso("2026-07-09").getDay()]);
  assert.equal(s.weekday("2026-07-09"), "Donnerstag");
});

test("displayDate ist menschenlesbar (deutsch)", () => {
  assert.equal(s.displayDate("2026-07-09"), "9. Juli 2026");
  assert.equal(s.displayDate("2026-01-01"), "1. Januar 2026");
});

test("isoToday liefert ein gültiges ISO-Datum", () => {
  assert.match(s.isoToday(), /^\d{4}-\d{2}-\d{2}$/);
});

// --- Uhrzeit / Dauer -------------------------------------------------------

test("hhmm formatiert lokale Uhrzeit aus ISO-String", () => {
  assert.equal(s.hhmm("2026-01-01T08:05:00"), "08:05");
  assert.equal(s.hhmm("2026-01-01T23:00:00"), "23:00");
});

test("fmtHM formatiert Stunden/Minuten aus Date", () => {
  assert.equal(s.fmtHM(new Date(2026, 0, 1, 9, 7)), "09:07");
  assert.equal(s.fmtHM(new Date(2026, 0, 1, 0, 0)), "00:00");
});

test("parseHM setzt Uhrzeit auf ein Datum", () => {
  const d = s.parseHM("2026-01-01", "09:30");
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 30);
});

test("hhmmFull formatiert Tag + Uhrzeit", () => {
  assert.equal(s.hhmmFull("2026-01-02T09:07:00"), "02.01. 09:07");
});

test("durMin berechnet Minutendifferenz", () => {
  assert.equal(s.durMin("2026-01-01T08:00:00Z", "2026-01-01T08:30:00Z"), 30);
  assert.equal(s.durMin("2026-01-01T08:00:00Z", "2026-01-01T08:00:00Z"), 0);
  assert.equal(s.durMin("2026-01-01T09:00:00Z", "2026-01-01T08:00:00Z"), -60);
});

test("inRange respektiert offene Grenzen", () => {
  assert.equal(s.inRange("2026-05-05", "2026-05-01", "2026-05-10"), true);
  assert.equal(s.inRange("2026-05-05", null, null), true);
  assert.equal(s.inRange("2026-04-30", "2026-05-01", null), false);
  assert.equal(s.inRange("2026-05-11", null, "2026-05-10"), false);
});

// --- Strings / Formatierung ------------------------------------------------

test("escapeHtml entschärft HTML-Sonderzeichen", () => {
  assert.equal(s.escapeHtml('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(s.escapeHtml(null), "");
  assert.equal(s.escapeHtml(undefined), "");
  assert.equal(s.escapeHtml("harmlos"), "harmlos");
});

test("anredeKurz kürzt Anreden", () => {
  assert.equal(s.anredeKurz("Herr"), "Hr.");
  assert.equal(s.anredeKurz("Frau"), "Fr.");
  assert.equal(s.anredeKurz("Divers"), "Dvs.");
  assert.equal(s.anredeKurz(""), "");
  assert.equal(s.anredeKurz("Unbekannt"), "");
});

test("untersucherText verbindet mehrere Untersucher", () => {
  assert.equal(s.untersucherText({ untersucher: ["A", "B"] }), "A · B");
  assert.equal(s.untersucherText({ untersucher: "X" }), "X");
  assert.equal(s.untersucherText({ untersucher: null }), "");
  assert.equal(s.untersucherText({}), "");
});

test("fullName kombiniert Nach- und Vorname", () => {
  assert.equal(s.fullName({ nachname: "Meyer", vorname: "Anna" }), "Meyer, Anna");
  assert.equal(s.fullName({ nachname: "Meyer" }), "Meyer");
  assert.equal(s.fullName({}), "");
});

test("roomName nutzt Sonderfall bw und Default-Label", () => {
  assert.equal(s.roomName("bw"), "Bettenwarte");
  assert.equal(s.roomName("1"), "HKL 1");
});

// --- Fall-Logik ------------------------------------------------------------

test("caseOpen unterscheidet offene von abgeschlossenen Fällen", () => {
  assert.equal(s.caseOpen({ done: false, status: "geplant" }), true);
  assert.equal(s.caseOpen({ done: true, status: "geplant" }), false);
  assert.equal(s.caseOpen({ done: false, status: "beendet" }), false);
  assert.equal(s.caseOpen({ done: false, status: "ruecktransport_erfolgt" }), false);
});

test("matchCase durchsucht relevante Felder (case-insensitive)", () => {
  const c = { nachname: "Meyer", vorname: "Anna", fallnummer: "4711", station: "C61", indikation: "Koro", untersucher: ["Dr. X"] };
  assert.equal(s.matchCase(c, "mey"), true);
  assert.equal(s.matchCase(c, "4711"), true);
  assert.equal(s.matchCase(c, "dr. x"), true);
  assert.equal(s.matchCase(c, "gibtsnicht"), false);
});

test("phaseOf ordnet Status einer Phase zu", () => {
  assert.equal(s.phaseOf({ status: "geplant" }), "prep");
  assert.equal(s.phaseOf({ status: "begonnen" }), "active");
  assert.equal(s.phaseOf({ status: "beendet" }), "done");
  assert.equal(s.phaseOf({ status: "unbekannt" }), "prep");
});

test("phaseColor/phaseLabel greifen auf Defaults zurück", () => {
  assert.match(s.phaseColor("prep"), /^#[0-9a-f]{6}$/i);
  assert.equal(s.phaseLabel("prep"), "Vorbereitung");
});

test("isCritical erkennt kritische Stationen und STEMI", () => {
  assert.equal(s.isCritical({ station: "C61" }), true);
  assert.equal(s.isCritical({ station: "c61" }), true, "normStation vereinheitlicht");
  assert.equal(s.isCritical({ indikation: "STEMI Verdacht" }), true);
  assert.equal(s.isCritical({ forceCritical: true }), true);
  assert.equal(s.isCritical({ station: "X99", indikation: "Koro" }), false);
});

// --- Farben / HTML-Builder / Utils -----------------------------------------

test("tint mischt Richtung dunkler Zielfarbe", () => {
  assert.match(s.tint("#ffffff"), /^rgb\(\d+,\d+,\d+\)$/);
  assert.equal(s.tint("#ffffff"), "rgb(54,70,76)");
  assert.equal(s.tint("#000000"), "rgb(18,34,40)");
});

test("awKpi/awBar erzeugen HTML mit den Werten", () => {
  const kpi = s.awKpi("Fälle", "42");
  assert.match(kpi, /42/);
  assert.match(kpi, /Fälle/);
  const bar = s.awBar("Dauer", 5, 10, "m");
  assert.match(bar, /50%/);
  assert.match(bar, /5m/);
});

test("dclone erzeugt eine tiefe Kopie", () => {
  const src = { a: 1, b: { c: [2, 3] } };
  const copy = s.dclone(src);
  // copy stammt aus der vm-Sandbox (fremdes Object.prototype) → für den
  // Strukturvergleich in den Host-Realm normalisieren.
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), src);
  assert.notEqual(copy, src);
  assert.notEqual(copy.b, src.b);
});

test("roomKey verbindet Datum und Raum", () => {
  assert.equal(s.roomKey("2026-07-09", "1"), "2026-07-09|1");
  assert.equal(s.roomKey("2026-07-09", "bw"), "2026-07-09|bw");
});

test("uid erzeugt eindeutige, präfixierte IDs", () => {
  const a = s.uid(), b = s.uid();
  assert.match(a, /^c[a-z0-9]+$/);
  assert.notEqual(a, b);
});

// --- Konfigurationsprüfung -------------------------------------------------

test("validateConfig meldet Fehler bei unvollständiger Konfiguration", () => {
  const bad = s.validateConfig({ statuses: [{ key: "", label: "" }], saele: [{ id: "1", name: "" }] });
  assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
});

test("validateConfig akzeptiert eine gültige Konfiguration", () => {
  const ok = s.validateConfig({
    statuses: [{ key: "a", label: "A", phase: "prep" }],
    saele: [{ id: "1", name: "Saal 1" }],
    roles: [{ key: "steril", label: "Steril" }],
  });
  assert.equal(ok.errors.length, 0);
});
