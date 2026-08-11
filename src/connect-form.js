import { listKeys } from "./keys.js";
import { listSessions, localShellAvailable, serviceCall } from "./service-client.js";
import { sessionTitle } from "./session-label.mjs";
import { capsLockStateFromEvent, printableDataFromKeyEvent } from "./keymap.mjs";
import { nextInRing, nextInRow } from "./focus-ring.mjs";
import {
  loadLastConnect,
  saveLastConnect,
  loadProfiles,
  saveProfiles,
  normalizeProfile,
  upsertProfile,
} from "./prefs.js";

// Injected by esbuild from package.json (scripts/build.sh). Three hand-kept
// copies of the version had already drifted apart for five releases, so the
// badge on screen could not be trusted to say what was actually installed.
// The fallback keeps a bare `npm run build:frontend` working.
const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const TEXT_FIELDS = new Set(["host", "port", "user", "password", "keyPassphrase"]);
// Fields where a stuck Caps Lock silently costs you an auth attempt: both are
// masked, so the usual "look at what you typed" feedback is gone.
const SECRET_FIELDS = new Set(["password", "keyPassphrase"]);

export function mountConnectForm(
  container,
  {
    onSubmit,
    onManageKeys,
    onDebug,
    onHide,
    onAttachSession = null,
    onStartLocalShell = null,
    debugEnabled = false,
    themeLabel = "",
    onCycleTheme,
    hostKeyIssue = null,
    onForgetHostKey,
  },
) {
  const last = loadLastConnect();
  let profiles = loadProfiles();
  // Migrate the single legacy last-connect entry into the profile list.
  if (!profiles.length && last && last.host) {
    profiles = [normalizeProfile(last)];
    saveProfiles(profiles);
  }
  let profileIndex = 0;
  const initial = profiles[0] || {};
  const values = {
    host: String(initial.host || ""),
    port: String(initial.port || 22),
    user: String(initial.user || ""),
    password: "",
    authType: initial.authType === "publickey" ? "publickey" : "password",
    keyId: String(initial.keyId || ""),
    keyPassphrase: "",
  };
  const cursors = {
    host: values.host.length,
    port: values.port.length,
    user: values.user.length,
    password: 0,
    keyPassphrase: 0,
  };
  let keys = [];
  let activeTextField = "";

  // One flat column of blocks — a head, one section per question the form
  // asks, a foot — with an elastic .seam at every joint (see styles.css). The
  // panel spans the full height of the screen band and the seams take up the
  // difference, so what used to be a 654px card floating in 996px of space now
  // fills it, with the air spread across the joints instead of pooled above
  // and below. Flat rather than nested on purpose: the seams can only share
  // free space with each other while they are children of the same flex box.
  container.innerHTML = `
    <section class="connect-form" aria-label="SSH connection">
      <header class="form-head">
        <div class="brand">
          <h1>webOS<b>SH</b></h1>
          <div class="brand-meta">
            <button type="button" id="theme-btn" class="theme-chip" aria-label="Switch theme" data-tip="Cycle the colour theme">◑ <span class="theme-name">${themeLabel}</span></button>
            <span class="brand-version">${APP_VERSION}</span>
          </div>
        </div>
        <div class="brand-rule"></div>
        <p class="tagline">Secure shell for the living room.</p>
      </header>
      <div class="seam sessions-seam" hidden></div>
      <div class="section sessions-field" hidden>
        <div class="section-head">
          <span class="section-name">Live sessions</span>
          <span class="section-rule"></span>
        </div>
        <ul class="sessions-list"></ul>
      </div>
      <div class="seam"></div>
      <div class="section">
        <div class="section-head">
          <span class="section-name">Target</span>
          <span class="section-rule"></span>
        </div>
        <div class="field profile-field" hidden>
          <span class="field-label">Recent</span>
          <div class="fake-input fake-select" data-field="profile" tabindex="0" role="button" aria-label="Recent connections" data-tip="Saved connections — ◀ ▶ to pick one, it fills the form below"></div>
        </div>
        <div class="field-row">
          <div class="field field-wide">
            <span class="field-label">Host</span>
            <div class="fake-input" data-field="host" tabindex="0" aria-label="Host"></div>
          </div>
          <div class="field field-narrow">
            <span class="field-label">Port</span>
            <div class="fake-input" data-field="port" tabindex="0" aria-label="Port"></div>
          </div>
        </div>
        <div class="field">
          <span class="field-label">User</span>
          <div class="fake-input" data-field="user" tabindex="0" aria-label="User"></div>
        </div>
      </div>
      <div class="seam"></div>
      <div class="section">
        <div class="section-head">
          <span class="section-name">Credentials</span>
          <span class="section-rule"></span>
          <div class="auth-segments" data-field="authType" tabindex="0" role="button" aria-label="Auth type" data-tip="Password or private key — ◀ ▶ to switch"></div>
        </div>
        <div class="auth-fields auth-password">
          <div class="field field-secret">
            <span class="field-label">Password</span>
            <span class="caps-warn" data-caps="password" role="status" hidden><i class="caps-dot"></i>Caps Lock</span>
            <div class="fake-input" data-field="password" tabindex="0" aria-label="Password"></div>
          </div>
        </div>
        <div class="auth-fields auth-publickey">
          <div class="field-row">
            <div class="field field-wide">
              <span class="field-label">Key</span>
              <div class="fake-input fake-select" data-field="keyId" tabindex="0" role="button" aria-label="Key" data-tip="Which stored key to log in with — ◀ ▶ to pick"></div>
            </div>
            <button type="button" id="manage-keys-btn" data-tip="Add, inspect or delete the private keys stored on this TV">Manage keys</button>
          </div>
          <div class="field field-secret">
            <span class="field-label">Passphrase (only if not stored with the key)</span>
            <span class="caps-warn" data-caps="keyPassphrase" role="status" hidden><i class="caps-dot"></i>Caps Lock</span>
            <div class="fake-input" data-field="keyPassphrase" tabindex="0" aria-label="Key passphrase"></div>
          </div>
        </div>
      </div>
      <div class="seam"></div>
      <footer class="form-foot">
        <div class="destination idle" aria-live="polite">
          <span class="dest-prompt">›</span>
          <span class="dest-target">… awaiting host</span>
          <span class="dest-pulse"></span>
        </div>
        <div class="hostkey-warn" role="alert" hidden>
          <p class="hostkey-title"><i class="caps-dot"></i>Host key changed</p>
          <p class="hostkey-detail"></p>
          <button type="button" id="forget-hostkey-btn" data-tip="Drop the stored fingerprint for this host and trust the new one on the next connect">Forget pinned key</button>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <div class="actions">
          <div class="action-row">
            <div class="dest-mode" role="radiogroup" aria-label="Open as">
              <button type="button" id="mode-ssh-btn" class="mode-btn selected" role="radio" aria-checked="true" data-tip="Open a shell on the remote host">SSH</button>
              <button type="button" id="mode-scp-btn" class="mode-btn" role="radio" aria-checked="false" data-tip="Open the file browser instead — same login, same connection">SCP</button>
            </div>
            <button type="button" id="connect-btn" data-tip="Log in and open the session">Connect</button>
          </div>
          <div class="action-row action-row-minor">
            <button type="button" id="local-btn" data-tip="Root shell on this TV itself, no network involved (Ctrl+Alt+L)">Local shell</button>
            ${debugEnabled ? '<button type="button" id="debug-btn" data-tip="Show the in-app event log (Ctrl+Alt+D)">Debug</button>' : ""}
            <button type="button" id="hide-btn" data-tip="Close the window and leave sessions running (Ctrl+Alt+H or Back)">Hide</button>
          </div>
        </div>
        <p class="hint">Hide with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> or Back</p>
      </footer>
    </section>
  `;

  const panel = container.querySelector(".connect-form");
  const passwordBlock = panel.querySelector(".auth-password");
  const publickeyBlock = panel.querySelector(".auth-publickey");
  const manageBtn = panel.querySelector("#manage-keys-btn");
  const connectBtn = panel.querySelector("#connect-btn");
  // What the connection is FOR, chosen before it is made. Both options land on
  // the same session; the only difference is which of its two views opens
  // first, so this is a segmented control rather than a second form.
  //
  // Two buttons and not a <select>: webOS renders a select as a system picker
  // the remote reaches inconsistently, and with exactly two mutually exclusive
  // options a picker is the wrong shape anyway. (Kept as a JS comment rather
  // than inside the markup template — a comment in that string ships as a real
  // comment node in the DOM, since esbuild only strips comments from code.)
  const modeSshBtn = panel.querySelector("#mode-ssh-btn");
  const modeScpBtn = panel.querySelector("#mode-scp-btn");
  // Deliberately NOT persisted with the profile. "I want a terminal" and "I
  // want to move a file" are properties of the errand, not of the host, and a
  // remembered SCP would put a returning user in a file manager when they
  // wanted a shell — the more annoying of the two wrong guesses.
  let openMode = "ssh";
  function setOpenMode(next) {
    openMode = next === "scp" ? "scp" : "ssh";
    modeSshBtn.classList.toggle("selected", openMode === "ssh");
    modeScpBtn.classList.toggle("selected", openMode === "scp");
    modeSshBtn.setAttribute("aria-checked", String(openMode === "ssh"));
    modeScpBtn.setAttribute("aria-checked", String(openMode === "scp"));
    connectBtn.textContent = openMode === "scp" ? "Open files" : "Connect";
  }
  modeSshBtn.addEventListener("click", () => setOpenMode("ssh"));
  modeScpBtn.addEventListener("click", () => setOpenMode("scp"));
  const debugBtn = panel.querySelector("#debug-btn");
  const hideBtn = panel.querySelector("#hide-btn");
  const localBtn = panel.querySelector("#local-btn");
  // Probed once per mount (see refreshLocalShell). Kept as a tri-state:
  // null means "not asked yet", so a click that beats the probe still tries
  // rather than refusing on a guess.
  let localShellReady = null;
  let localShellReason = "";
  const themeBtn = panel.querySelector("#theme-btn");
  const themeNameEl = themeBtn ? themeBtn.querySelector(".theme-name") : null;

  function cycleTheme() {
    if (!onCycleTheme) return;
    const label = onCycleTheme();
    if (themeNameEl && typeof label === "string") themeNameEl.textContent = label;
  }
  const destEl = panel.querySelector(".destination");
  const destTarget = panel.querySelector(".dest-target");
  const errorEl = panel.querySelector(".form-error");

  function showFormError(msg, field) {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
    if (field) focusField(field);
  }

  function clearFormError() {
    if (errorEl && !errorEl.hidden) {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
  }

  // Caps Lock indicator for the masked fields. The web platform exposes no way
  // to poll the lock's LED — it is only observable through a key event — so the
  // badge lights up on the first keystroke after the lock is engaged. Pressing
  // the Caps Lock key itself while a secret field is focused updates it right
  // away, since that key fires keydown/keyup like any other.
  let capsLockOn = false;

  function updateCapsWarning() {
    const active = SECRET_FIELDS.has(activeTextField) ? activeTextField : "";
    panel.querySelectorAll(".caps-warn").forEach((el) => {
      el.hidden = !(capsLockOn && el.dataset.caps === active);
    });
  }

  function trackCapsLock(event) {
    const state = capsLockStateFromEvent(event);
    if (state === null || state === capsLockOn) return;
    capsLockOn = state;
    updateCapsWarning();
  }

  function fieldEl(name) {
    return panel.querySelector(`[data-field="${name}"]`);
  }

  function renderTextField(name) {
    const el = fieldEl(name);
    const raw = values[name] || "";
    const pos = Math.max(0, Math.min(cursors[name] || 0, raw.length));
    const display = name === "password" || name === "keyPassphrase"
      ? "•".repeat(raw.length)
      : raw;

    el.textContent = "";
    let caret = null;
    if (name === activeTextField) {
      const left = document.createTextNode(display.slice(0, pos));
      caret = document.createElement("span");
      caret.className = "fake-caret";
      caret.textContent = " ";
      const right = document.createTextNode(display.slice(pos));
      el.append(left, caret, right);
    } else {
      el.textContent = display;
    }

    if (!raw) {
      const placeholder = document.createElement("span");
      placeholder.className = "fake-placeholder";
      placeholder.textContent = name === "password" || name === "keyPassphrase"
        ? "optional"
        : "";
      el.append(placeholder);
    }

    // The field is a fixed-width `overflow: hidden` div, so a value longer than
    // it (~42 chars) would push the caret and everything after it out of sight
    // — the field looks frozen while typing a long passphrase. Nothing scrolls
    // it for us (the caret is a span, not a real text cursor), so keep it in
    // view by hand. scrollLeft works on an overflow:hidden box.
    if (caret) {
      // Measure the caret against the FIELD. `offsetLeft` is relative to the
      // nearest positioned ancestor — here the panel, not `el` — so using it
      // raw added the panel's padding as a constant offset and started
      // scrolling while the field was still half empty.
      const caretLeft =
        caret.getBoundingClientRect().left -
        el.getBoundingClientRect().left +
        el.scrollLeft;
      const overflow = caretLeft - el.clientWidth + caret.offsetWidth + 8;
      el.scrollLeft = Math.max(0, overflow);
    } else {
      el.scrollLeft = 0;
    }

    updateDestination();
  }

  function renderSelect(name) {
    const el = fieldEl(name);
    if (name === "authType") {
      el.textContent = "";
      const pw = document.createElement("span");
      pw.className = "auth-segment" + (values.authType === "password" ? " active" : "");
      pw.textContent = "password";
      const sep = document.createElement("span");
      sep.className = "auth-divider";
      sep.textContent = "/";
      const pk = document.createElement("span");
      pk.className = "auth-segment" + (values.authType === "publickey" ? " active" : "");
      pk.textContent = "public key";
      el.append(pw, sep, pk);
      return;
    }

    const selected = keys.find((key) => key.id === values.keyId);
    el.textContent = "";
    if (selected) {
      const label = document.createElement("span");
      label.className = "key-name";
      label.textContent = selected.label;
      const type = document.createElement("span");
      type.className = "key-kind";
      type.textContent = selected.type;
      el.append(label, type);
    } else if (keys.length) {
      values.keyId = keys[0].id;
      renderSelect(name);
    } else {
      const empty = document.createElement("span");
      empty.className = "fake-placeholder";
      empty.textContent = "no keys — add one via Manage keys";
      el.append(empty);
    }
  }

  function updateDestination() {
    if (!destEl || !destTarget) return;
    const host = values.host.trim();
    const user = values.user.trim();
    const port = values.port.trim();
    const ready = Boolean(host && user && port);
    if (ready) {
      destEl.classList.remove("idle");
      destTarget.textContent = `${user}@${host}:${port}`;
    } else {
      destEl.classList.add("idle");
      if (!host) destTarget.textContent = "… awaiting host";
      else if (!user) destTarget.textContent = "… awaiting user";
      else destTarget.textContent = "… awaiting port";
    }
  }

  function renderProfile() {
    const row = panel.querySelector(".profile-field");
    const el = fieldEl("profile");
    if (!row || !el) return;
    row.hidden = profiles.length < 2;
    if (row.hidden) return;
    const profile = profiles[profileIndex] || profiles[0];
    el.textContent = "";
    const label = document.createElement("span");
    label.className = "key-name";
    label.textContent = `${profile.user}@${profile.host}:${profile.port}`;
    const count = document.createElement("span");
    count.className = "key-kind";
    count.textContent = `${profileIndex + 1}/${profiles.length}`;
    el.append(label, count);
  }

  function applyProfile(index) {
    if (!profiles.length) return;
    profileIndex = ((index % profiles.length) + profiles.length) % profiles.length;
    const profile = profiles[profileIndex];
    values.host = profile.host;
    values.port = String(profile.port || 22);
    values.user = profile.user;
    values.authType = profile.authType;
    values.keyId = String(profile.keyId || "");
    values.password = "";
    values.keyPassphrase = "";
    Object.keys(cursors).forEach((name) => {
      cursors[name] = (values[name] || "").length;
    });
    clearFormError();
    render();
  }

  function cycleProfile(direction) {
    if (profiles.length < 2) return;
    applyProfile(profileIndex + direction);
    focusField("profile");
  }

  function render() {
    TEXT_FIELDS.forEach(renderTextField);
    renderSelect("authType");
    renderSelect("keyId");
    renderProfile();
    const isPassword = values.authType === "password";
    passwordBlock.hidden = !isPassword;
    publickeyBlock.hidden = isPassword;
    updateDestination();
  }

  function focusField(name) {
    const el = fieldEl(name);
    if (el) el.focus();
  }

  // A control counts as reachable only if it is actually on screen: the auth
  // block that is not selected is `display: none`, the confirm/cancel pair of
  // a session row is `hidden` until you ask to end it, and the whole profile
  // row disappears with fewer than two profiles. getClientRects() is the one
  // check that covers all three (and an ancestor being hidden too), which
  // offsetParent does not once anything is position: fixed.
  function isReachable(el) {
    return !el.disabled && el.getClientRects().length > 0;
  }

  function ringControls() {
    return Array.from(
      panel.querySelectorAll('[tabindex="0"], button'),
    ).filter(isReachable);
  }

  function rowControls(row) {
    return Array.from(row.querySelectorAll("button")).filter(isReachable);
  }

  function moveRing(step) {
    const next = nextInRing(ringControls(), document.activeElement, step);
    if (next) next.focus();
  }

  function cycleAuth() {
    values.authType = values.authType === "password" ? "publickey" : "password";
    render();
    focusField("authType");
  }

  function cycleKey(direction) {
    if (!keys.length) return;
    const current = keys.findIndex((key) => key.id === values.keyId);
    const next = current < 0
      ? 0
      : (current + direction + keys.length) % keys.length;
    values.keyId = keys[next].id;
    renderSelect("keyId");
  }

  function editTextField(name, event) {
    const raw = values[name] || "";
    let pos = Math.max(0, Math.min(cursors[name] || 0, raw.length));
    const key = event.key;

    if (key === "Backspace") {
      if (pos > 0) {
        values[name] = raw.slice(0, pos - 1) + raw.slice(pos);
        pos -= 1;
      }
    } else if (key === "Delete") {
      if (pos < raw.length) values[name] = raw.slice(0, pos) + raw.slice(pos + 1);
    } else if (key === "ArrowLeft") {
      pos -= 1;
    } else if (key === "ArrowRight") {
      pos += 1;
    } else if (key === "Home") {
      pos = 0;
    } else if (key === "End") {
      pos = raw.length;
    } else {
      const ch = printableDataFromKeyEvent(event);
      if (!ch) return false;
      if (name === "port" && !/[0-9]/.test(ch)) return true;
      values[name] = raw.slice(0, pos) + ch + raw.slice(pos);
      pos += ch.length;
    }

    cursors[name] = Math.max(0, Math.min(pos, values[name].length));
    clearFormError();
    renderTextField(name);
    return true;
  }

  function submit() {
    const host = values.host.trim();
    const port = Number(values.port.trim());
    const user = values.user.trim();
    if (!host) return showFormError("Host is required.", "host");
    if (/\s/.test(host)) {
      return showFormError("Host must not contain spaces.", "host");
    }
    if (!user) return showFormError("User is required.", "user");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return showFormError("Port must be a number between 1 and 65535.", "port");
    }

    let auth;
    let keyId = null;
    if (values.authType === "password") {
      auth = { type: "password", password: values.password || "" };
    } else {
      keyId = values.keyId || "";
      if (!keyId) {
        return showFormError(
          "No key selected — add one via Manage keys.",
          "keyId",
        );
      }
      auth = { type: "publickey", keyId };
      if (values.keyPassphrase) auth.passphrase = values.keyPassphrase;
    }

    clearFormError();
    profiles = upsertProfile(profiles, {
      host,
      port,
      user,
      authType: values.authType,
      keyId,
    });
    saveProfiles(profiles);
    profileIndex = 0;
    saveLastConnect({ host, port, user, authType: values.authType, keyId });
    onSubmit({ host, port, user, auth, openMode });
  }

  panel.addEventListener("keydown", (event) => {
    const target = event.target;
    const field = target && target.dataset ? target.dataset.field : "";

    if (event.key === "Enter") {
      event.preventDefault();
      if (field === "authType") cycleAuth();
      else if (field === "keyId") cycleKey(1);
      else if (field === "profile") cycleProfile(1);
      else if (target === manageBtn) onManageKeys && onManageKeys();
      else if (debugBtn && target === debugBtn) onDebug && onDebug();
      else if (themeBtn && target === themeBtn) cycleTheme();
      else if (forgetHostKeyBtn && target === forgetHostKeyBtn) forgetHostKeyBtn.click();
      else if (target === hideBtn) onHide && onHide();
      // Any other focused button (session Attach/End/Confirm/Cancel rows are
      // built dynamically) activates instead of falling through to submit.
      else if (target && target.tagName === "BUTTON") target.click();
      else submit();
      return;
    }

    // Up/Down is focus travel across the whole form, before anything else gets
    // a say. The pickers used to spend it on cycling their own value, which
    // left the remote with no way at all to step from one control to the next
    // — Tab does not exist on it, and the pointer is a drifting Magic Remote.
    // Left/Right still cycles those pickers, so nothing lost a gesture.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveRing(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    // Left/Right along a row of buttons. Text fields and pickers keep their
    // own meaning for these keys, so this only applies where the key would
    // otherwise do nothing at all.
    if (
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      target &&
      target.tagName === "BUTTON"
    ) {
      const row = target.closest(".action-row, .field-row, .session-actions");
      const next = row
        ? nextInRow(rowControls(row), target, event.key === "ArrowRight" ? 1 : -1)
        : null;
      if (next) {
        event.preventDefault();
        next.focus();
        return;
      }
    }

    if (field === "profile" && (event.key === " " || event.key === "ArrowRight")) {
      event.preventDefault();
      cycleProfile(1);
      return;
    }

    if (field === "profile" && event.key === "ArrowLeft") {
      event.preventDefault();
      cycleProfile(-1);
      return;
    }

    if (field === "authType" && (event.key === " " || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      cycleAuth();
      return;
    }

    if (field === "keyId" && (event.key === " " || event.key === "ArrowRight")) {
      event.preventDefault();
      cycleKey(1);
      return;
    }

    if (field === "keyId" && event.key === "ArrowLeft") {
      event.preventDefault();
      cycleKey(-1);
      return;
    }

    if (TEXT_FIELDS.has(field) && editTextField(field, event)) {
      event.preventDefault();
    }
  });

  // Capture phase: these run regardless of what the editing handlers above do
  // with the event, and cover both delivery paths — webOS 25 routes printable
  // USB keys through keypress while special keys arrive as keydown.
  panel.addEventListener("keydown", trackCapsLock, true);
  panel.addEventListener("keypress", trackCapsLock, true);
  panel.addEventListener("keyup", trackCapsLock, true);

  panel.addEventListener("focusin", (event) => {
    const field = event.target && event.target.dataset ? event.target.dataset.field : "";
    if (TEXT_FIELDS.has(field)) {
      activeTextField = field;
      cursors[field] = values[field].length;
      TEXT_FIELDS.forEach(renderTextField);
    } else if (activeTextField) {
      activeTextField = "";
      TEXT_FIELDS.forEach(renderTextField);
    }
    updateCapsWarning();
  });

  panel.addEventListener("focusout", () => {
    setTimeout(() => {
      if (panel.contains(document.activeElement)) return;
      activeTextField = "";
      TEXT_FIELDS.forEach(renderTextField);
      updateCapsWarning();
    }, 0);
  });

  // Recovery affordance for a legitimately rotated host key. Without it the
  // refusal is a dead end: the service names `knownhosts/remove`, which is
  // otherwise only reachable from a root shell — i.e. from another SSH client.
  const hostKeyBlock = panel.querySelector(".hostkey-warn");
  const forgetHostKeyBtn = panel.querySelector("#forget-hostkey-btn");
  if (hostKeyIssue && hostKeyIssue.host && onForgetHostKey) {
    const target = `${hostKeyIssue.host}:${hostKeyIssue.port || 22}`;
    panel.querySelector(".hostkey-detail").textContent =
      `The key presented by ${target} does not match the one pinned on first ` +
      `connect. If you did not reinstall that server, do not clear the pin — ` +
      `someone may be intercepting the connection.`;
    hostKeyBlock.hidden = false;
    forgetHostKeyBtn.addEventListener("click", async () => {
      // Disabling the focused button unfocuses it (a disabled control is not
      // focusable), and hiding the block afterwards makes it unreachable — so
      // focus has to be placed somewhere inside the panel explicitly. Without
      // this, focus lands on <body> and the whole form goes key-dead: all of
      // its handlers are bound to the panel subtree.
      forgetHostKeyBtn.disabled = true;
      forgetHostKeyBtn.textContent = "Forgetting…";
      try {
        await onForgetHostKey(hostKeyIssue);
        hostKeyBlock.hidden = true;
        showFormError(`Pin for ${target} cleared — connect again to re-pin.`);
        connectBtn.focus();
      } catch (e) {
        forgetHostKeyBtn.disabled = false;
        forgetHostKeyBtn.textContent = "Forget pinned key";
        showFormError(
          `Could not clear the pin: ${(e && (e.errorText || e.errorCode)) || "unknown error"}`,
        );
        forgetHostKeyBtn.focus();
      }
    });
  }

  // The local shell needs no host, user or credentials — it is a button, not a
  // form. The button stays visible and enabled even when the helper is missing:
  // the failure has ONE fix (install ptyd) and a hidden button cannot say so,
  // while a disabled one cannot be asked why.
  function openLocalShell() {
    if (!onStartLocalShell) return;
    if (localShellReady === false) {
      showFormError(
        localShellReason ||
          "The local shell helper (ptyd) is not running on this TV.",
      );
      return;
    }
    clearFormError();
    onStartLocalShell();
  }

  async function refreshLocalShell() {
    if (!onStartLocalShell || !localBtn) {
      if (localBtn) localBtn.hidden = true;
      return;
    }
    const status = await localShellAvailable();
    if (!panel.isConnected) return;
    localShellReady = status.available;
    localShellReason = status.errorText || "";
    // Overrides the button's static data-tip (see the markup): when the helper
    // is missing, the tooltip is the only place that says WHY the button does
    // nothing. Keep the shortcut in the available case — the tip is the only
    // place it is written down.
    localBtn.title = status.available
      ? "Root shell on this TV itself, no network involved (Ctrl+Alt+L)"
      : localShellReason || "Local shell helper (ptyd) not running";
    localBtn.classList.toggle("unavailable", !status.available);
  }

  if (localBtn) localBtn.addEventListener("click", openLocalShell);

  manageBtn.addEventListener("click", () => onManageKeys && onManageKeys());
  if (themeBtn) themeBtn.addEventListener("click", cycleTheme);
  connectBtn.addEventListener("click", submit);
  if (debugBtn) debugBtn.addEventListener("click", () => onDebug && onDebug());
  hideBtn.addEventListener("click", () => onHide && onHide());

  // ------------------------------------------------------------------
  // Live background sessions. The service keeps SSH sessions alive while no
  // client is attached (Hide, detach, a second connect) — this list makes
  // every one of them reachable again, not just the newest.
  // ------------------------------------------------------------------
  function sessionAgeLabel(ts) {
    const seconds = Math.max(0, Math.round((Date.now() - Number(ts || 0)) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
  }

  function renderSessions(sessions) {
    const row = panel.querySelector(".sessions-field");
    const list = panel.querySelector(".sessions-list");
    if (!row || !list) return;
    list.textContent = "";
    const live = Array.isArray(sessions)
      ? sessions
          .slice()
          .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      : [];
    row.hidden = !live.length;
    // Every seam in the panel is a flex spacer, so a section that comes and
    // goes has to take its own seam with it — two adjacent spacers would
    // double the gap above Target on every launch with no live sessions.
    const seam = panel.querySelector(".sessions-seam");
    if (seam) seam.hidden = row.hidden;
    if (row.hidden) return;
    for (const s of live) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "key-name";
      label.textContent = sessionTitle(s);
      const meta = document.createElement("span");
      meta.className = "key-kind";
      meta.textContent = `${s.stage || "?"} · ${sessionAgeLabel(s.updatedAt)}`;

      const actions = document.createElement("span");
      actions.className = "session-actions";
      const attachBtn = document.createElement("button");
      attachBtn.type = "button";
      attachBtn.textContent = "Attach";
      attachBtn.dataset.tip = "Take over this running session in this window";
      attachBtn.addEventListener("click", () => {
        if (onAttachSession) onAttachSession(s.id);
      });
      // Ending a session kills a live remote shell — two-step confirm, same
      // pattern as key deletion (native confirm dialogs are unreliable on the
      // webOS WebView).
      const endBtn = document.createElement("button");
      endBtn.type = "button";
      endBtn.textContent = "End";
      endBtn.dataset.tip = "Close the connection and kill the remote shell";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "danger";
      confirmBtn.textContent = "Confirm";
      confirmBtn.dataset.tip = "Yes — end it now";
      confirmBtn.hidden = true;
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.dataset.tip = "Keep the session running";
      cancelBtn.hidden = true;

      function setConfirming(on) {
        endBtn.hidden = on;
        confirmBtn.hidden = !on;
        cancelBtn.hidden = !on;
        (on ? confirmBtn : endBtn).focus();
      }
      endBtn.addEventListener("click", () => setConfirming(true));
      cancelBtn.addEventListener("click", () => setConfirming(false));
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          await serviceCall("disconnect", { sessionId: s.id });
        } catch (e) {
          /* NO_SESSION — it ended on its own; the refresh below shows that */
        }
        await refreshSessions();
        // The focused button just left the DOM — park focus on a stable
        // control or the whole form goes keyboard-dead.
        connectBtn.focus();
      });

      actions.append(attachBtn, endBtn, confirmBtn, cancelBtn);
      li.append(label, meta, actions);
      list.appendChild(li);
    }
  }

  async function refreshSessions() {
    if (!onAttachSession) return;
    let sessions = [];
    try {
      sessions = await listSessions();
    } catch (e) {
      sessions = []; // service unreachable — just hide the block
    }
    // The form may have been replaced while the list was in flight.
    if (!panel.isConnected) return;
    renderSessions(sessions);
  }

  async function refreshKeys() {
    fieldEl("keyId").textContent = "Loading…";
    try {
      keys = await listKeys();
      if (keys.length && !keys.some((key) => key.id === values.keyId)) {
        values.keyId = keys[0].id;
      }
    } catch (e) {
      keys = [];
      fieldEl("keyId").textContent = `(error: ${
        (e && (e.errorText || e.errorCode || e.message)) || "unknown error"
      })`;
      return;
    }
    render();
  }

  function focusInitialField() {
    // When host and user are already remembered, drop focus straight onto the
    // secret field so the user can start typing the password/passphrase at app
    // start without first navigating into it. Otherwise start at the top.
    if (values.host.trim() && values.user.trim()) {
      focusField(values.authType === "publickey" ? "keyPassphrase" : "password");
      return;
    }
    focusField("host");
  }

  render();
  refreshKeys();
  refreshSessions();
  refreshLocalShell();
  focusInitialField();
}
