#!/usr/bin/env node
// import-legacy-archive.mjs
//
// Recovers the concert archive from the old Cloudflare Worker bundle
// (data/legacy-worker-bundle.js) and rewrites data/archive.json in the
// current schema.
//
// The bundle is a compiled Worker, so the archive lives inside it as a
// `var seed_default = [ ... ];` array literal. Rather than eval the file —
// which would run arbitrary code from a build artefact — we slice out just
// that array by bracket matching and parse it as JSON after unescaping the
// \xNN sequences the bundler introduced (Sólstafir became S\xF3lstafir).
//
// Two things from the old schema are deliberately preserved because the
// stats depend on them:
//   - venueFamily: De Helling and Pandora are rooms inside
//     TivoliVredenburg. Without this the venue counts fragment and
//     TivoliVredenburg stops being the recurring room it actually is.
//   - the full festival lineup: Graspop alone carries 39 artists, and
//     they're only counted if support/festival acts are kept.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BUNDLE = path.join(ROOT, "data/legacy-worker-bundle.js");
const OUT = path.join(ROOT, "data/archive.json");

// Concerts attended after the old seed was frozen. Added here rather than
// hand-edited into archive.json so re-running this import stays idempotent.
const LATE_ADDITIONS = [
  {
    date: "2026-04-24",
    title: "Iotunn",
    venue: "De Helling",
    venueFamily: "TivoliVredenburg",
    city: "Utrecht",
    country: "Netherlands",
    isFestival: false,
    artists: [{ name: "Iotunn", role: "headliner" }],
  },
  {
    date: "2026-06-18",
    title: "Sólstafir + Oranssi Pazuzu + Hulder",
    venue: "Patronaat",
    venueFamily: "Patronaat",
    city: "Haarlem",
    country: "Netherlands",
    isFestival: false,
    artists: [
      { name: "Sólstafir", role: "headliner" },
      { name: "Oranssi Pazuzu", role: "support" },
      { name: "Hulder", role: "support" },
    ],
  },
];

function extractSeedArray(source) {
  const marker = "var seed_default = ";
  const start = source.indexOf(marker);
  if (start === -1) throw new Error("Could not find 'var seed_default =' in the bundle");

  const open = source.indexOf("[", start);
  if (open === -1) throw new Error("Could not find the opening bracket of the seed array");

  // Bracket-match so a ']' inside a string can't end the slice early.
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = open; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) inString = false;
      continue;
    }

    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("Unbalanced brackets while extracting the seed array");
}

// The bundler emitted non-ASCII as \xNN / \uNNNN escapes. JSON.parse
// understands \uNNNN but not \xNN, so convert the latter first.
function unescapeBundlerHex(text) {
  return text.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
    JSON.stringify(String.fromCharCode(parseInt(hex, 16))).slice(1, -1)
  );
}

function normalizeSpace(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function sortArtists(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const ao = Number(a?.sort_order ?? 9999);
    const bo = Number(b?.sort_order ?? 9999);
    if (ao !== bo) return ao - bo;
    return normalizeSpace(a?.name).localeCompare(normalizeSpace(b?.name));
  });
}

function toArchiveConcert(entry) {
  const artists = sortArtists(entry?.artists).map((a) => ({
    name: normalizeSpace(a?.name),
    role: normalizeSpace(a?.role) || "support",
  })).filter((a) => a.name);

  const isFestival =
    normalizeSpace(entry?.kind).toLowerCase() === "festival" || !!normalizeSpace(entry?.festival_name);

  // For a festival the "headliner" is the festival itself, so the first
  // billed act shouldn't be promoted into the artist slot.
  const headliner = artists.find((a) => a.role === "headliner") || artists[0] || null;
  const mainArtist = isFestival
    ? normalizeSpace(entry?.festival_name || entry?.title)
    : (headliner?.name || normalizeSpace(entry?.title));

  const supporting = artists
    .map((a) => a.name)
    .filter((n) => n.toLowerCase() !== String(mainArtist).toLowerCase());

  const venueRaw = normalizeSpace(entry?.venue?.raw_name || entry?.venue?.family_name);
  const venueFamily = normalizeSpace(entry?.venue?.family_name || entry?.venue?.raw_name);
  const date = normalizeSpace(entry?.start_date);

  return {
    id: `archived-${normalizeSpace(entry?.event_key) || date}`,
    artist: mainArtist,
    supportingArtists: supporting,
    lineup: artists.map((a) => a.name),
    date,
    endDate: normalizeSpace(entry?.end_date || entry?.start_date) || date,
    venue: venueRaw,
    venueFamily,
    city: normalizeSpace(entry?.city),
    country: normalizeSpace(entry?.country) || null,
    isFestival,
    festivalName: normalizeSpace(entry?.festival_name) || null,
    image: null,
    urls: [],
    genreHints: [],
    notes: null,
    rating: null,
    source: "legacy-worker",
    sourceId: null,
    legacyEventKey: normalizeSpace(entry?.event_key) || null,
    importedFromPlannedId: null,
    addedAt: new Date().toISOString(),
  };
}

function lateAdditionToConcert(x) {
  const artists = x.artists.map((a) => ({ name: a.name, role: a.role }));
  return {
    id: `archived-${x.date}-${x.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`,
    artist: artists.find((a) => a.role === "headliner")?.name || x.title,
    supportingArtists: artists.filter((a) => a.role !== "headliner").map((a) => a.name),
    lineup: artists.map((a) => a.name),
    date: x.date,
    endDate: x.date,
    venue: x.venue,
    venueFamily: x.venueFamily,
    city: x.city,
    country: x.country,
    isFestival: x.isFestival,
    festivalName: null,
    image: null,
    urls: [],
    genreHints: [],
    notes: null,
    rating: null,
    source: "manual",
    sourceId: null,
    legacyEventKey: null,
    importedFromPlannedId: null,
    addedAt: new Date().toISOString(),
  };
}

// --- run ---

const bundle = await readFile(BUNDLE, "utf8");
const rawArray = extractSeedArray(bundle);
const seed = JSON.parse(unescapeBundlerHex(rawArray));

if (!Array.isArray(seed) || seed.length === 0) {
  throw new Error("Seed array parsed but is empty — refusing to overwrite archive.json");
}

const concerts = seed.map(toArchiveConcert).filter((c) => c.date);
for (const late of LATE_ADDITIONS) concerts.push(lateAdditionToConcert(late));

// Dedupe on date + venue + artist, in case a late addition already existed.
const seen = new Set();
const deduped = [];
for (const c of concerts) {
  const key = `${c.date}|${c.venue.toLowerCase()}|${c.artist.toLowerCase()}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(c);
}

deduped.sort((a, b) => a.date.localeCompare(b.date));

const output = {
  $schema: "Listening Mirror Archive Schema v2",
  meta: {
    lastUpdated: new Date().toISOString(),
    totalConcerts: deduped.length,
    recoveredFrom: "legacy Cloudflare Worker seed",
  },
  concerts: deduped,
};

await writeFile(OUT, JSON.stringify(output, null, 2) + "\n");

// Report enough to verify the recovery landed correctly.
const artistCounts = new Map();
const venueCounts = new Map();
const cityCounts = new Map();
for (const c of deduped) {
  for (const name of c.lineup) artistCounts.set(name, (artistCounts.get(name) || 0) + 1);
  const v = c.venueFamily || c.venue;
  if (v) venueCounts.set(v, (venueCounts.get(v) || 0) + 1);
  if (c.city) cityCounts.set(c.city, (cityCounts.get(c.city) || 0) + 1);
}
const top = (m, n = 5) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(", ");

console.log(`Recovered ${deduped.length} concerts from the legacy bundle.`);
console.log(`  festivals: ${deduped.filter((c) => c.isFestival).length}`);
console.log(`  venues (by family): ${venueCounts.size}`);
console.log(`  cities: ${cityCounts.size}`);
console.log(`  first: ${deduped[0]?.date} ${deduped[0]?.artist}`);
console.log(`  latest: ${deduped.at(-1)?.date} ${deduped.at(-1)?.artist}`);
console.log(`  most seen artists: ${top(artistCounts)}`);
console.log(`  recurring rooms: ${top(venueCounts)}`);
console.log(`  top cities: ${top(cityCounts)}`);