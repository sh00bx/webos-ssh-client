# Troubleshooting

This page documents the fastest checks for the current webOS SSH client MVP.
Use root shell commands on the TV when possible; they remove the WebView from
the equation.

## Confirm the Installed Build

Developer Manager and same-version IPK installs can leave stale frontend files
on the TV. Always bump `appinfo.json:version` for testable upgrades, or
uninstall before reinstalling.

```sh
grep '"version"' /media/developer/apps/usr/palm/applications/com.pwntastic.sshclient/appinfo.json
find /media/developer/apps/usr/palm -type f \
  \( -path '*com.pwntastic.sshclient*/dist/main.js' \
     -o -path '*com.pwntastic.sshclient.service/service.js' \) \
  -print 2>/dev/null
```

If you add a temporary build marker in `src/main.js`, verify it from the
installed `dist/main.js` before trusting UI behavior.

## Check the Luna Service

The service should start on demand:

```sh
luna-send -n 1 luna://com.pwntastic.sshclient.service/ping '{}'
```

Expected shape:

```json
{"returnValue":true,"pong":1777249408478}
```

Check `connect` without the UI:

```sh
luna-send -n 2 luna://com.pwntastic.sshclient.service/connect \
  '{"host":"127.0.0.1","port":1,"user":"x","cols":120,"rows":40,"auth":{"type":"password","password":"x"}}'
```

Expected first response:

```json
{"returnValue":true,"event":"status","sessionId":"...","stage":"connecting"}
```

If `ping` works but the UI only shows `Connecting to ...`, debug the WebView
bridge or frontend JavaScript first. If direct `connect` hangs after the status
event too, debug `ssh2`/network/authentication in the service.

## Common Failure Modes

- **Connect button appears to do nothing**: hidden form controls can still block
  native submit validation. In password mode, the public-key selector must be
  disabled and not required. Newer builds avoid native form controls on the
  connect screen entirely.
- **UI prints only `Connecting to ...`**: the frontend likely did not receive a
  Luna callback. `src/luna.js` supports both `webOS.service.request` and
  `PalmServiceBridge`; use `ares-inspect` to check WebView console errors.
- **Remote shell only fills the upper-left area**: run `stty size` in the SSH
  session. The frontend should send initial `cols`/`rows` during `connect` and
  resize again after xterm.js fits. If the value stays near `24 80`, inspect
  frontend resize/Luna calls first.
- **Ctrl+C prints `c` instead of interrupting**: verify the installed
  `dist/main.js` contains `CONTROL_STATE_TTL_MS`. The terminal input layer must
  track a standalone Control key and suppress the follow-up `keypress`/`input`
  event, because some webOS WebViews do not set `event.ctrlKey` on the letter
  event from a USB keyboard.
- **Launcher shows "rendering error" instead of the icon**: verify
  `appinfo.json` uses a hex `iconColor` such as `"#000000"`, not a named color.
- **Virtual keyboard appears on the connect screen**: check the installed
  `dist/main.js` for `fake-input`, and verify those elements do not have
  `role="textbox"`. The connect UI should not contain native `<input>` or
  `<select>` controls.
- **Virtual keyboard appears in the terminal**: verify `dist/main.js` contains
  `term-frame` and `xterm-helper-textarea`. The terminal should focus the frame
  and disable/fence off xterm.js' hidden textarea while sending translated USB
  keyboard events directly.
- **German USB keyboard types US characters**: verify `dist/main.js` contains
  `codeToLegacyCode` and `AltGraph`. The layout is detected from the browser/TV
  locale only — there is no `KB` button and no override setting, so if the TV
  reports a non-German locale the DE mapping will not engage. The fallback path
  in `src/keymap.mjs` maps `event.code`/legacy `keyCode` events as German
  QWERTZ before trusting `event.key`, and treats AltGr as printable input, not
  as the app's Ctrl+Alt shortcut layer.
- **A few terminal pixels are cropped at the TV edge**: adjust the
  `--tv-safe-*` values in `src/styles.css` and rebuild. The fullscreen wrapper
  still covers the whole WebView; only terminal content is inset.
- **Service crashes on connect**: do not use `message.on("cancel")`; webOS
  service cancellation belongs in the third `service.register` argument.
- **Works locally, fails on TV before SSH**: ensure the staged IPK does not ship
  host-native `.node` files from optional `ssh2` dependencies.
- **Overlay opens full-screen instead of above video**: verify the installed
  `appinfo.json` contains `defaultWindowType: "overlay"` and
  `transparent: true`. Restart SAM or reboot the TV if the installed manifest
  is correct but behavior did not change.
- **Session disconnects when hiding the overlay**: check
  `tests/service-connect.test.js` expectations and installed `service.js`.
  Luna subscription cancellation should remove only the UI subscriber; only
  `disconnect`, remote close, or service restart should end SSH.
- **Relaunch returns to login after hiding**: check for a new `service_start`
  PID after `ui_pagehide`. If the PID changes and `sessions_list` returns
  `count:0`, the service was stopped while hidden. With diagnostics enabled, a
  successful active-session protection path logs `keepalive_create_request`,
  `idle_timeout_set`, and `keepalive_created` after `connect_request`.
- **Terminal font changes after hide/relaunch**: the terminal uses a dedicated
  `Pwntastic Terminal Mono` font face loaded from
  `assets/fonts/JetBrainsMono-Regular.woff2` before xterm.js initializes. The
  diagnostics should include `ui_terminal_font_ready`; if it reports
  `timedOut:true` or an error, verify the bundled WOFF2 file is present in the
  installed app.
- **Diagnostics**: press `Ctrl+Alt+D` to enable logging and open the in-app
  debug panel. It records UI lifecycle events, webOS relaunch/hide events,
  service process start, attach/detach, SSH close reasons, and session counters
  as JSON lines. Passwords, key passphrases, private keys, PEM data, and fields
  named like secrets are redacted. Logging is disabled by default.

## Logs

Prefer the in-app debug panel first. It shows the exact persistent log path,
normally `$HOME/.sshclient/debug.log` for the service process. Use `Refresh`
after reproducing the issue, then copy or photograph the panel output.

From a workstation with Ares configured:

```bash
ares-log --device tv com.pwntastic.sshclient.service
ares-log --device tv com.pwntastic.sshclient
ares-inspect --device tv --app com.pwntastic.sshclient
```

On rooted TVs, journal tooling varies by firmware. If Ares logs are not
available, prefer the direct `luna-send` checks above and then inspect WebView
console output with `ares-inspect`.

## Packaging Sanity Check

After `./scripts/build.sh`, verify the IPK does not contain native/test build
artifacts:

```bash
ar p build/com.pwntastic.sshclient_*.ipk data.tar.gz \
  | tar -tzf - \
  | grep -E '\.node$|/build/|/test/|/tests/'
```

No output is expected.
