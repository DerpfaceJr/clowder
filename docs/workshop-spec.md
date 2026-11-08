# Capability spec (cats acquiring new tools)

## Goal

Cats can ask for any tool they lack. The engine assigns each request a tier from its `kind`, and cats cannot relabel the tier.

- **`sandbox` tier** (`package`, `repo`): the Mayor approves without involving the owner. Installation happens later, in the `cat-workshop` WSL distro. That distro has no Windows drives, no interop and a non-root user, and runs tools offline.
- **`owner` tier** (`account`, `api`, `money`, `network`): the Mayor escalates the request to the owner. No grant path exists until a credential gateway is built, so these requests stay visible as "needs owner".

**A capability never changes coins.** Its output is artifacts, which are logged for stories. Giving a capability a market effect first needs a deterministic rule in `economy-spec.md`.

## Engine (season journal)

**Actions:**

- `request_capability{need, purpose, kind, source?}`: any cat may request.
  - `need` is at most 120 characters and `purpose` at most 400.
  - `package` source: `npm:<name>` or `pypi:<name>`. The name matches `^(@[a-z0-9._-]+/)?[a-z0-9][a-z0-9._-]{0,80}$`.
  - `repo` source: exactly `https://github.com/<owner>/<repo>`, with each part matching `[\w.-]{1,100}`.
  - Owner-tier kinds take an optional source of at most 200 characters.
  - A cat may have one `pending` sandbox-tier request and at most 2 `needs_owner` requests, with no duplicate kind and need.
- `decide_capability{id, approved, reason}`: sandbox tier only.
  - The Mayor decides.
  - If the Mayor is the requester, the Banker decides.
  - Nobody decides their own request.
  - An owner-tier request is rejected with "only the owner can grant this".
- At most `economy.maxCapabilities` (10) approvals per season.

**Events:**

| Event | Fields |
|---|---|
| `capability.requested` | `id` (`cap<n>`), `cat`, `need`, `purpose`, `kind`, `source`, `tier` |
| `capability.decided` | `id`, `by`, `approved`, `reason` |
| `capability.escalated` | `id` (emitted with `requested` for the owner tier) |

**Status:** a sandbox-tier request is `pending`, then `approved` or `rejected`. An owner-tier request is `needs_owner`. The workshop later adds `installed` or `failed`.

**Invariants:**

- Every decision targets a pending sandbox-tier request.
- No one decides their own request.
- No owner-tier request is ever approved.
- Approvals never exceed `maxCapabilities`.

## Visibility

- `publicSeason` adds `capabilities[]`: `id`, `cat`, `need`, `kind`, `source`, `tier`, `status`.
- `seasonSummary` lists `needs_owner` requests, so the chat Mayor raises them.
- The Coins panel shows a "Needs you" list.
- The cat's model view lists its own requests.
- The prompt says owner-tier requests go to the human and may never be granted.

## Workshop (later)

Installs follow these rules:

- Run as non-root, in a separate directory per capability.
- npm installs use `--ignore-scripts`.
- pip installs use wheels only.
- `git clone` uses `--depth 1`.

The workshop checks licenses against an allowlist of MIT, Apache-2.0, BSD and ISC. Results go to `data/workshop.jsonl`. Repo text never enters a prompt as instructions.

## Run recipes (repo tools)

- `define_repo_tool{toolId, entry, workdir?, setup?, description, long?}` is an economy action. The journal records `recipe.proposed` (status `pending`, or `needs_owner` under cautious autonomy). `decide_recipe` (Mayor, or Banker for the Mayor) or the owner (`recipe.decided` with `by: "owner"`) approves or rejects it. Invariants are checked in `checkInvariants`.
- Validation lives in `src/workshop-recipe.ts`. entry and setup are argv arrays. argv[0] is an allowlisted program or a path inside the repo. Flags that run a string (`-c`, `-lc`, `-e`, `-p`, `--eval`, `--print`, `--command`, `npm exec`) are refused, and each argument is checked for absolute paths and `..`. At most 8 setup steps.
- Setup runs once inside the distro, with a 10-minute timeout per step. Network is used only here, but it is not enforced at run time (see `docs/workshop.md`).
- Output: files in `$CLOWDER_OUT` are copied through `workshop-outbox` and imported by the server. Limits: 100 MB per file, 200 MB per run, 50 files, supported types only (image, video, svg, html, markdown, text, json).
- Long runs: `timeoutSeconds` up to 900 only when the recipe is `long` and the owner allows long runs (`workshop-settings.json`, shared data folder).
