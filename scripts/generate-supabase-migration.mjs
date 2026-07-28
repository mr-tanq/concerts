#!/usr/bin/env node
// generate-supabase-migration.mjs
//
// Reads the existing JSON data files and emits supabase/migration.sql —
// a single script you paste into the Supabase SQL editor. Nothing is
// written to Supabase from here on purpose: generating the SQL means you
// can read exactly what will happen before it happens, and re-run the
// generator freely without side effects.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

async function loadJson(rel, fallback) {
  try {
    return JSON.parse(await readFile(path.join(ROOT, rel), "utf8"));
  } catch {
    return fallback;
  }
}

// --- SQL literal helpers -------------------------------------------------

function q(value) {
  if (value === null || value === undefined || value === "") return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}
function qDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "null";
  return `'${value}'::date`;
}
function qTime(value) {
  if (!value || !/^\d{1,2}:\d{2}/.test(value)) return "null";
  return `'${value}'::time`;
}
function qTs(value) {
  if (!value) return "null";
  const t = Date.parse(value);
  return Number.isNaN(t) ? "null" : `'${new Date(t).toISOString()}'::timestamptz`;
}
function qBool(v) {
  return v ? "true" : "false";
}
function qInt(v) {
  // Number(null) is 0, so a bare isFinite check silently turned every
  // absent rating into 0 — which the rating CHECK (1..5) then rejected,
  // failing the entire migration transaction.
  if (v === null || v === undefined || v === "") return "null";
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : "null";
}

// Must match normalizeArtistName() in the app and the crawler, or the same
// artist ends up as two rows.
function nameKey(name) {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Build ---------------------------------------------------------------

const archive = await loadJson("data/archive.json", { concerts: [] });
const planned = await loadJson("data/planned.json", { concerts: [] });
const history = await loadJson("data/recommendation-history.json", {});
const cache = await loadJson("data/podiuminfo-cache.json", { entries: {} });

// artist name -> best known image, so migrated rows keep their artwork
const imageByArtist = new Map();
for (const entry of Object.values(cache.entries || {})) {
  const headliner = Array.isArray(entry?.lineup) ? entry.lineup[0] : null;
  if (headliner && entry.image && !imageByArtist.has(nameKey(headliner))) {
    imageByArtist.set(nameKey(headliner), entry.image);
  }
}

const artists = new Map(); // nameKey -> display name
function noteArtist(name) {
  const k = nameKey(name);
  if (k && !artists.has(k)) artists.set(k, name);
  return k;
}

function lineupOf(c) {
  if (Array.isArray(c.lineup) && c.lineup.length) return c.lineup;
  return [c.artist, ...(c.supportingArtists || [])].filter(Boolean);
}

const rows = [];

function addConcert(c, status) {
  const lineup = lineupOf(c);
  lineup.forEach(noteArtist);
  const headliner = lineup[0] || c.artist;
  rows.push({
    source: c.source || (c.sourceId ? "podiuminfo" : "manual"),
    sourceId: c.sourceId ?? null,
    status,
    title: c.festivalName || (lineup.length > 1 ? lineup.join(" + ") : null),
    date: c.date,
    time: c.time || null,
    venue: c.venue,
    city: c.city,
    country: c.country && c.country !== "??" ? c.country : null,
    isFestival: !!c.isFestival,
    festivalName: c.festivalName || null,
    image: c.image || imageByArtist.get(nameKey(headliner)) || null,
    ticketUrl: c.ticketUrl || null,
    sourceUrl: c.sourceUrl || (Array.isArray(c.urls) ? c.urls[0] : null) || null,
    score: c.match?.score ?? c.planning?.originalScore ?? null,
    matchReason: c.match?.reason || null,
    rating: c.rating ?? null,
    notes: c.notes || null,
    discoveredAt: c.discoveredAt || c.addedAt || null,
    plannedAt: c.planning?.plannedAt || null,
    attendedAt: status === "attended" ? c.addedAt || null : null,
    lineup,
  });
}

for (const c of archive.concerts || []) addConcert(c, "attended");
for (const c of planned.concerts || []) addConcert(c, "planned");
for (const c of history.dismissed || []) addConcert(c, "dismissed");

// Exclusions: every decision the crawler must keep honouring. Legacy ids
// that predate source ids can't be expressed here, but those concerts are
// in the rows above as 'dismissed', which is what actually matters.
const exclusions = [];
for (const [reason, ids] of [
  ["dismissed", history.dismissedIds || []],
  ["planned", history.plannedIds || []],
  ["not_attended", history.notAttendedIds || []],
]) {
  for (const id of ids) {
    const m = String(id).match(/podiuminfo-(\d+)/);
    if (m) exclusions.push({ sourceId: m[1], reason });
  }
}

// --- Emit ----------------------------------------------------------------

const L = [];
L.push("-- Listening Mirror — one-time data migration");
L.push("-- Generated by scripts/generate-supabase-migration.mjs");
L.push(`-- Source data: ${archive.concerts?.length || 0} archived, ${planned.concerts?.length || 0} planned, ${(history.dismissed || []).length} dismissed`);
L.push("--");
L.push("-- 1. Run the schema first (already done).");
L.push("-- 2. Paste your Supabase user id below, then run this whole script.");
L.push("");
L.push("begin;");
L.push("");
L.push("create temporary table _ctx on commit drop as");
L.push("  select 'PASTE-YOUR-USER-UUID-HERE'::uuid as owner_id;");
L.push("");

L.push("-- ---------------------------------------------------------- artists");
for (const [key, display] of artists) {
  const img = imageByArtist.get(key) || null;
  L.push(
    `insert into artists (owner_id, name_key, display_name, image_url) ` +
    `select owner_id, ${q(key)}, ${q(display)}, ${q(img)} from _ctx ` +
    `on conflict (owner_id, name_key) do update set ` +
    `display_name = excluded.display_name, ` +
    `image_url = coalesce(artists.image_url, excluded.image_url);`
  );
}
L.push("");

L.push("-- --------------------------------------------------------- concerts");
for (const r of rows) {
  if (!r.date) continue;
  L.push("");
  L.push(`-- ${r.status}: ${r.lineup.join(" + ")} @ ${r.venue || "?"} ${r.date}`);
  L.push("with ins as (");
  L.push("  insert into concerts (");
  L.push("    owner_id, source, source_id, status, title, event_date, start_time,");
  L.push("    venue, city, country, is_festival, festival_name,");
  L.push("    image_url, ticket_url, source_url, score, match_reason,");
  L.push("    rating, notes, discovered_at, planned_at, attended_at");
  L.push("  )");
  L.push(
    `  select owner_id, ${q(r.source)}, ${q(r.sourceId)}, ${q(r.status)}::concert_status, ` +
    `${q(r.title)}, ${qDate(r.date)}, ${qTime(r.time)},`
  );
  L.push(`         ${q(r.venue)}, ${q(r.city)}, ${q(r.country)}, ${qBool(r.isFestival)}, ${q(r.festivalName)},`);
  L.push(`         ${q(r.image)}, ${q(r.ticketUrl)}, ${q(r.sourceUrl)}, ${qInt(r.score)}, ${q(r.matchReason)},`);
  L.push(`         ${qInt(r.rating)}, ${q(r.notes)}, ${qTs(r.discoveredAt)}, ${qTs(r.plannedAt)}, ${qTs(r.attendedAt)}`);
  L.push("  from _ctx");
  L.push("  on conflict do nothing");
  L.push("  returning id");
  L.push(")");
  const values = r.lineup
    .map((name, i) => `(${q(nameKey(name))}, ${q(i === 0 ? "headliner" : "support")}, ${i})`)
    .join(", ");
  L.push("insert into concert_artists (concert_id, artist_id, role, position)");
  L.push("select ins.id, a.id, v.role, v.position");
  L.push("from ins");
  L.push(`cross join (values ${values}) as v(name_key, role, position)`);
  L.push("join artists a on a.name_key = v.name_key and a.owner_id = (select owner_id from _ctx)");
  L.push("on conflict do nothing;");
}
L.push("");

L.push("-- ------------------------------------------------------- exclusions");
for (const e of exclusions) {
  L.push(
    `insert into discovery_exclusions (owner_id, source, source_id, reason) ` +
    `select owner_id, 'podiuminfo', ${q(e.sourceId)}, ${q(e.reason)} from _ctx ` +
    `on conflict do nothing;`
  );
}
L.push("");
L.push("commit;");
L.push("");
L.push("-- Sanity check after running:");
L.push("--   select status, count(*) from concerts group by status;");
L.push("--   select * from archive_overview;");
L.push("--   select * from archive_top_artists limit 10;");

await mkdir(path.join(ROOT, "supabase"), { recursive: true });
await writeFile(path.join(ROOT, "supabase/migration.sql"), L.join("\n") + "\n");

console.log("Wrote supabase/migration.sql");
console.log(`  ${rows.filter((r) => r.status === "attended").length} attended`);
console.log(`  ${rows.filter((r) => r.status === "planned").length} planned`);
console.log(`  ${rows.filter((r) => r.status === "dismissed").length} dismissed`);
console.log(`  ${artists.size} distinct artists`);
console.log(`  ${exclusions.length} crawler exclusions`);