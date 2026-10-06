// Shared venue-local clock. No inferred performance times.
export function localDate(now = Date.now(), zone = "Europe/Amsterdam") {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  return ["year", "month", "day"].map(k => p.find(x => x.type === k).value).join("-");
}

export function validDate(date) {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date || "") && Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

export function venueInstant(date, time, zone = "Europe/Amsterdam", dayOffset = 0) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "") || ![0, 1].includes(dayOffset)) return null;
  const [y, m, d] = date.split("-").map(Number), [h, min] = time.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d + dayOffset, h, min);
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const matches = [];
  // Reject ambiguous/nonexistent DST wall times rather than choosing an offset.
  for (let offset = -14; offset <= 14; offset++) {
    const instant = target - offset * 3600000;
    const p = Object.fromEntries(fmt.formatToParts(instant).map(x => [x.type, x.value]));
    if (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) === target) matches.push(instant);
  }
  return matches.length === 1 ? new Date(matches[0]).toISOString() : null;
}

export function scheduleCountdown(concert, now = Date.now()) {
  const s = concert.schedule;
  if (!s || s.date !== concert.date) return "";
  const zone = s.timeZone || "Europe/Amsterdam";
  const fields = [s.doors, ...(s.support || []), s.main].filter(Boolean);
  const instant = field => {
    // Recompute from wall time; do not trust stale or malformed cached timestamps.
    try { return Date.parse(venueInstant(concert.date, field.time, zone, field.dayOffset || 0)); } catch { return NaN; }
  };
  const end = instant(s.end || {}), main = instant(s.main || {});
  if (Number.isFinite(end) && now >= end) return "SHOW ENDED";
  if (localDate(now, zone) !== concert.date && !(Number.isFinite(end) && now < end && now >= main)) return "";
  const name = (s.main?.name || concert.artist || "MAIN ACT").toUpperCase();
  // Unknown end: a start is known, but we cannot claim it is still live.
  if (Number.isFinite(main) && now >= main) return Number.isFinite(end) ? `${name} · LIVE NOW` : `${name} · START TIME PASSED`;
  const next = fields.map(f => ({ f, at: instant(f) })).filter(x => Number.isFinite(x.at) && x.at > now).sort((a,b) => a.at - b.at)[0];
  if (!next) return "TIMES TBA";
  const minutes = Math.ceil((next.at - now) / 60000), hours = Math.floor(minutes / 60);
  const label = next.f === s.doors ? "DOORS" : next.f === s.main ? name : (next.f.name || "SUPPORT").toUpperCase();
  return `${label} IN ${hours ? `${hours}H ` : ""}${String(minutes % 60).padStart(hours ? 2 : 1, "0")}M`;
}

const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeURL = value => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; } catch { return null; } };

function artistLabel(name) {
  const value = String(name || "");
  // Soften venue timetable capitals; preserve short acronyms and mixed-case names.
  if (!/^[\p{L}\s'-]+$/u.test(value) || /\p{Ll}/u.test(value) || !/\p{L}{5}/u.test(value)) return value;
  return value.toLocaleLowerCase().replace(/(^|[\s-])\p{L}/gu, letter => letter.toLocaleUpperCase());
}

export function scheduleMarkup(concert) {
  const s = concert.schedule?.date === concert.date ? concert.schedule : null;
  const row = (label, field, role = "", kind = "") => {
    const known = /^([01]\d|2[0-3]):[0-5]\d$/.test(field?.time || "");
    let at = null;
    try { if (known) at = venueInstant(concert.date, field.time, s?.timeZone || "Europe/Amsterdam", field.dayOffset || 0); } catch {}
    return `<div class="schedule-row schedule-row--${kind}" data-schedule-kind="${kind}"${at ? ` data-schedule-at="${escapeHTML(at)}"` : ""}><dt>${escapeHTML(role ? artistLabel(label) : label)}${role ? `<small>${role}</small>` : ""}</dt><dd${known ? "" : ' class="schedule-tba"'}>${known ? escapeHTML(field.time) + (field.dayOffset === 1 ? ' <small>+1 day</small>' : "") : "TBA"}${known && field.status === "expected" ? '<small>expected</small>' : ""}</dd></div>`;
  };
  const support = s?.support?.length ? s.support : (concert.supportingArtists || []).map(name => ({ name }));
  const rows = row("DOORS", s?.doors, "", "doors") + (support.length ? support.map(f => row(f.name || "SUPPORT", f, "SUPPORT", "support")).join("") : row("SUPPORT", null, "", "support")) + row(concert.artist || s?.main?.name || "MAIN ACT", s?.main, "MAIN ACT", "main") + row("END", s?.end, "", "end");
  const sources = [...new Map((s?.sources || []).filter(x => safeURL(x.url)).map(x => [x.url, x])).values()];
  let checked = "Not checked yet";
  if (Number.isFinite(Date.parse(s?.lastCheckedAt))) checked = `Checked ${new Intl.DateTimeFormat("en-GB", { timeZone: s.timeZone || "Europe/Amsterdam", day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" }).format(new Date(s.lastCheckedAt))}`;
  const unavailable = s?.lastAttemptAt && s.lastAttemptAt !== s.lastCheckedAt ? '<p class="schedule-check">Latest check unavailable</p>' : "";
  const footer = sources.length ? `<details class="schedule-sources"><summary><span class="schedule-check">${escapeHTML(checked)}</span><span class="schedule-source-toggle">Sources <span aria-hidden="true">⌄</span></span></summary><div class="schedule-source-list"><p class="schedule-check">All times are local to the venue (${escapeHTML(s?.timeZone || "Europe/Amsterdam")}).</p>${sources.map(x => `<a href="${escapeHTML(safeURL(x.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(x.label || new URL(x.url).hostname)}${x.kind === "official" ? " · official" : " · secondary"}</a>`).join("")}</div></details>` : `<p class="schedule-check schedule-unchecked">${escapeHTML(checked)} · venue time</p>`;
  return `<section class="concert-schedule" aria-label="Concert schedule"><p class="whisper">Schedule</p><p class="schedule-live" role="timer" aria-live="off" hidden></p><dl>${rows}</dl>${footer}${unavailable}</section>`;
}

let mounted = null, timer = null;
function tick() {
  if (!mounted?.host.isConnected || document.hidden || !document.getElementById("panel-concerts")?.classList.contains("active")) return;
  const now = Date.now(), p = mounted.host.querySelector(".schedule-live"), text = scheduleCountdown(mounted.concert, now);
  if (p) { p.textContent = text; p.hidden = !text; }
  const rows = [...(mounted.host.querySelectorAll?.(".schedule-row") || [])];
  const main = rows.find(row => row.dataset.scheduleKind === "main");
  const end = rows.find(row => row.dataset.scheduleKind === "end");
  const at = row => Date.parse(row?.dataset.scheduleAt);
  const live = Number.isFinite(at(end)) && now >= at(main) && now < at(end);
  const current = text ? (live ? main : rows.filter(row => row !== end && at(row) > now).sort((a, b) => at(a) - at(b))[0]) : null;
  for (const row of rows) {
    if (row === current) row.setAttribute("aria-current", "step");
    else row.removeAttribute("aria-current");
  }
}
export function syncScheduleClock() {
  clearInterval(timer); timer = null;
  if (!mounted?.host.isConnected || document.hidden || !document.getElementById("panel-concerts")?.classList.contains("active")) return;
  tick(); timer = setInterval(tick, 15000);
}
export function clearScheduleClock() { clearInterval(timer); timer = null; mounted = null; }
export function mountSchedule(host, concert) {
  clearScheduleClock(); host.innerHTML = scheduleMarkup(concert); mounted = { host, concert }; syncScheduleClock();
}
