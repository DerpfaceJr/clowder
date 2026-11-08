# Clowder desktop app

Clowder is the Cat Town server in a Windows window. Double-click it and the town opens. No terminal, no browser.

## Run it from the repo

```
npm.cmd install
npm.cmd run desktop
```

Dev runs keep using the repo's `data/` folder, the same as `npm start`.

## Build the installer

```
npm.cmd run desktop:build
```

Output goes to `dist-desktop/`:

- `dist-desktop\Clowder-Setup-0.1.0.exe`, the NSIS installer, with its `.blockmap` and `latest.yml`.
- `dist-desktop\win-unpacked\Clowder.exe`, an unpacked build you can run without installing.

A local build has no code signing, so Windows SmartScreen may warn on first run. It never checks for updates: `node scripts/check-desktop-build.mjs` confirms it carries no update marker.

## Releases and updates

A `v*` tag on the public repo runs `.github/workflows/release.yml`: it checks the tag against `package.json`, runs tsc and the tests, then builds, signs (Azure Artifact Signing) and uploads the installer, `.blockmap` and `latest.yml` to a draft release. Publish the draft once the run is green. The owner's setup is in [release-signing.md](release-signing.md).

Release builds check GitHub for a newer version every 6 hours and download it in the background. An update installs only while no task or season is running: Clowder offers "restart now" or "at next quit", and stops the server before the installer starts. A download not signed by the publisher in the build is refused. The new version's first start snapshots the data into `backups\pre-<commit>-<time>\` before anything else runs. The icon is Electron's default placeholder. Node 22.12 or newer is needed to install Electron 45.

## Where data lives

- Installed or unpacked builds: `%APPDATA%\Clowder\data`.
- Dev runs: the repo's `data\` folder.
- The app never copies or changes `C:\cat-town\data` on its own.

To point Clowder at the existing town data, set `CAT_TOWN_DATA` before launching:

```
set CAT_TOWN_DATA=C:\cat-town\data
"%LOCALAPPDATA%\Programs\Clowder\Clowder.exe"
```

Use `setx` if you want it set for every launch. The server log for the latest launch is `%APPDATA%\Clowder\server.log`.

## Cats' workshop and WSL

The installer asks once whether to install Windows Subsystem for Linux, which the cats' sandbox needs. Nothing is enabled without that Yes: the installer runs `wsl.exe --install --no-distribution` elevated, and Windows asks for permission. If Windows asks for a restart, the workshop finishes setting itself up the next time Clowder opens after it. The Workshop card in AI models has the same **Install WSL** button and explanation if you said no. Once WSL is present, the workshop (the `cat-workshop` distro) is set up in the background at each start. The owner can turn that off in the Workshop card. See [workshop.md](workshop.md).

Not verified on a real machine yet: the installer's WSL check and restart message, and the exit behaviour of `wsl.exe --status`.

## Phones

Phones pair the same way as before. Open **Devices** (in the Clowder menu, or the Devices button in the town), turn on remote access, and pair a device. Quitting Clowder stops remote access, so phones cannot connect until you start it again.

## Quitting

Closing the window or choosing Quit stops the server, its season runs and the tunnel. On Windows this uses `taskkill /T /F`, which is forceful. If Clowder is killed from Task Manager, the server can be left running. Check for `cloudflared.exe` and `node.exe` when this happens.

## Limits

- No tray icon. Devices is in the app menu.
- The town's own page still says "cat town" in its header. That text lives in `public/`.
- The app is not code signed, and the icon is Electron's default.
