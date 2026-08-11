// The SCP tab: a two-pane file manager between the TV and the session's host.
//
// DRIVEN BY A REMOTE, not a mouse. That is the constraint that shapes every
// decision here: there is no hover, no right-click, no drag, no scrollbar to
// grab, and the pointer (when the Magic Remote is even out) jitters enough that
// small targets are a lottery. So the whole thing is a focus ring the D-pad
// moves through, every action has a key, and the buttons exist for discovery
// rather than as the primary path.
//
// Two panes side by side rather than one switchable list, because the direction
// of a copy is the question the user is actually asking, and a layout where the
// destination is off screen makes that question unanswerable. Left is always
// the TV, right is always the host — fixed, so "▶" means the same thing every
// time rather than depending on a mode.
//
// Everything the service exposes is per-path and non-recursive (see
// service/lib/sftp.js): no recursive delete, no directory upload. That is not a
// gap to be filled in later — a recursive remote delete driven from a D-pad is
// the one operation in this app that can destroy something irreplaceable with a
// single confirm.
import { serviceCall, subscribeSession } from "./service-client.js";
import { debugEvent } from "./debug.js";

// serviceCall REJECTS on a `returnValue:false` body rather than resolving with
// it, and what it rejects with is the response object — no `.message`, so the
// usual `e.message || e` renders as "[object Object]". Every failure in this
// module goes through here so an error the user sees is the one the service
// actually reported. (The same shape once shipped as a silent bug in keys.js:
// on this bridge a false body arrives through the SUCCESS callback.)
function errorTextOf(e) {
  if (!e) return "failed";
  if (e.errorText) return String(e.errorText);
  if (e.errorCode) return String(e.errorCode);
  if (e.message) return String(e.message);
  return String(e);
}

function errorCodeOf(e) {
  return (e && (e.errorCode || e.code)) || null;
}

const SIDE_TV = "tv";
const SIDE_HOST = "host";

function formatSize(bytes, type) {
  if (type === "dir") return "";
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} G`;
}

// Parent of a POSIX-ish path, for the ".." entry. Both sides speak the same
// dialect here — the TV side is sandbox-relative and already normalised by the
// service, so it looks POSIX to us.
function parentOf(p) {
  const s = String(p || "/");
  if (s === "/" || s === "") return "/";
  const cut = s.replace(/\/+$/, "");
  const idx = cut.lastIndexOf("/");
  if (idx <= 0) return "/";
  return cut.slice(0, idx);
}

function joinPath(dir, name) {
  const base = String(dir || "/").replace(/\/+$/, "");
  return `${base}/${name}`;
}

/**
 * Mount the explorer into `host` (an element inside the terminal window's
 * frame). Returns a handle the session controller drives.
 *
 * `session` is the live session handle — the explorer needs only its id, and
 * deliberately does not touch the terminal: the two tabs of one session share a
 * connection but nothing else.
 */
export function mountFileExplorer(hostEl, { sessionId, hostLabel, onSwitchToTerminal }) {
  const root = document.createElement("div");
  root.className = "fx-root";

  const panes = document.createElement("div");
  panes.className = "fx-panes";

  // The focus ring has exactly three stops: the two lists and the action row.
  // Small enough that the user can hold a mental model of it, which is what a
  // remote needs — a page full of tab stops is unnavigable without a pointer.
  let focusZone = SIDE_TV; // SIDE_TV | SIDE_HOST | "actions"
  // Which LIST the user was last in. Every action operates on a side, and the
  // action row is not one — so "the side the focus is on" is the wrong question
  // the moment the focus is on a button, which is the only way an action can be
  // invoked at all. Reading focusZone directly made Copy, New folder and Delete
  // silently act on the TV pane however the user got there.
  let lastListZone = SIDE_TV;
  // The side an action applies to: the list the user is in, or the one they
  // came from. Every write to focusZone goes through setZone so lastListZone
  // cannot fall out of step — it did once, when only the arrow-down path
  // maintained it and a mouse click into a pane left it stale.
  function setZone(zone) {
    focusZone = zone;
    if (zone === SIDE_TV || zone === SIDE_HOST) lastListZone = zone;
  }
  function activeSide() {
    return focusZone === SIDE_TV || focusZone === SIDE_HOST ? focusZone : lastListZone;
  }
  let actionIndex = 0;
  let disposed = false;
  let transfer = null; // { id, cancel(), sub }

  // `loadToken` sequences the listings per side: load() bumps it before the
  // await and a response only lands if the token is still current, so a slow
  // listing that resolves after the user has already navigated on cannot
  // overwrite the newer directory with the stale one.
  const state = {
    [SIDE_TV]: { path: "/", entries: [], index: 0, loading: false, error: null, truncated: false, loadToken: 0 },
    [SIDE_HOST]: { path: ".", entries: [], index: 0, loading: false, error: null, truncated: false, loadToken: 0 },
  };

  const panelEls = {};
  for (const side of [SIDE_TV, SIDE_HOST]) {
    const pane = document.createElement("div");
    pane.className = "fx-pane";
    pane.dataset.side = side;

    const head = document.createElement("div");
    head.className = "fx-head";
    const title = document.createElement("span");
    title.className = "fx-title";
    title.textContent = side === SIDE_TV ? "TV" : hostLabel || "host";
    const pathEl = document.createElement("span");
    pathEl.className = "fx-path";
    head.append(title, pathEl);

    const list = document.createElement("div");
    list.className = "fx-list";
    // The list is the focus target, not the rows: a row per file would put
    // hundreds of tab stops in the ring, and the selection is our own state
    // anyway. tabindex -1 keeps it focusable programmatically without adding it
    // to the document's own tab order.
    list.tabIndex = -1;
    list.setAttribute("role", "listbox");

    pane.append(head, list);
    panes.appendChild(pane);
    panelEls[side] = { pane, pathEl, list };
  }

  const status = document.createElement("div");
  status.className = "fx-status";

  const progress = document.createElement("div");
  progress.className = "fx-progress";
  progress.hidden = true;
  const progressBar = document.createElement("div");
  progressBar.className = "fx-progress-bar";
  const progressText = document.createElement("span");
  progressText.className = "fx-progress-text";
  progress.append(progressBar, progressText);

  const actions = document.createElement("div");
  actions.className = "fx-actions";
  const ACTIONS = [
    { id: "copy", label: "Copy ▶", tip: "Copy the selected entry to the other side", run: () => copySelected() },
    { id: "mkdir", label: "New folder", tip: "Create a folder in the pane that has focus", run: () => makeFolder() },
    { id: "delete", label: "Delete", tip: "Delete the selected entry — a folder only if it is empty", run: () => deleteSelected() },
    { id: "refresh", label: "Refresh", tip: "Re-read both listings", run: () => { load(SIDE_TV); load(SIDE_HOST); } },
    { id: "terminal", label: "Terminal", tip: "Switch to this host's shell — same connection", run: () => onSwitchToTerminal && onSwitchToTerminal() },
  ];
  const actionEls = ACTIONS.map((a) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fx-action";
    b.textContent = a.label;
    b.dataset.tip = a.tip;
    b.addEventListener("click", () => {
      setZone("actions");
      actionIndex = ACTIONS.indexOf(a);
      a.run();
      render();
    });
    actions.appendChild(b);
    return b;
  });

  const hint = document.createElement("div");
  hint.className = "fx-hint";
  hint.textContent =
    "◀ ▶ switch side · ▲ ▼ select · OK open · Back up one level · Copy sends to the other side";

  root.append(panes, progress, status, actions, hint);
  hostEl.appendChild(root);

  // --- data ----------------------------------------------------------------

  async function load(side, nextPath) {
    const st = state[side];
    if (nextPath !== undefined) st.path = nextPath;
    const token = ++st.loadToken;
    st.loading = true;
    st.error = null;
    render();
    try {
      const res = await serviceCall("files/list", {
        sessionId,
        side,
        path: st.path,
      });
      // A newer load owns this side now — its own completion clears `loading`,
      // so a superseded response must touch nothing, not even the flag.
      if (disposed || token !== st.loadToken) return;
      st.path = res.path || st.path;
      st.entries = Array.isArray(res.entries) ? res.entries : [];
      st.truncated = Boolean(res.truncated);
      st.error = null;
      if (st.index >= st.entries.length + 1) st.index = 0;
    } catch (e) {
      if (disposed || token !== st.loadToken) return;
      st.error = errorTextOf(e);
      st.entries = [];
    }
    st.loading = false;
    render();
  }

  // The ".." row is index 0 and is not part of `entries`, so every index below
  // is offset by one. Kept as a synthetic row rather than a real entry because
  // the service never returns it and both sides would have to agree on where it
  // sorts.
  function rowCount(side) {
    return state[side].entries.length + 1;
  }

  function selectedEntry(side) {
    const st = state[side];
    if (st.index === 0) return null; // ".."
    return st.entries[st.index - 1] || null;
  }

  function otherSide(side) {
    return side === SIDE_TV ? SIDE_HOST : SIDE_TV;
  }

  // --- actions -------------------------------------------------------------

  function openSelected() {
    const side = activeSide();
    const st = state[side];
    if (st.index === 0) {
      st.index = 0;
      return load(side, parentOf(st.path));
    }
    const entry = selectedEntry(side);
    if (!entry) return undefined;
    if (entry.type === "dir") {
      st.index = 0;
      return load(side, joinPath(st.path, entry.name));
    }
    // A file has no "open" on this device — say so instead of doing nothing,
    // which reads as the remote having missed the press.
    setStatus(`${entry.name} — ${formatSize(entry.size, entry.type)} (use Copy to transfer)`);
    return undefined;
  }

  function setStatus(text, kind) {
    status.textContent = text || "";
    status.dataset.kind = kind || "";
  }

  function copySelected() {
    if (transfer) {
      setStatus("a transfer is already running", "warn");
      return;
    }
    const from = activeSide();
    const entry = selectedEntry(from);
    if (!entry) {
      setStatus("select a file first", "warn");
      return;
    }
    if (entry.type === "dir") {
      setStatus("directories are not transferred — open it and copy the files", "warn");
      return;
    }
    const to = otherSide(from);
    const direction = from === SIDE_HOST ? "download" : "upload";
    // Both paths are always sent, and both are "this side's current directory
    // plus the file's own name" regardless of direction — `direction` alone
    // says which of the two is the source. The name is never rewritten: a file
    // that arrives under a different name than it left is the kind of surprise
    // a file manager must not have.
    const hostPath = joinPath(state[SIDE_HOST].path, entry.name);
    const tvPath = joinPath(state[SIDE_TV].path, entry.name);

    debugEvent("ui_files_transfer", { direction, name: entry.name, size: entry.size });
    showProgress(0, entry.size || 0, entry.name);

    // The bridge can fail SYNCHRONOUSLY (throw inside .call): the error
    // callback then runs endTransfer before subscribeSession has returned, and
    // the `if (!transfer)` seed below would resurrect a ghost transfer nothing
    // can end. `settled` marks any completion that happened before the seed.
    let settled = false;
    const sub = subscribeSession(
      "files/transfer",
      { sessionId, direction, hostPath, tvPath },
      (msg) => {
        if (disposed || !msg) return;
        if (msg.returnValue === false) {
          settled = true;
          endTransfer(`${entry.name}: ${msg.errorText || msg.errorCode || "failed"}`, "error");
          return;
        }
        if (msg.event === "started") {
          // Escape before `started` marks the transfer pendingCancel: the
          // service-side copy is already running, so the moment it has an id,
          // cancel it for real instead of just hiding the bar (the `done`
          // event with cancelled=true then ends the UI state).
          const wantCancel = transfer && transfer.pendingCancel;
          transfer = { id: msg.id, sub };
          if (wantCancel) {
            serviceCall("files/cancel", { id: msg.id });
            setStatus("cancelling…", "warn");
            return;
          }
          showProgress(0, msg.total || entry.size || 0, entry.name);
          return;
        }
        if (msg.event === "progress") {
          showProgress(msg.transferred || 0, msg.total || 0, entry.name);
          return;
        }
        if (msg.event === "done" || msg.done) {
          settled = true;
          if (msg.ok) {
            endTransfer(`${entry.name} → ${to === SIDE_TV ? "TV" : hostLabel || "host"}`, "ok");
            load(to);
          } else {
            endTransfer(
              `${entry.name}: ${msg.errorText || msg.errorCode || "failed"}`,
              msg.cancelled ? "warn" : "error",
            );
          }
        }
      },
      // Bridge-level failure (call refused, bridge gone): no `started` ever
      // arrives, so without this the progress bar stays up forever with a
      // transfer that has no id to cancel.
      (e) => {
        if (disposed) return;
        settled = true;
        endTransfer(`${entry.name}: ${errorTextOf(e)}`, "error");
      },
    );
    if (!settled && !transfer) transfer = { id: null, sub };
  }

  function showProgress(done, total, name) {
    progress.hidden = false;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    progressBar.style.width = `${pct}%`;
    progressText.textContent = total
      ? `${name} — ${formatSize(done, "file")} / ${formatSize(total, "file")} (${pct}%)`
      : `${name} — ${formatSize(done, "file")}`;
  }

  function endTransfer(text, kind) {
    if (transfer && transfer.sub && typeof transfer.sub.cancel === "function") {
      try {
        transfer.sub.cancel();
      } catch (e) {
        /* already gone */
      }
    }
    transfer = null;
    progress.hidden = true;
    progressBar.style.width = "0%";
    setStatus(text, kind);
  }

  async function makeFolder() {
    const side = activeSide();
    const name = await promptName("New folder name");
    if (!name) return;
    // A name is a NAME, not a path: letting "../x" through here would be a
    // second, quieter way to reach the parent of the sandbox. The service
    // refuses it too — this is the message the user can actually act on.
    if (name.includes("/") || name === "." || name === "..") {
      setStatus("a folder name cannot contain /", "warn");
      return;
    }
    try {
      await serviceCall("files/mkdir", {
        sessionId,
        side,
        path: joinPath(state[side].path, name),
      });
    } catch (e) {
      setStatus(errorTextOf(e), "error");
      return;
    }
    load(side);
  }

  async function deleteSelected() {
    const side = activeSide();
    const entry = selectedEntry(side);
    if (!entry) {
      setStatus("select something first", "warn");
      return;
    }
    const ok = await confirmAction(
      `Delete ${entry.name}${entry.type === "dir" ? " (must be empty)" : ""}?`,
    );
    if (!ok) return;
    try {
      await serviceCall("files/remove", {
        sessionId,
        side,
        path: joinPath(state[side].path, entry.name),
        isDir: entry.type === "dir",
      });
    } catch (e) {
      // The non-recursive delete is deliberate (see the header), so the error a
      // user is most likely to hit gets a sentence instead of an errno.
      const code = errorCodeOf(e);
      setStatus(
        code === "ENOTEMPTY" || code === "EEXIST" || code === "IS_ROOT"
          ? `${entry.name} is not empty — open it and delete its contents first`
          : errorTextOf(e),
        "error",
      );
      return;
    }
    const st = state[side];
    if (st.index > 0) st.index = Math.max(0, st.index - 1);
    load(side);
  }

  // --- small modal prompts, D-pad shaped -----------------------------------
  //
  // window.prompt/confirm are not usable here: the platform renders them as
  // system dialogs the remote cannot always reach, and they block the event
  // loop the terminal's own feed runs on.
  function overlay(build) {
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "fx-modal-back";
      const box = document.createElement("div");
      box.className = "fx-modal";
      back.appendChild(box);
      root.appendChild(back);
      const done = (value) => {
        back.remove();
        restoreFocus();
        resolve(value);
      };
      build(box, done);
      // The modal lives INSIDE `root`, whose own keydown handler drives the
      // explorer — so every key must stop here, or Backspace in the name input
      // cancels the dialog and Enter on a button re-runs the action underneath
      // (stacking a second modal). stopPropagation for everything; but only
      // preventDefault on the keys the modal consumes itself, so typing (and
      // Backspace) still reach the text input and Enter still activates the
      // focused button natively.
      back.addEventListener("keydown", (event) => {
        event.stopPropagation();
        const inInput = event.target && event.target.tagName === "INPUT";
        const isBack =
          event.key === "GoBack" ||
          event.keyCode === 461 ||
          (event.key === "Backspace" && !inInput);
        if (event.key === "Escape" || isBack) {
          event.preventDefault();
          done(null);
        }
      });
    });
  }

  // A modal owns the keyboard and the focus while it is up. Checked from the
  // explorer's own handlers rather than tracked in a flag, so it cannot fall
  // out of step with the DOM.
  function modalOpen() {
    return Boolean(root.querySelector(".fx-modal-back"));
  }

  function promptName(label) {
    return overlay((box, done) => {
      const t = document.createElement("div");
      t.className = "fx-modal-title";
      t.textContent = label;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "fx-modal-input";
      const row = document.createElement("div");
      row.className = "fx-modal-row";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = "OK";
      ok.dataset.tip = "Use this name";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.dataset.tip = "Close without creating anything";
      ok.addEventListener("click", () => done(input.value.trim() || null));
      cancel.addEventListener("click", () => done(null));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          done(input.value.trim() || null);
        }
      });
      row.append(ok, cancel);
      box.append(t, input, row);
      input.focus();
    });
  }

  function confirmAction(label) {
    return overlay((box, done) => {
      const t = document.createElement("div");
      t.className = "fx-modal-title";
      t.textContent = label;
      const row = document.createElement("div");
      row.className = "fx-modal-row";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.textContent = "Delete";
      yes.dataset.tip = "Delete it — this cannot be undone";
      yes.className = "fx-danger";
      const no = document.createElement("button");
      no.type = "button";
      no.textContent = "Cancel";
      no.dataset.tip = "Leave it alone";
      yes.addEventListener("click", () => done(true));
      no.addEventListener("click", () => done(false));
      row.append(no, yes);
      box.append(t, row);
      // Cancel takes focus, not the destructive one: on a remote the first
      // press after a dialog appears is very often an accidental repeat.
      no.focus();
    });
  }

  // --- keyboard ------------------------------------------------------------

  function onKeyDown(event) {
    if (disposed) return;
    // The overlay stops its own keys, but focus can sit outside the modal (the
    // synchronous render after an action handler used to put it back on a
    // list) — while a modal is up, the explorer underneath takes nothing.
    if (modalOpen()) return;
    const key = event.key;
    const inList = focusZone === SIDE_TV || focusZone === SIDE_HOST;

    if (key === "ArrowUp") {
      event.preventDefault();
      if (focusZone === "actions") {
        setZone(lastListZone);
      } else {
        const st = state[focusZone];
        st.index = st.index > 0 ? st.index - 1 : rowCount(focusZone) - 1;
      }
      return render();
    }
    if (key === "ArrowDown") {
      event.preventDefault();
      if (inList) {
        const st = state[focusZone];
        if (st.index >= rowCount(focusZone) - 1) {
          setZone("actions");
        } else {
          st.index += 1;
        }
      }
      return render();
    }
    if (key === "ArrowLeft") {
      event.preventDefault();
      if (focusZone === "actions") actionIndex = Math.max(0, actionIndex - 1);
      else if (focusZone === SIDE_HOST) setZone(SIDE_TV);
      return render();
    }
    if (key === "ArrowRight") {
      event.preventDefault();
      if (focusZone === "actions") actionIndex = Math.min(ACTIONS.length - 1, actionIndex + 1);
      else if (focusZone === SIDE_TV) setZone(SIDE_HOST);
      return render();
    }
    if (key === "Enter") {
      event.preventDefault();
      if (focusZone === "actions") {
        ACTIONS[actionIndex].run();
        return render();
      }
      return openSelected();
    }
    if (key === "Backspace" || key === "GoBack" || event.keyCode === 461) {
      event.preventDefault();
      event.stopPropagation();
      if (inList) {
        const st = state[focusZone];
        st.index = 0;
        load(focusZone, parentOf(st.path));
      }
      return undefined;
    }
    if (key === "Escape") {
      if (transfer) {
        event.preventDefault();
        cancelTransfer();
      }
      return undefined;
    }
    return undefined;
  }

  function cancelTransfer() {
    if (!transfer) return;
    // No id yet means the service has not said `started` — but the copy IS
    // already underway over there (getSftp/stat can take seconds), so simply
    // hiding the bar would orphan a live transfer that still lands. Mark it
    // instead: the `started` handler cancels for real the moment an id
    // exists. Only a dead subscription (bridge error) tears down without one.
    if (!transfer.id) {
      transfer.pendingCancel = true;
      setStatus("cancelling…", "warn");
      return;
    }
    serviceCall("files/cancel", { id: transfer.id });
    setStatus("cancelling…", "warn");
  }

  root.addEventListener("keydown", onKeyDown);

  // --- render --------------------------------------------------------------

  function restoreFocus() {
    if (disposed) return;
    // An action handler renders synchronously right after opening its modal —
    // the focus must stay on the modal's input/button, not snap back to the
    // list underneath. done() re-runs this after the modal is gone. But when
    // the modal LOST focus entirely (tab switch hides the pane and drops focus
    // to body), a plain bail would leave every key dead — no element in this
    // pane would see keydown at all. Refocus the modal itself in that case.
    if (modalOpen()) {
      const back = root.querySelector(".fx-modal-back");
      if (back && !back.contains(document.activeElement)) {
        const el = back.querySelector("input, button");
        if (el) el.focus();
      }
      return;
    }
    if (focusZone === "actions") {
      const el = actionEls[actionIndex];
      if (el) el.focus();
      return;
    }
    const el = panelEls[focusZone];
    if (el) el.list.focus();
  }

  function render() {
    for (const side of [SIDE_TV, SIDE_HOST]) {
      const st = state[side];
      const { pane, pathEl, list } = panelEls[side];
      pane.classList.toggle("active", focusZone === side);
      pathEl.textContent = st.path;
      pathEl.title = st.path;
      list.textContent = "";
      if (st.loading && !st.entries.length) {
        const row = document.createElement("div");
        row.className = "fx-row fx-empty";
        row.textContent = "loading…";
        list.appendChild(row);
        continue;
      }
      if (st.error) {
        const row = document.createElement("div");
        row.className = "fx-row fx-error";
        row.textContent = st.error;
        list.appendChild(row);
        continue;
      }
      const rows = [{ name: "..", type: "dir", size: 0, up: true }, ...st.entries];
      rows.forEach((entry, i) => {
        const row = document.createElement("div");
        const selected = i === st.index;
        row.className =
          "fx-row" +
          (selected ? " selected" : "") +
          (entry.type === "dir" ? " dir" : "") +
          (entry.up ? " up" : "");
        const name = document.createElement("span");
        name.className = "fx-name";
        name.textContent = entry.type === "dir" && !entry.up ? `${entry.name}/` : entry.name;
        const size = document.createElement("span");
        size.className = "fx-size";
        size.textContent = entry.up ? "" : formatSize(entry.size, entry.type);
        row.append(name, size);
        row.addEventListener("click", () => {
          setZone(side);
          st.index = i;
          render();
          openSelected();
        });
        list.appendChild(row);
        // Keep the selection on screen without a scrollbar to grab: the list
        // scrolls itself to whatever the D-pad just landed on.
        if (selected) {
          requestAnimationFrame(() => {
            if (!disposed && row.isConnected) {
              row.scrollIntoView({ block: "nearest" });
            }
          });
        }
      });
      if (st.truncated) {
        const row = document.createElement("div");
        row.className = "fx-row fx-empty";
        row.textContent = `… list truncated`;
        list.appendChild(row);
      }
    }
    actionEls.forEach((el, i) => {
      el.classList.toggle("selected", focusZone === "actions" && i === actionIndex);
    });
    // The copy button says where it would send, which is the one thing a
    // fixed-label button cannot: the direction depends on which pane is active.
    const copyIdx = ACTIONS.findIndex((a) => a.id === "copy");
    if (copyIdx >= 0) {
      actionEls[copyIdx].textContent = activeSide() === SIDE_HOST ? "◀ Copy to TV" : "Copy to host ▶";
      actionEls[copyIdx].dataset.tip =
        activeSide() === SIDE_HOST
          ? "Download the selected entry to the TV"
          : "Upload the selected entry to the host";
    }
    restoreFocus();
  }

  load(SIDE_TV);
  load(SIDE_HOST);
  render();

  return {
    element: root,
    focus() {
      restoreFocus();
    },
    refresh() {
      load(SIDE_TV);
      load(SIDE_HOST);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // A running transfer is deliberately NOT cancelled here: closing the tab
      // (or hiding the app) should not lose a copy the user started. The
      // service cancels it only when the session itself goes away.
      if (transfer && transfer.sub && typeof transfer.sub.cancel === "function") {
        try {
          transfer.sub.cancel();
        } catch (e) {
          /* already gone */
        }
      }
      transfer = null;
      root.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
