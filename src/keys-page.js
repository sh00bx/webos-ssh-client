import {
  listKeys,
  addKey,
  removeKey,
  listKnownHosts,
  removeKnownHost,
} from "./keys.js";

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function mountKeysPage(container, onBack) {
  container.innerHTML = `
    <div class="keys-page">
      <header class="page-header">
        <h1>ssh keys</h1>
        <button id="back-btn" type="button" data-tip="Back to the login form">Back</button>
      </header>
      <section>
        <h2>Stored keys</h2>
        <div id="keys-list" class="keys-list-wrapper"><em>Loading…</em></div>
      </section>
      <section>
        <h2>Add a private key</h2>
        <form id="add-key-form" autocomplete="off">
          <label>Label
            <input name="label" type="text" required />
          </label>
          <label>Private key (PEM)
            <textarea name="privateKeyPem" rows="10" required spellcheck="false"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."></textarea>
          </label>
          <label>Passphrase (optional — leave empty to be asked on connect; stored in plaintext on the TV if provided)
            <input name="passphrase" type="password" />
          </label>
          <button type="submit" data-tip="Store this key on the TV so it can be picked on the login form">Add key</button>
          <p id="add-key-status" class="hint"></p>
        </form>
      </section>
      <section>
        <h2>Pinned host keys</h2>
        <p class="hint">Pinned on first connect (trust-on-first-use). Delete a pin only
        after a deliberate server reinstall — the next connect re-pins whatever
        key the server presents.</p>
        <div id="hosts-list" class="keys-list-wrapper"><em>Loading…</em></div>
      </section>
    </div>
  `;

  const backBtn = container.querySelector("#back-btn");
  backBtn.addEventListener("click", onBack);

  function errorText(err) {
    return (
      (err && (err.errorText || err.errorCode || err.message)) || "unknown error"
    );
  }

  // `focusAfter` is the list index whose Delete button should take focus once
  // the list has been rebuilt. Rebuilding detaches the button the user just
  // activated, which drops focus to <body> — on a remote-driven TV that means
  // tabbing in from the top of the page again for every single deletion.
  async function refresh(focusAfter) {
    const wrapper = container.querySelector("#keys-list");
    wrapper.innerHTML = "<em>Loading…</em>";
    let keys;
    try {
      keys = await listKeys();
    } catch (e) {
      wrapper.innerHTML = `<em class="error">Error: ${escapeText(errorText(e))}</em>`;
      backBtn.focus();
      return;
    }
    if (!keys.length) {
      wrapper.innerHTML = "<em>No keys yet.</em>";
      if (focusAfter !== undefined) backBtn.focus();
      return;
    }
    wrapper.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "keys-list";
    const deleteButtons = [];
    for (const [index, k] of keys.entries()) {
      const li = document.createElement("li");
      const main = document.createElement("span");
      main.innerHTML =
        `<span class="key-label">${escapeText(k.label)}</span>` +
        ` <span class="key-type">${escapeText(k.type)}</span>`;

      // Inline two-step confirm instead of window.confirm(): native dialogs
      // are unreliable on the webOS WebView (they can be blocked or never
      // paint), so the Delete button reveals Confirm / Cancel in place.
      const actions = document.createElement("span");
      actions.className = "key-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.dataset.tip = "Remove this key from the TV";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "danger";
      confirmBtn.textContent = "Confirm";
      confirmBtn.dataset.tip = "Delete it — the private key is gone from the TV afterwards";
      confirmBtn.hidden = true;
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.dataset.tip = "Keep the key";
      cancelBtn.hidden = true;

      function setConfirming(on) {
        del.hidden = on;
        confirmBtn.hidden = !on;
        cancelBtn.hidden = !on;
        (on ? confirmBtn : del).focus();
      }
      del.addEventListener("click", () => setConfirming(true));
      cancelBtn.addEventListener("click", () => setConfirming(false));
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
          await removeKey(k.id);
        } catch (err) {
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          setConfirming(false);
          const note = document.createElement("em");
          note.className = "error";
          note.textContent = ` delete failed: ${errorText(err)}`;
          actions.appendChild(note);
          return;
        }
        refresh(index);
      });

      deleteButtons.push(del);
      actions.append(del, confirmBtn, cancelBtn);
      li.appendChild(main);
      li.appendChild(actions);
      ul.appendChild(li);
    }
    wrapper.appendChild(ul);
    if (focusAfter !== undefined && deleteButtons.length) {
      const target = deleteButtons[Math.min(focusAfter, deleteButtons.length - 1)];
      if (target) target.focus();
    }
  }

  // "host:port" → parts; the port sits after the LAST colon (hosts here are
  // hostnames/IPv4 — the service builds the id the same way).
  function splitHostId(hostId) {
    const i = hostId.lastIndexOf(":");
    if (i < 0) return { host: hostId, port: 22 };
    return { host: hostId.slice(0, i), port: Number(hostId.slice(i + 1)) || 22 };
  }

  async function refreshHosts() {
    const wrapper = container.querySelector("#hosts-list");
    if (!wrapper) return;
    wrapper.innerHTML = "<em>Loading…</em>";
    let hosts;
    try {
      hosts = await listKnownHosts();
    } catch (e) {
      wrapper.innerHTML = `<em class="error">Error: ${escapeText(errorText(e))}</em>`;
      return;
    }
    const ids = Object.keys(hosts).sort();
    if (!ids.length) {
      wrapper.innerHTML = "<em>No pinned hosts yet.</em>";
      return;
    }
    wrapper.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "keys-list";
    for (const hostId of ids) {
      const entry = hosts[hostId] || {};
      const li = document.createElement("li");
      const main = document.createElement("span");
      const added = entry.addedAt
        ? new Date(Number(entry.addedAt)).toISOString().slice(0, 10)
        : "?";
      main.innerHTML =
        `<span class="key-label">${escapeText(hostId)}</span>` +
        ` <span class="key-type">${escapeText(String(entry.fingerprint || ""))} · pinned ${escapeText(added)}</span>`;

      const actions = document.createElement("span");
      actions.className = "key-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.dataset.tip = "Unpin this host — the next connect trusts whatever key the server presents";
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "danger";
      confirmBtn.textContent = "Confirm";
      confirmBtn.dataset.tip = "Unpin it now";
      confirmBtn.hidden = true;
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.dataset.tip = "Keep the pin";
      cancelBtn.hidden = true;

      function setConfirming(on) {
        del.hidden = on;
        confirmBtn.hidden = !on;
        cancelBtn.hidden = !on;
        (on ? confirmBtn : del).focus();
      }
      del.addEventListener("click", () => setConfirming(true));
      cancelBtn.addEventListener("click", () => setConfirming(false));
      confirmBtn.addEventListener("click", async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        const { host, port } = splitHostId(hostId);
        try {
          await removeKnownHost(host, port);
        } catch (err) {
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
          setConfirming(false);
          const note = document.createElement("em");
          note.className = "error";
          note.textContent = ` delete failed: ${errorText(err)}`;
          actions.appendChild(note);
          return;
        }
        // Rebuilding the list detaches the focused button; park focus on Back
        // so the page stays keyboard-navigable from a known spot.
        refreshHosts();
        backBtn.focus();
      });

      actions.append(del, confirmBtn, cancelBtn);
      li.appendChild(main);
      li.appendChild(actions);
      ul.appendChild(li);
    }
    wrapper.appendChild(ul);
  }

  const form = container.querySelector("#add-key-form");
  const status = container.querySelector("#add-key-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.classList.remove("error");
    status.textContent = "Adding…";
    const data = new FormData(form);
    try {
      const result = await addKey({
        label: String(data.get("label")).trim(),
        privateKeyPem: String(data.get("privateKeyPem")),
        passphrase: String(data.get("passphrase") || "") || undefined,
      });
      status.textContent =
        result.encrypted && !result.passphraseStored
          ? "Added encrypted key — the passphrase will be asked for on the connect form."
          : `Added ${result.type || "encrypted"} key.`;
      form.reset();
      refresh();
    } catch (e) {
      status.classList.add("error");
      status.textContent = `Failed: ${errorText(e)}`;
    }
  });

  refresh();
  refreshHosts();
}
