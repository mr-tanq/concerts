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

export function scheduleMarkup(concert) {
  const s = concert.schedule?.date === concert.date ? concert.schedule : null;
  const row = (label, field, role = "") => {
    const known = /^([01]\d|2[0-3]):[0-5]\d$/.test(field?.time || "");
    return `<div class="schedule-row"><dt>${escapeHTML(label)}${role ? `<small>${role}</small>` : ""}</dt><dd>${known ? escapeHTML(field.time) + (field.dayOffset === 1 ? ' <small>+1 day</small>' : "") : "TBA"}${known && field.status === "expected" ? '<small>expected</small>' : ""}</dd></div>`;
  };
  const support = s?.support?.length ? s.support : (concert.supportingArtists || []).map(name => ({ name }));
  const rows = row("DOORS", s?.doors) + (support.length ? support.map(f => row(f.name || "SUPPORT", f, "SUPPORT")).join("") : row("SUPPORT", null)) + row(s?.main?.name || concert.artist || "MAIN ACT", s?.main, "MAIN ACT") + row("END", s?.end);
  const sources = [...new Map((s?.sources || []).filter(x => safeURL(x.url)).map(x => [x.url, x])).values()];
  let checked = "Not checked yet";
  if (Number.isFinite(Date.parse(s?.lastCheckedAt))) checked = `Checked ${new Intl.DateTimeFormat("en-GB", { timeZone: s.timeZone || "Europe/Amsterdam", day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" }).format(new Date(s.lastCheckedAt))} · venue time`;
  return `<section class="concert-schedule" aria-label="Concert schedule"><p class="whisper">Schedule</p><p class="schedule-live" hidden></p><dl>${rows}</dl><p class="schedule-check">${escapeHTML(checked)}${s?.lastAttemptAt && s.lastAttemptAt !== s.lastCheckedAt ? " · latest check unavailable" : ""}</p>${sources.length ? `<details class="schedule-sources"><summary>Sources</summary>${sources.map(x => `<a href="${escapeHTML(safeURL(x.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(x.label || new URL(x.url).hostname)}${x.kind === "official" ? " · official" : " · secondary"}</a>`).join("")}</details>` : ""}</section>`;
}

let mounted = null, timer = null;
function tick() {
  if (!mounted?.host.isConnected || document.hidden || !document.getElementById("panel-concerts")?.classList.contains("active")) return;
  const p = mounted.host.querySelector(".schedule-live"), text = scheduleCountdown(mounted.concert);
  if (p) { p.textContent = text; p.hidden = !text; }
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
