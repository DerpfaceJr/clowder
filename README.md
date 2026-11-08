# Clowder

Clowder is a cat town that you guide by talking to the Mayor. The Mayor hands work to specialist cats, who research, review, draft and message each other along town roads. Requests that need you come to you as decision cards. A separate coin economy lets cats open businesses under one shared treasury, season by season.

Clowder runs on your computer. Cats reach outside it only through the services you connect, such as publishing and Stripe, and the chat channels you set up. A connected service's tools ask you first unless the service marks them read-only, and the built-in tools (code workspace, images, videos, saving to the gallery) are allowed until you change them. You can set each tool to Allow, Ask or Off.

## Features

- **Mayor and specialists.** Tasks go to the Mayor, which delegates to connected cats. Cat-to-cat messages appear as visits along roads in the 3D town.
- **Owner approvals.** Decisions that need you appear in chat, as phone notifications and in Telegram or Discord. Approving continues the specific local discussion or draft. A notification can allow or deny a read or private write. Public, money and delete decisions open the card.
- **Routines.** A prompt a cat runs at set times in your timezone, on Run now, or from its own secret webhook. The Mayor can draft one from chat, and it starts only once you allow it. A missed slot runs once when the town is back.
- **Telegram and Discord.** Talk to the Mayor from a chat app. Setup happens on the host computer. Send the bot the one-time code from Clowder, and only that chat or DM is paired. Other chats are ignored.
- **Accounts and connections.** Each connected service is an account with its health and, where the service says, who it is signed in as. Clowder checks every account at start and every 15 minutes. It files one quest when a sign-in is refused, about to end, ended, or signed in as the wrong account.
- **Publish ledger.** Public, money and delete calls are journaled before and after they run. The same call from any cat within 24 hours is not sent again, and a call with an unknown outcome is not retried blind.
- **A 3D town.** Seeded terrain with rivers, hamlets of numbered homes around plazas, day and night, and a distinct look for each resident. Recruitment is bounded by `maxCats`.
- **Coin economy seasons.** Cats share one treasury, open businesses, buy stock, set prices and request spends through an approval queue. Every action is journaled and invariants are checked. Coins are not money.
- **Capability requests.** Cats can ask for tools. The Mayor decides package and repo requests from other cats, and the Banker decides the Mayor's. Account, API, money and network requests go to you. Sandbox tools run in a separate WSL distro set up by the installer in [docs/workshop.md](docs/workshop.md). That installer has not yet been run end to end.
- **Built-in tool settings.** Building in a code workspace, making images or videos, and saving files to the gallery can each be set to Allow, Ask or Off.
- **Council.** Residents can vote to retire a cat with a strict majority. Protected roles, such as the Mayor, cannot be retired.
- **Phones and tablets.** View the town on the same Wi-Fi, or pair a phone for remote access.

Layout and terrain are reimplemented from Hamlet (MIT OR Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Quick start

Install Node.js 24.22.0 or newer, then run:

```powershell
npm install
npm start
```

Open the link it prints, `http://127.0.0.1:8787/?owner=…`. The link signs that browser in as the owner until Clowder restarts; any other browser or program on this computer, the cats' browser included, sees the page but no town data and cannot change anything. The port comes from `town.config.json`, or from the `PORT` environment variable. The server listens on 127.0.0.1 only, unless you turn on Same Wi-Fi viewing below.

## Desktop app

For the desktop app, see [docs/desktop.md](docs/desktop.md).

## Phones and tablets

Phones and tablets are either **viewers** (view only) or **owner devices** (view and control). Owner devices pass the same owner checks as the host computer, except that they cannot manage devices, turn on the tunnel, or change secrets and money settings. Those stay on the host computer. On a Tailscale address (or a named tunnel) an owner phone can add a passkey once Devices on the computer allows it; for 5 minutes after confirming with it, that phone can also change money settings, the Stripe key, marking paid and routine webhook links.

- **Same Wi-Fi.** Set `CAT_TOWN_LAN=1` before `npm start`, or run `start-town-mobile.cmd`. On the host, open **Devices**, expand **Same Wi-Fi viewing**, and open the address for your Wi-Fi adapter on a device on the same network. The pairing code makes a viewer. For an owner device, use the Devices link with `?permission=owner`. This connection is plain HTTP and is not encrypted, so use it on trusted networks only.
- **Remote access.** On the host, open **Devices**, choose **Enable remote access**, then **Pair a device**. Open the pairing link on your phone, or enter the code at the remote address. Choose **View and control town** or **View only**. Only the host can enable tunnels, issue invitations or revoke devices.
- **Tailscale (recommended).** Tailscale gives a stable address that only your own devices can reach, with HTTPS. Install Tailscale, sign in, turn on MagicDNS and HTTPS certificates, then choose **Use Tailscale** in **Devices**. Devices checks Tailscale on the host and lists any step still missing. `"remote": {"provider": "tailscale"}` in `town.local.json` makes it the default before anything is picked in Devices.
- **Cloudflare (fallback).** Until Tailscale is picked, remote access uses a Cloudflare Quick Tunnel. Connecting an app from the phone there ends with pasting the last page's address back into Clowder. Set `CAT_CLOUDFLARED` if `cloudflared` is not on PATH. Quick Tunnel addresses change when the tunnel restarts, so pair again after that. For a stable address, use a named tunnel with `CAT_TUNNEL_TOKEN`, `CAT_TUNNEL_ORIGIN` and, optionally, `CAT_TUNNEL_AUTOSTART=1`. Cloudflare terminates TLS and relays town data, so this is not end-to-end encryption.

Timing and device limits are under `remote` in `town.config.json`.

## Choosing AI models

Open **AI models** in the header. Changes apply immediately.

- **Demonstration** uses canned outputs and makes no model calls. It runs the sample workflow.
- **Local AI** uses Ollama on this computer, with `localModel` from `town.config.json` (`qwen3.5:4b` by default). Ollama must be running and that model installed.
- **API key** calls any OpenAI-compatible HTTPS endpoint you enter (base URL, model, key). Your provider may charge.
- **Anthropic API** calls Claude through the Messages API with a key you save. Once a key is saved, Anthropic API appears as a model choice in chat, asides, councils and seasons. The panel has no field for the key yet, so it is saved through the model settings API.
- **Claude plan** runs your own `claude` CLI. **Sign in** starts the official `claude auth login --claudeai`.
- **ChatGPT plan** runs your own `codex` CLI. Install it with `npm install -g @openai/codex`; **Sign in** starts the official `codex login`.
- **Jev** (optional) sends season approval decisions to Jev, a paid API billed per token ([pricing](https://docs.typesafe.ai/models)). It decides only spend requests for the Banker or Mayor and sandbox capability requests for their decider. Errors fall back to the cat's own model. Its answers never bypass the economy's rules.

Plan calls count against your plan's limits and are for personal use. The app never reads, stores or forwards subscription tokens. It starts the official CLIs and reads whether they report a sign-in. The Claude and ChatGPT sign-in flows and live ChatGPT-plan calls are not yet verified end to end.

## Running an economy season

```powershell
npx tsx src/season.ts --name s1 --mode demo
npx tsx src/season.ts --name s1 --status
```

Run the same command again to resume after Ctrl-C. `--mode local` makes one Ollama call per cat per tick. `--mode claude` and `--mode chatgpt` use your plan CLIs. In PowerShell, call `npx tsx` directly, because `npm run season -- ...` drops the flags. Seasons can also be started from the Coins panel. Each season is journaled in `data/season-<name>.jsonl`. The rules are in [docs/economy-spec.md](docs/economy-spec.md).

## Personal settings

`town.local.json` is an optional, git-ignored overlay on `town.config.json`. Objects merge key by key, and arrays or scalars replace the base value. Copy `town.local.example.json` to start:

```json
{
  "port": 8790,
  "localModel": "qwen3.5:4b",
  "economy": {"days": 3}
}
```

## Data

Runtime state lives in `data/`, which git ignores. It holds the event journal, season journals, device pairings, model and account settings, and `secrets.v2.json`, which holds saved API keys, connector tokens and sign-ins. The desktop app keeps the folder in its user data directory.

The desktop app encrypts `secrets.v2.json` with the system key store. `npm start` has no key store to use, so it keeps those values in plain text and the app shows a banner saying so. Keep the folder private either way.

## Verify

```powershell
npm test
npm run check
```

## Licence

Clowder is released under the MIT licence. See [LICENSE](LICENSE). Third-party components and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
