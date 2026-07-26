#!/usr/bin/env node
// plan-concert.mjs
//
// The ONLY way a concert moves from "recommendation" into "planned" is this
// script — triggered explicitly by you via the "Plan concert" GitHub Action.
// Nothing in the discovery pipeline calls this automatically.
//
// Usage: node scripts/plan-concert.mjs <recommendation-id>

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const recId = process.argv[2];

if (!recId) {
  console.error("Usage: node scripts/plan-concert.mjs <recommendation-id>");
  process.exit(1);
}

const recsPath = path.join(ROOT, "data/recommendations.json");
const plannedPath = path.join(ROOT, "data/planned.json");
const historyPath = path.join(ROOT, "data/recommendation-history.json");

const recs = JSON.parse(await readFile(recsPath, "utf8"));
const planned = JSON.parse(await readFile(plannedPath, "utf8"));
const history = JSON.parse(await readFile(historyPath, "utf8"));

const idx = recs.concerts.findIndex((c) => c.id === recId);
if (idx === -1) {
  console.error(`No recommendation found with id "${recId}" (already planned/dismissed, or a stale id from an old run?)`);
  process.exit(1);
}

const r = recs.concerts[idx];

const plannedRecord = {
  id: `planned-${r.id.replace(/^rec-/, "")}`,
  artist: r.artist,
  supportingArtists: r.supportingArtists || [],
  date: r.date,
  time: r.time || null,
  venue: r.venue,
  city: r.city,
  country: r.country,
  isFestival: r.isFestival || false,
  image: r.image || null,
  ticketUrl: r.ticketUrl || null,
  sourceApis: r.sourceApis || [],
  recommendationId: r.id,
  planning: {
    plannedAt: new Date().toISOString(),
    originalScore: r.match?.score ?? null,
  },
};

const dup = planned.concerts.some(
  (c) => c.artist === plannedRecord.artist && c.date === plannedRecord.date && c.venue === plannedRecord.venue
);
if (dup) {
  console.error("This concert is already in planned.json — aborting to avoid a duplicate.");
  process.exit(1);
}

planned.concerts.push(plannedRecord);
planned.meta.lastUpdated = new Date().toISOString();

recs.concerts.splice(idx, 1);
recs.meta.lastUpdated = new Date().toISOString();

if (!history.plannedIds.includes(recId)) history.plannedIds.push(recId);

await writeFile(plannedPath, JSON.stringify(planned, null, 2) + "\n");
await writeFile(recsPath, JSON.stringify(recs, null, 2) + "\n");
await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");

console.log(`Planned "${r.artist}" @ ${r.venue} (${r.date}).`);