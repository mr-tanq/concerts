// sheet-gestures.js
//
// Bottom sheets (concert and artist sheets, Settings) close the way phone
// sheets do: drag down from the top of the sheet, or tap the dimmed
// backdrop. Closing always goes through the sheet's own Close / Done
// button, so its usual clean-up (and the Back-button history) still runs.

const PANELS = ".sheet-inner, .veil > .panel";
const CLOSE_AFTER_PX = 110;

function closeFor(panel) {
  const root = panel.closest(".sheet-root, .veil");
  const button = root?.querySelector(".sheet-close, #set-close");
  if (button) button.click();
}

export function initSheetGestures() {
  let drag = null;

  document.addEventListener("touchstart", (event) => {
    const panel = event.target.closest?.(PANELS);
    // Only from the top of the sheet: further down, a drag is a scroll.
    if (!panel || panel.scrollTop > 0 || event.touches.length !== 1) { drag = null; return; }
    drag = { panel, y0: event.touches[0].clientY, dy: 0 };
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!drag) return;
    const dy = event.touches[0].clientY - drag.y0;
    if (dy <= 0 || drag.panel.scrollTop > 0) {
      if (drag.dy) { drag.panel.style.transform = ""; drag.dy = 0; }
      return;
    }
    event.preventDefault();
    drag.dy = dy;
    drag.panel.style.transition = "none";
    drag.panel.style.transform = `translateY(${dy}px)`;
  }, { passive: false });

  const end = () => {
    if (!drag) return;
    const { panel, dy } = drag;
    drag = null;
    panel.style.transition = "";
    if (dy > CLOSE_AFTER_PX) {
      panel.style.transform = "translateY(100%)";
      setTimeout(() => closeFor(panel), 180);
    } else {
      panel.style.transform = "";
    }
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });

  // Tapping the dimmed area outside a concert/artist sheet closes it.
  document.addEventListener("click", (event) => {
    if (event.target.classList?.contains("sheet-root")) {
      const panel = event.target.querySelector(".sheet-inner");
      if (panel) closeFor(panel);
    }
  });
}
