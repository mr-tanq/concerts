#!/usr/bin/env node
// dismiss-concert.mjs
//
// Marks a recommendation as permanently not-interested. It's removed from
// data/recommendations.json and its id goes into recommendation-history.json
// so future discovery runs never resurrect it.
//
// Usage: node scripts/dismiss-concert.mjs <recommendation-id>

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const recId = process.argv[2];

if (!recId) {
  console.error("Usage: node scripts/dismiss-concert.mjs <recommendation-id>");
  process.exit(1);
}

const recsPath = path.join(ROOT, "data/recommendations.json");
const historyPath = path.join(ROOT, "data/recommendation-history.json");

const recs = JSON.parse(await readFile(recsPath, "utf8"));
const history = JSON.parse(await readFile(historyPath, "utf8"));

const idx = recs.concerts.findIndex((c) => c.id === recId);
if (idx === -1) {
  console.warn(`No recommendation found with id "${recId}" — it may already be gone. Adding to the exclude-list anyway.`);
} else {
  const r = recs.concerts[idx];
  recs.concerts.splice(idx, 1);
  recs.meta.lastUpdated = new Date().toISOString();
  console.log(`Dismissed "${r.artist}" @ ${r.venue} (${r.date}).`);
}

if (!history.dismissedIds.includes(recId)) history.dismissedIds.push(recId);

await writeFile(recsPath, JSON.stringify(recs, null, 2) + "\n");
await writeFile(historyPath, JSON.stringify(history, null, 2) + "\n");