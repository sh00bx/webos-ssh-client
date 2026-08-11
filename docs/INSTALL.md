# Installation

## The short path: Homebrew Channel

On a rooted TV, add this repository once in *Homebrew Channel → Settings →
Add Repository*:

```
https://raw.githubusercontent.com/sh00bx/webos-apps/main/repo.json
```

`webossh` then appears in the app list and installs and updates from there.
Nothing else is needed: the two root helpers (`ptyd`, `backdropd`) are inside
the IPK and install themselves on first start (see "Root helpers" below).

The rest of this document is the build-it-yourself path.

## Building and installing yourself

This app installs as a regular IPK. Two paths are documented: LG webOS
Dev Mode (the simplest one for a single TV) and Homebrew Channel
(for rooted TVs with `webosbrew` already installed).

The transparent overlay mode uses Homebrew/rooted-webOS window metadata
(`defaultWindowType: "overlay"`). On a plain Dev Mode install, the app can
still run, but firmware may treat it as a normal foreground app.

## Prerequisites

- TV with Developer Mode enabled (or rooted with Homebrew Channel).
- A USB keyboard plugged into the TV (the app expects one — there is no
  on-screen keyboard).
- LG developer SSH key/passphrase if you use Dev Mode (LG provides this
  through the Developer Mode app on the TV).
- A workstation on the same network as the TV.

## Workstation setup

Install LG's webOS CLI tools globally:

```bash
npm install -g @webosose/ares-cli
```

Verify:

```bash
ares-package --version
ares-setup-device --version
```

## Configure the TV as a target device

### Option A: Dev Mode (signed by LG)

1. Install the **Developer Mode** app from LG Content Store and sign in
   with your LG developer account.
2. Open the app on the TV → toggle "Dev Mode Status" → "Key Server" on.
   Note the IP address shown.
3. On the workstation:

   ```bash
   ares-setup-device --add tv --info '{
     "name":"tv",
     "host":"<tv-ip>",
     "port":9922,
     "username":"prisoner",
     "privateKey":"webos_rsa",
     "passphrase":"<from LG dev portal>"
   }'
   ```

   The `webos_rsa` key is fetched from the TV via the key-server URL
   (`http://<tv-ip>:9991/webos_rsa`). Save it under `~/.ssh/webos_rsa`
   first, or pass `--info '{"privateKeyPath":"~/.ssh/webos_rsa", ...}'`.

4. Verify connectivity:

   ```bash
   ares-shell --device tv -r 'uname -a'
   ```

### Option B: Homebrew Channel / rooted TV

If the TV runs RootMyTV / webosbrew, SSH and IPK installation are
already enabled on a different port (commonly 22 or 9922 depending on
the jailbreak). Add the device with the credentials your jailbreak
documentation provides; the rest of the workflow below is the same.

## Build and install

```bash
git clone https://github.com/sh00bx/webos-ssh-client.git
cd webos-ssh-client
npm ci
( cd service && npm ci )
./scripts/build.sh
./scripts/install.sh
```

`scripts/install.sh` runs `ares-install` and then `ares-launch`. After
`ares-launch`, the app should appear on the TV.

## Verify

- App icon visible in the TV's Launcher.
- Installed app version matches the IPK:

  ```sh
  grep '"version"' /media/developer/apps/usr/palm/applications/com.pwntastic.sshclient/appinfo.json
  ```

- Connect to a known SSH host with username/password — `uname -a`
  in the resulting shell prints kernel info.
- `Ctrl+C` interrupts a foreground command instead of sending a literal `c`.
- `stty size` inside the SSH session roughly matches the visible terminal.
- On a German USB keyboard, `z`/`y`, `ß`, umlauts, and AltGr characters such
  as `@`, `{`, `[`, `]`, `}`, `\`, `|`, and `~` type correctly. The layout is
  detected from the TV/browser locale; there is no in-app switch.
- Launch the app over YouTube or an HDMI input: the SSH panel should appear
  above the running video/source instead of replacing it.
- `Ctrl+Alt+H`, webOS Back, or the `Hide` button hides the overlay without disconnecting; relaunching
  the app should reattach to the same session and replay recent terminal
  output.
- `Ctrl+Alt+D` enables diagnostic logging and opens the in-app debug panel. It
  shows the resolved service log path, normally `$HOME/.sshclient/debug.log`.
- `Esc` is passed through to SSH so full-screen shell apps can use it.
- The webOS virtual keyboard does not appear on the connect screen when
  using a USB keyboard.
- `Ctrl+Alt+Q` cleanly closes the session and returns to the form.

## Update

Rebuild and re-install:

```bash
./scripts/build.sh
./scripts/install.sh
```

`ares-install` upgrades the existing IPK if the `id` and `version` in
`appinfo.json` change. Bump `version` in both `appinfo.json` and
`service/package.json` for clean upgrades. Also keep the root and service
lockfiles in sync.

If Developer Manager appears to install successfully but the TV still runs
old frontend code, uninstall the app first and then install the new IPK.
Same-version installs have been observed to leave stale
`/media/developer/apps/usr/palm/applications/com.pwntastic.sshclient/dist/main.js`
content behind.

If the app still launches as a full-screen foreground app after an overlay
manifest change, restart SAM or reboot the TV so cached `appinfo.json`
metadata is refreshed.

## Root helpers (`ptyd`, `backdropd`)

Both binaries ship inside the IPK. On every app start, the frontend asks the
Homebrew Channel service to run a short shell command as root
(`org.webosbrew.hbchannel.service/exec`, the same root that installed the app)
which copies them to `/var/lib/webosbrew/`, installs the boot hooks
`47-backdropd` and `48-ptyd`, and starts whichever is not running. It compares
before it copies, so a normal start changes nothing and restarts nothing.

To see what it decided:

```sh
ls -l /var/lib/webosbrew/ptyd /var/lib/webosbrew/backdropd
cat /tmp/.sshclient-ptyd/ptyd.pid /tmp/backdropd.pid
```

or turn on the in-app log with `Ctrl+Alt+D` and look for `root_helpers_ready`
(`hb=0` there means no Homebrew Channel, i.e. no root path — SSH sessions still
work, the local shell and the adaptive theme do not).

### Why a helper is needed at all

The IPK alone cannot open a local shell. The service is chrooted into
`/var/palm/jail/com.pwntastic.sshclient.service/` as uid 5301 with no
capabilities, and that jail's `/dev` contains only `console`, `log`, `logdir`,
`null`, `shm` and `urandom` — no `ptmx`, no `pts`. Opening `/dev/ptmx` from
inside it returns `ENOENT`, so `openpty()`, `forkpty()` and the busybox
`script` applet all fail there. `tv-root/ptyd.c` runs outside the jail as root
and hands the pty back over a unix socket.

### Pushing a freshly built `ptyd` while working on the C

```bash
TV_HOST=<tv-ip> TV_KEY=~/.ssh/<key> scripts/install-ptyd.sh
```

That builds the binary (Bootlin armv5 musl toolchain, static), copies it to
`/var/lib/webosbrew/ptyd` with the boot hook `/var/lib/webosbrew/init.d/48-ptyd`,
starts it, and prints the socket so you can see it came up with the right
owner. Load a passphrase-protected key into an `ssh-agent` first — the script
does not prompt.

Verify by hand:

```sh
ls -l /tmp/.sshclient-ptyd/ptyd.sock    # srw------- <service-uid> jailer
cat /tmp/.sshclient-ptyd/ptyd.pid
```

If the socket is owned by `root` instead of the service uid, the app has never
run on that TV: launch it once, then re-run the script. `ptyd` derives the
owner from `/media/internal/.com.pwntastic.sshclient`, which the service
creates on first start.

Remove it with `scripts/install-ptyd.sh --uninstall` — that also removes the
boot hook, so the next app start reinstalls both from the IPK payload.

Anything that can open that socket gets a root shell. The socket's owner is the
gate: `ptyd` chowns it to whoever owns
`/media/internal/.com.pwntastic.sshclient` (the app's own storage directory)
and leaves it at mode 0600 inside a 0700 directory, so the kernel does the
access control.

## Uninstall

```bash
ares-install --device tv --remove com.pwntastic.sshclient
```

On a rooted TV, the same app files are usually under:

```sh
/media/developer/apps/usr/palm/applications/com.pwntastic.sshclient
/media/developer/apps/usr/palm/services/com.pwntastic.sshclient.service
```
