# Development notes

## Layout

```
.
├── appinfo.json          # webOS app manifest
├── index.html            # entry HTML; loads dist/main.{js,css}
├── package.json          # frontend build deps + scripts
├── assets/               # packaged static assets (terminal font, licenses)
├── icon.png              # 80x80 launcher icon
├── icon-large.png        # 130x130
├── src/                  # frontend source (esbuild input)
│   ├── main.js           # composition root: wires router + controller, global listeners
│   ├── app-state.js      # the one shared mutable UI state (session/activeView/…)
│   ├── view-router.js    # which view is mounted; overlay show/hide
│   ├── session-controller.js # terminal session orchestration + service subscription
│   ├── terminal-window.js    # terminal chrome: toolbar/keybar/geometry/drags
│   ├── terminal.js       # xterm.js + FitAddon init, input handling
│   ├── connect-form.js   # connect form
│   ├── keys-page.js      # SSH key management page
│   ├── keys.js           # Promise wrappers for keys/* Luna methods
│   ├── service-client.js # typed surface over the Luna bridge for our service
│   ├── theme-controller.js # theme state + Chameleon backdrop feed
│   ├── platform.js       # webOS app-manager glue (activate/close/open browser)
│   ├── debug.js          # debug flag/logging + on-screen debug panel
│   ├── prefs.js          # all localStorage-backed preferences
│   ├── luna.js           # Luna wrapper: webOS.service.request + PalmServiceBridge
│   ├── keymap.mjs        # key event → terminal bytes (unit-tested)
│   ├── themes.mjs, color.mjs, window-geometry.mjs, keyboard-layout.mjs  # pure, unit-tested
│   └── styles.css        # styles (imported ONLY by main.js — CSS import order matters)
├── service/              # webOS Node.js service
│   ├── services.json     # Luna service registration
│   ├── package.json      # ssh2 dep (webos-service is platform-provided)
│   ├── package-lock.json
│   ├── service.js        # entry point: wiring only
│   └── lib/              # the actual service modules
│       ├── bus.js        # Service instance + caller gate — ALL register() calls go through here
│       ├── config.js     # storage paths, limits, env clamps
│       ├── storage.js    # dirs, atomic JSON writes, legacy migration
│       ├── sessions.js   # session registry, subscribers, replay buffer, teardown
│       ├── ssh-session.js# connect/attach: ssh2 client, shell stream, TOFU wiring
│       ├── known-hosts.js# TOFU pin store + per-connection host verifier
│       ├── keystore.js   # key metadata + auth-time key loading
│       ├── keepalive.js  # activityManager keepalive (session count injected)
│       ├── debug-log.js  # sanitized debug log (flag behind isDebugEnabled())
│       ├── backdrop.js   # Chameleon backdrop TCP→Luna bridge
│       └── handlers/     # Luna method groups (sessions/debug/keys)
├── scripts/
│   ├── build.sh          # bundles frontend, npm-cis service, ares-packages
│   └── install.sh        # ares-install + ares-launch on a target
└── docs/
```

## Frontend

`src/main.js` imports `./styles.css` and `xterm/css/xterm.css`. esbuild
bundles JS into `dist/main.js` and concatenates the CSS imports into
`dist/main.css`. `index.html` loads `dist/main.css` and `dist/main.js`.

```bash
npm run build:frontend       # one-shot
```

For iterative work, you can run esbuild in watch mode:

```bash
npx esbuild src/main.js --bundle --outfile=dist/main.js \
    --target=chrome94 --loader:.css=css --watch
```

`src/luna.js` supports both Luna bridges seen in webOS WebViews:
`webOS.service.request` and `PalmServiceBridge`. If neither exists, the UI
prints a visible `[bridge error]` instead of silently hanging.

The connect screen is intentionally USB-keyboard-first and does not use
native `<input>` or `<select>` controls. The custom fields also avoid
`role="textbox"` because some webOS builds treat focused editable roles like
native text controls and open the virtual keyboard. Keep the custom focusable
fields unless you are deliberately reintroducing virtual-keyboard support.

`src/terminal.js` keeps xterm.js stdin enabled for terminal features such as
mouse-wheel escape reporting, but it does not focus xterm.js' hidden helper
textarea. USB keyboard events are captured on the terminal frame and document,
translated in `src/keymap.mjs`, and sent to the service directly. This avoids
the webOS virtual keyboard while preserving terminal input.

The keyboard layout is auto-detected and has **no user-facing switch** (an
earlier `KB` cycle button and its `ssh-client.keyboard.layout` storage key were
removed). `resolveKeyboardLayout` in `src/keyboard-layout.mjs` maps a German
browser/TV locale to the `de` hardware layout and everything else to `system`,
which trusts `event.key`. The hardware layouts map `event.code`/legacy
`keyCode` ahead of `event.key`, which handles webOS paths that report a German
USB keyboard as English. To override it you have to pass `keyboardLayout` from
a call site or change `DEFAULT_KEYBOARD_LAYOUT` in `src/keymap.mjs`.

Keep AltGr handling separate from the app's Ctrl+Alt shortcuts so characters
such as `@`, `{`, `[`, `]`, `}`, `\`, `|`, and `~` can be typed on a German
keyboard. Note the discriminator: an Alt chord is only treated as AltGr when
the delivered character is *not* the key's own base/shifted character —
otherwise a plain left-Alt chord (e.g. `Alt+.`) would type a stray `.` instead
of sending the Meta sequence.

Ctrl combinations are handled before xterm.js processes text input. The
terminal code accepts normal `ctrlKey`, tracked standalone Control keydown, and
older WebKit-style `keyCode`/`keyIdentifier` data, then suppresses the follow-up
text event so `Ctrl+C` cannot leak as a plain `c`.

xterm.js is fitted before connecting. The frontend includes initial
`cols`/`rows` in the `connect` payload and sends Luna `resize` calls after
later fits. The service passes the initial dimensions into `ssh2.shell()`;
without this, remote shells often start as 80x24 and only occupy the upper
left portion of the visible terminal.

The terminal wrapper can reserve a TV overscan safe area in CSS via
`--tv-safe-*` variables. Fullscreen mode still fills the whole WebView, but the
terminal content remains slightly inset. xterm.js can still leave a few pixels
unused because columns/rows are whole terminal cells; keep horizontal centering
and vertical centering enabled so the remainder is split instead of appearing
as a one-sided right/bottom bar.

Launcher icon metadata should use hex colors, not color names. Some recent
webOS builds show a launcher "rendering error" when `iconColor` is set to a
named color such as `black`.

JetBrains Mono is bundled under `assets/fonts/` for terminal readability.
The build script includes assets in the staged app, and esbuild copies the
WOFF2 referenced from CSS into `dist/assets/`.

## Service

The service uses `webos-service`, which the webOS platform exposes from
a system path. **Do not** add it to `service/package.json`. Locally,
`require("webos-service")` will fail; this is expected. To smoke-test
parts of the service code in isolation, factor pure helpers (e.g. PEM
parsing) into separate files and exercise them with plain Node.

The ssh2 native bindings (`cpu-features`, `nan`) are optional — ssh2
falls back to pure JS. The build script runs `npm ci --omit=dev` and prunes
host-native `.node`, build, test, and GitHub workflow artifacts from the
staged service dependencies. This avoids shipping x86-64 native modules to
the TV.

`connect` and `attach` are subscription-style Luna methods. `connect`
creates a session and emits `{event:"status", stage:"connecting"}`, then
`ready`, `data`, `close`, or an error. Subscription cancellation is only a UI
detach; it must not close SSH. `disconnect` is the explicit close path.

The service keeps active sessions in memory with a bounded terminal-output
ring buffer. `sessions/list` returns non-secret metadata, and `attach` replays
the buffered output before forwarding live events. A service restart still
loses active SSH sessions.

Diagnostic methods `debug/info`, `debug/logs`, `debug/clear`, `debug/enable`,
`debug/disable`, and `debug/event` are registered in the service. Logging is
disabled by default in normal builds. Enable it either from the UI with
`Ctrl+Alt+D`, by calling `debug/enable`, or by launching the service with
`SSHCLIENT_DEBUG=1`. When enabled, service and UI events are appended as JSON
lines to `$HOME/.sshclient/debug.log` (or
`$SSHCLIENT_STORAGE_DIR/debug.log` when that environment override is set). The
logger redacts keys named like password, passphrase, private key, PEM, or
secret before writing.

When at least one SSH session exists, the service calls
`service.activityManager.create("openclaw.sshclient.active-session", ...)` and
sets the JS-service idle timeout to one hour. When the last session closes, it
completes that activity and restores the short idle timeout. This is required
because the webOS JS service library normally exits idle services after a short
timeout, even if the app intends to reattach later.

## Key storage on the device

Keystore root: `$SSHCLIENT_STORAGE_DIR` if set, otherwise
`$HOME/.sshclient`. Layout:

```
$HOME/.sshclient/
├── keys.json              # [{id, label, type}]
└── keys/
    ├── <id>.pem           # private key, mode 0600
    └── <id>.pass          # passphrase if user opted to store one
```

The user picks a key by `id`; the PEM never leaves the service.
LocalStorage on the frontend only persists the connect form fields and
the last-used `keyId`.

## Logs from the device

The preferred debug path is in-app: open the overlay, press `Ctrl+Alt+D`, then
use `Refresh` and send the visible JSON-lines log. That shortcut enables
logging for the running app/service. The panel prints the exact file path;
normally it is `$HOME/.sshclient/debug.log` in the webOS service environment.

```bash
ares-log --device tv com.pwntastic.sshclient.service
ares-log --device tv com.pwntastic.sshclient
```

`stdout` and `stderr` from the service appear in the journal; the app
prints to the WebView console (use the dev tools that come with
`ares-inspect`):

```bash
ares-inspect --device tv --app com.pwntastic.sshclient
```

Root-shell smoke tests that bypass the UI:

```sh
luna-send -n 1 luna://com.pwntastic.sshclient.service/ping '{}'
luna-send -n 2 luna://com.pwntastic.sshclient.service/connect \
  '{"host":"127.0.0.1","port":1,"user":"x","auth":{"type":"password","password":"x"}}'
```

The first `connect` response should be the `connecting` status event. See
`docs/TROUBLESHOOTING.md` for the full diagnostic flow.

## Bumping versions

Keep these versions in sync when bumping:

- `appinfo.json`
- root `package.json` and `package-lock.json`
- `service/package.json` and `service/package-lock.json`

webOS uses the app `version` for upgrade detection.

## Releasing a tag

After a smoke test passes on the TV:

```bash
git tag -a v0.1.0 -m "First working SSH client release"
git push origin v0.1.0
```
