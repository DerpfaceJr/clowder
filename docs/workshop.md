# Workshop sandbox

`scripts/workshop/install-workshop.ps1` builds a WSL2 distro named `cat-workshop` and installs the tools the Mayor approved. Rules: [workshop-spec.md](workshop-spec.md).

## What it does

- Downloads Ubuntu 24.04.5 base from the official cdimage server and checks its SHA256 against a pinned value.
- Imports it as `cat-workshop` with automount and interop off, and creates a non-root user, `catworker`.
- Reads the newest `data/season-*.jsonl` and installs each `capability.requested` that has a matching `capability.decided` with `approved: true`, sandbox tier only.
- Installs inside the distro only: npm with `--ignore-scripts`, pypi wheels only, and `git clone --depth 1`. Licences must be MIT, Apache-2.0, BSD or ISC.

## Run

```
powershell -ExecutionPolicy Bypass -File scripts\workshop\install-workshop.ps1
powershell -ExecutionPolicy Bypass -File scripts\workshop\install-workshop.ps1 -Status
```

WSL2 must already be installed. The script does not install it.

Progress is saved to `%LOCALAPPDATA%\cat-town\workshop\state.json` after each step, so running it again resumes. Results are appended to `data/workshop.jsonl`.

## Status

The script was handed back and has not been run. Its header lists what was not tested.

## How the town uses it

- `src/workshop.ts` is the only code that starts `wsl.exe`. Every call is an argv array with `-d cat-workshop -u catworker`; no shell sees model or owner text.
- `status()` reports whether the distro exists and whether it is isolated. Isolated means `/mnt/c` and the WSL interop entry are both absent. `install()` and `run()` check this fresh each time and refuse otherwise.
- The Workshop card in AI models lists approved tools with their state. Install is enabled only for approved tools that are missing or failed, and only when the distro is isolated. If the distro is missing, the card shows the command to run by hand.
- Each install writes a record to `data/workshop.jsonl`. The record's `entry` is the only command a tool can run. npm tools use `node_modules/.bin/<unscoped name>`, pypi tools use `bin/<name>`, and repo tools get their entry from an approved run recipe (below). Until a recipe is approved, a repo is installed but not runnable.
- A cat with an installed tool sees it in `installedTools` and may call `use_tool` with up to 8 text args. Runs take 60 s at most and keep 4 KB of output. A run never changes coins; its output is logged as the action result. Demo mode never runs a tool.
- Owner routes, main app only: `GET /api/workshop`, `POST /api/workshop/install`, `POST /api/workshop/setup` (Create workshop), `POST /api/workshop/install-wsl` (needs `{"confirm":true}`), `POST /api/workshop/settings` (`autoSetup`, `allowLongJobs`), `POST /api/workshop/recipe` (the owner decides a recipe that waits for them).

## Automatic setup

- At server start, if WSL is present (`wsl.exe --status` exits 0) and the distro is missing, the installer starts in the background as a child process with argv only. Startup does not wait for it. `town.config.json` `workshop.autoSetup` defaults to true; the owner's choice in the Workshop card wins over the config.
- The card shows the installer's last lines, and a toast says "Setting up the cats' workshop…" once when it starts.
- A failed setup raises one quest with its error and a Retry action. It is retried on a later start, once due: 15 minutes after the failure, doubling for each further failure, up to a day. Each start tries at most once. Create workshop retries at any time.
- Without WSL, Create workshop refuses and shows `wsl --install`. Install WSL asks first, then starts `wsl.exe --install --no-distribution` elevated through Windows.

## Run recipes and output

- A repo request becomes runnable through `define_repo_tool`, which a cat (or the Mayor) proposes. The recipe is argv only: an allowlisted program (`python3`, `pip`, `node`, `npm`, `npx`, `bash`, `sh`, `make`) or a file path inside the repo, with no `-c`, `-e` or `-p`, and no path that leaves the repo. The Mayor decides it, or the owner when autonomy is cautious.
- Approving a recipe runs its setup steps once (at most 8), with `npm` given `--ignore-scripts` and `pip` given wheels only. Then the entry is recorded and `use_tool` can run it.
- Runs take 60 seconds unless the recipe is marked `long` and the owner allows long runs in the card. Then `timeoutSeconds` may go up to 900.
- A tool writes files to the folder named by `$CLOWDER_OUT` (`/home/catworker/work/<cat>/out`). After the run, each file of a supported type up to 100 MB is copied to the outbox, and the server moves it into the gallery. Up to 200 MB per run.
- Not enforced yet: a run is not network-isolated. The setup phase is the only install step, but a tool's own code could still open a connection. Enforcing it (for example `unshare -rn`) is UNVERIFIED on this distro and is not done.

## MoneyPrinterTurbo

- Listed in `economy.knownTools` as a repo. It needs Pexels or Pixabay keys and an LLM provider, both set in MoneyPrinterTurbo's own `config.toml`, not in Clowder.
- The Media settings have a "MoneyPrinterTurbo (local service)" provider for a MoneyPrinterTurbo already running on this computer or in the workshop. Its address must be 127.0.0.1 or localhost. The API is cited in `src/media.ts`.

Not yet verified on a real machine: the distro itself, the WSL check and restart message in the NSIS installer, WSL argument passing for hostile text, entry paths for installed packages, and the MoneyPrinterTurbo endpoints against a running instance.
