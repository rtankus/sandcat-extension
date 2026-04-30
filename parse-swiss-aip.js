#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const PDF_DIR = process.argv[2] || "./swiss-pdfs";
const OUT_FILE = process.argv[3] || "./swiss-procedures.json";

/* ===============================
   UTIL
================================= */

function cleanText(s) {
  return String(s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim();
}

function normalizeFreq(freq) {
  const m = String(freq).match(/\d{3}\.\d+/);
  if (!m) return null;
  const [a, b = ""] = m[0].split(".");
  return `${a}.${b.padEnd(3, "0")}`;
}

/* ===============================
   HEADER
================================= */

function parseHeader(text, filename) {
  const fileIcao = filename.match(/LS_AD_2_([A-Z]{4})_/i)?.[1]?.toUpperCase();

  const textIcao =
    text.match(/AIP SWITZERLAND\s+([A-Z]{4})\s+AD\s+2/i)?.[1]?.toUpperCase();

  const icao = textIcao || fileIcao;

  if (!icao) {
    throw new Error("Could not determine ICAO from filename or PDF text");
  }

  const nameMatch = text.match(new RegExp(`${icao}\\s+-\\s+([^\\n]+)`, "i"));

  return {
    icao,
    name: cleanText(nameMatch?.[1] || "").toUpperCase()
  };
}

/* ===============================
   COMMS
================================= */

function parseComms(text) {
  const secMatch = text.match(/AD 2\.18 ATS COMMUNICATION FACILITIES([\s\S]*?)AD 2\.19/i);
  const sec = secMatch ? secMatch[1] : "";

  const comms = [];
  const re = /\b(TWR|GND|ATIS|APP|DEP|DEL|APRON|INFO)\s+([A-Za-zÀ-ÿ'’.\- ]+?)\s+(\d{3}\.\d{3}|\d{3}\.\d{2})\s*MHz/gi;

  let m;
  while ((m = re.exec(sec))) {
    comms.push({
      type: m[1].toUpperCase(),
      label: cleanText(m[2]),
      freq: normalizeFreq(m[3])
    });
  }

  return comms;
}

/* ===============================
   WAYPOINT PARSER
================================= */

const PATH_TERMS = ["IF", "TF", "DF", "CF", "CA", "HA", "HM", "HF", "RF"];

function isGoodFix(x) {
  return /^[A-Z]{2,5}\d{0,3}$/.test(x) &&
    ![
      "SID","STAR","RWY","AD","AIP","AMDT","CH","NIL","VIA",
      "FROM","TO","FOR","AND","THE","CAT","VIS","LGT","AVBL",
      "PROCEDURE","PROCEDURES","INFORMATION","SWITZERLAND"
    ].includes(x);
}

function parseTerminalFixes(text, icao) {
  const fixes = new Set();

  const compact = text.replace(/\s+/g, " ");

  const re = /\b([A-Z]{3,5}\d{0,3})\s+N\s+\d{2}\s+\d{2}\s+\d{2}(?:\.\d+)?\s+E\s+\d{3}\s+\d{2}\s+\d{2}(?:\.\d+)?/g;

  let m;
  while ((m = re.exec(compact))) {
    const fix = m[1].toUpperCase();

    if (fix !== icao && !["AIP", "AD", "RWY", "NIL"].includes(fix)) {
      fixes.add(fix);
    }
  }

  return fixes;
}

function extractWaypoints(block, validFixes) {
  const out = [];
  const seen = new Set();

  const text = block.replace(/\s+/g, " ");

  for (const fix of validFixes) {
    const idx = text.indexOf(fix);
    if (idx === -1) continue;

    const near = text.slice(Math.max(0, idx - 30), idx + 80);

    const alt =
      near.match(/[+-]FL\d{2,3}/)?.[0] ||
      near.match(/[+-]\d{4,5}/)?.[0] ||
      near.match(/\bFL\d{2,3}\b/)?.[0] ||
      null;

    if (seen.has(fix)) continue;
    seen.add(fix);

    out.push({
      ident: fix,
      ...(alt ? { altitude: alt } : {})
    });
  }

  return out;
}

/* ===============================
   SIDS
================================= */

function parseSids(text, validFixes) {
  const sids = [];

  const blocks = [...text.matchAll(/Visual\s+SID\s+([A-Z0-9 ]+\d[A-Z]?)\s*-\s*(RNAV|RNP)/g)];

  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].index;
    const end = blocks[i + 1]?.index || text.length;

    const block = text.slice(start, end);

    const name = cleanText(blocks[i][1]);
    const type = blocks[i][2];

    const runway =
      block.match(/RWY\s+(\d{2})/)?.[1] || null;

      const waypoints = extractWaypoints(block, validFixes);

    if (waypoints.length < 2) continue;

    if (!waypoints.length) continue;

    sids.push({ name, runway, type, waypoints });
  }

  return sids;
}

/* ===============================
   STARS
================================= */

function parseStars(text, validFixes) {
  const stars = [];

  const blocks = [...text.matchAll(/STAR\s+([A-Z0-9 ]+\d[A-Z]?)\s*-\s*(RNAV|RNP)/g)];

  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].index;
    const end = blocks[i + 1]?.index || text.length;

    const block = text.slice(start, end);

    const name = cleanText(blocks[i][1]);
    const waypoints = extractWaypoints(block, validFixes);
   if (waypoints.length < 2) continue;

    if (!waypoints.length) continue;

    stars.push({ name, waypoints });
  }

  return stars;
}

/* ===============================
   APPROACHES
================================= */

function parseApproaches(text, validFixes) {
  const apps = [];

  const blocks = [...text.matchAll(/(?:Procedure description of\s+)?(RNP\s+RWY\s+\d{2}[LRC]?)/g)];

  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].index;
    const end = blocks[i + 1]?.index || text.length;

    const block = text.slice(start, end);

    const name = cleanText(blocks[i][0]);
    const waypoints = extractWaypoints(block, validFixes);

    if (waypoints.length < 2) continue;

    if (!waypoints.length) continue;

    apps.push({ name, waypoints });
  }

  return apps;
}

/* ===============================
   MAIN
================================= */

async function parsePdf(file) {
  const data = await pdfParse(fs.readFileSync(file));
  const text = data.text;

const { icao, name } = parseHeader(text, path.basename(file));
const validFixes = parseTerminalFixes(text, icao);
console.log(icao, "valid fixes:", [...validFixes]);

return {
  icao,
  name,
  comms: parseComms(text),
  procedures: {
    sids: parseSids(text, validFixes),
    stars: parseStars(text, validFixes),
    approaches: parseApproaches(text, validFixes)
  }
};
}

async function main() {
  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith(".pdf"));

  const out = {};

  for (const f of files) {
    const full = path.join(PDF_DIR, f);
    console.log("Parsing", f);

    try {
      const data = await parsePdf(full);
      out[data.icao] = data;
} catch (e) {
  console.warn("Failed:", f, e.message);
}
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log("Saved:", OUT_FILE);
}

main();