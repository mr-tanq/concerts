// Remove exactly one archive record; shared by conflict-safe save retries.
export function removeArchiveRecord(archive, id, now = new Date().toISOString()) {
  if (!id || !Array.isArray(archive?.concerts)) throw new Error("Invalid archive record.");
  const matches = archive.concerts.filter(item => item.id === id);
  if (matches.length !== 1) throw new Error("This entry changed. Reload the archive and try again.");
  archive.concerts = archive.concerts.filter(item => item.id !== id);
  archive.meta = { ...archive.meta, totalConcerts: archive.concerts.length, lastUpdated: now };
}

export function mountArchiveRemoval(host, concert, { connected, connect, remove, saved }) {
  const section = document.createElement("section");
  section.className = "sheet-section archive-removal";
  section.innerHTML = `
    <button class="plain-act" data-start>Remove from archive</button>
    <div data-confirm hidden>
      <p class="footnote" data-question></p>
      <p class="footnote">This removes this entry and its notes from your attended shows.</p>
      <div class="act-row">
        <button class="plain-act" data-remove>Remove entry</button>
        <button class="plain-act" data-cancel>Cancel</button>
      </div>
    </div>
    <p class="status" role="status" aria-live="polite" hidden></p>`;
  host.append(section);
  const start = section.querySelector("[data-start]");
  const confirmation = section.querySelector("[data-confirm]");
  const submit = section.querySelector("[data-remove]");
  const cancel = section.querySelector("[data-cancel]");
  const status = section.querySelector(".status");
  section.querySelector("[data-question]").textContent =
    `Remove ${concert.festivalName || concert.artist} · ${concert.date} from the archive?`;
  start.addEventListener("click", () => {
    if (!connected()) { connect(); return; }
    start.hidden = true;
    confirmation.hidden = false;
    cancel.focus();
  });
  cancel.addEventListener("click", () => {
    confirmation.hidden = true;
    start.hidden = false;
    status.hidden = true;
    start.focus();
  });
  submit.addEventListener("click", async () => {
    if (submit.disabled) return;
    if (!connected()) { connect(); return; }
    submit.disabled = cancel.disabled = true;
    status.hidden = false;
    status.className = "status";
    status.textContent = "Removing…";
    try {
      const archive = await remove();
      saved(archive);
    } catch (error) {
      status.textContent = error.message || "Could not remove this entry. Try again.";
      status.className = "status bad";
    } finally {
      submit.disabled = cancel.disabled = false;
    }
  });
}
