#!/usr/bin/env node
// import-to-archive.mjs
//
// Moves ONE planned concert into the permanent archive. Run locally with:
//   node scripts/import-to-archive.mjs <planned-id>
// or trigger the "Import concert to archive" GitHub Action with that id as input.
//
// Guarantees:
//   - creates exactly one archive record
//   - preserves all metadata from the planned entry
//   - removes the entry from planned.json (it's now history, not upcoming)
//   - updates archive meta.totalConcerts + lastUpdated
// Everything downstream (Overview/Signature/Milestones/Timeline) is derived
// from archive.json at render time, so nothing else needs to be "updated" —
// it just recomputes from the new dataset.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const plannedId = process.argv[2];

if (!plannedId) {
  console.error("Usage: node scripts/import-to-archive.mjs <planned-id>");
  process.exit(1);
}

const archivePath = path.join(ROOT, "data/archive.json");
const plannedPath = path.join(ROOT, "data/planned.json");

const archive = JSON.parse(await readFile(archivePath, "utf8"));
const planned = JSON.parse(await readFile(plannedPath, "utf8"));

const idx = planned.concerts.findIndex((c) => c.id === plannedId);
if (idx === -1) {
  console.error(`No planned concert found with id "${plannedId}"`);
  process.exit(1);
}

const p = planned.concerts[idx];

const archiveRecord = {
  id: `archived-${p.id}`,
  artist: p.artist,
  supportingArtists: p.supportingArtists || [],
  date: p.date,
  venue: p.venue,
  city: p.city,
  country: p.country,
  isFestival: p.isFestival || false,
  festivalName: p.festivalName || null,
  image: p.image || null,
  urls: p.ticketUrl ? [p.ticketUrl] : [],
  genreHints: p.genreHints || [],
  notes: null,
  source: "imported-from-planned",
  importedFromPlannedId: p.id,
  addedAt: new Date().toISOString(),
};

// Guard against accidental duplicates
const dup = archive.concerts.some(
  (c) => c.artist === archiveRecord.artist && c.date === archiveRecord.date && c.venue === archiveRecord.venue
);
if (dup) {
  console.error("This concert already exists in the archive — aborting to avoid a duplicate record.");
  process.exit(1);
}

archive.concerts.push(archiveRecord);
archive.meta.totalConcerts = archive.concerts.length;
archive.meta.lastUpdated = new Date().toISOString();

planned.concerts.splice(idx, 1);
planned.meta.lastUpdated = new Date().toISOString();

await writeFile(archivePath, JSON.stringify(archive, null, 2) + "\n");
await writeFile(plannedPath, JSON.stringify(planned, null, 2) + "\n");

console.log(`Imported "${p.artist}" @ ${p.venue} (${p.date}) into the archive.`);
console.log(`Archive now has ${archive.meta.totalConcerts} concerts.`);
