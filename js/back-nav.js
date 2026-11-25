// back-nav.js
//
// Makes the phone's Back button (and the browser's back) move through the
// app the way people expect:
//
//   1. an open overlay (concert sheet, artist sheet, settings, search,
//      share, a Realm country) closes first;
//   2. otherwise Back returns to the previous tab / Live view;
//   3. only from the first screen does Back leave the app.
//
// Every overlay that opens pushes one history entry. Closing it from the UI
// (Close, Done, tapping outside) quietly pops that entry again, so the
// history never fills up with stale steps.

const stack = [];          // open overlays, newest last: { token, close }
let quietPops = 0;         // history.back() calls of our own to ignore
let onNavigate = null;     // (state) => void, for tab / view entries

function popQuietly() {
  quietPops++;
  history.back();
}

/**
 * Register an overlay that just opened. `close` must close it (it is called
 * when Back is pressed). Returns `closed`, which the overlay calls when it
 * was closed some other way.
 */
export function overlayOpened(close) {
  const token = {};
  stack.push({ token, close });
  history.pushState({ lmOverlay: true }, "");
  return function closed() {
    const i = stack.findIndex((entry) => entry.token === token);
    if (i === -1) return;            // already closed by Back
    stack.splice(i, 1);
    popQuietly();
  };
}

/** Record a step between pages (tab or Live view) so Back can return to it. */
export function pageChanged(state) {
  history.pushState({ lmPage: state }, "");
}

/** The page the app opened on, so Back from a later page lands here. */
export function startPage(state, navigate) {
  onNavigate = navigate;
  history.replaceState({ lmPage: state }, "");
}

window.addEventListener("popstate", (event) => {
  if (quietPops > 0) { quietPops--; return; }
  const top = stack.pop();
  if (top) {
    try { top.close(); } catch (err) { console.error(err); }
    return;
  }
  const page = event.state?.lmPage;
  if (page && onNavigate) onNavigate(page);
});

// <dialog> overlays (concert search, share): any modal dialog gets a Back
// step automatically, and closing it any other way releases that step.
const nativeShowModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function showModal(...args) {
  const result = nativeShowModal.apply(this, args);
  const dialog = this;
  const closed = overlayOpened(() => { if (dialog.open) dialog.close(); });
  dialog.addEventListener("close", closed, { once: true });
  return result;
};

// The shared sheet root (concert sheet, artist sheet, settings and the
// "did you go?" prompts all render into it): non-empty means an overlay is
// open. Back presses its own Close / Done so its normal clean-up runs.
export function watchSheetRoot(root) {
  if (!root) return;
  let closed = null;     // release function while an overlay is open
  let pending = null;    // deferred release (content may be swapped, not closed)
  new MutationObserver(() => {
    const open = root.childElementCount > 0;
    if (open) {
      if (pending) { clearTimeout(pending); pending = null; }   // swapped, still open
      if (!closed) {
        closed = overlayOpened(() => {
          closed = null;
          const button = root.querySelector(".sheet-close, #set-close, [data-dismiss]");
          if (button) button.click();
          if (root.childElementCount) root.innerHTML = "";
        });
      }
    } else if (closed && !pending) {
      // Wait a moment: one sheet replacing another empties the root briefly.
      pending = setTimeout(() => {
        pending = null;
        if (root.childElementCount || !closed) return;
        const release = closed;
        closed = null;
        release();
      }, 120);
    }
  }).observe(root, { childList: true });
}
