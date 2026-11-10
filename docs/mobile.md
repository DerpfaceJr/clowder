# Install Clowder on your phone

Clowder installs to your home screen and opens full screen, without the browser bar.

## Before you start

1. On the computer running Clowder, turn on remote access (Settings, the ☰ button, then Devices, then Enable remote access).
2. Open Devices, choose Pair a device, and copy the code. Codes work once.

## Android (Chrome)

1. Open the Clowder address in Chrome.
2. On the "Pair this phone" screen, type the device name and the code, then tap Connect to town.
3. Tap the menu button, then Install app, then Install.
4. Open Clowder from the home screen.

## iPhone (Safari)

1. Open the Clowder address in Safari. Other iPhone browsers do not install Clowder reliably.
2. Pair the phone as above.
3. Tap the menu button, then Install app. Follow the sheet: tap Share, then Add to Home Screen.
4. Open Clowder from the home screen. If it asks for the code again, type it there. The home-screen app can keep its own sign-in separate from Safari.

## The address changes with the quick tunnel

The default tunnel gives the town a new address every time it restarts. The Clowder Android app follows the new address by itself (docs/android.md). An installed web app keeps the old address, so after a restart open the new address, pair the phone again, and install again.

A stable address fixes this. Use Tailscale (below), or a Cloudflare named tunnel set with CAT_TUNNEL_TOKEN.

## Tailscale: a stable private address

Tailscale gives the town one address, `https://<pc-name>.<tailnet>.ts.net`, that stays the same across restarts. It is reachable only from devices signed in to your tailnet, not from the public internet.

1. Install Tailscale on the PC and on the phone. Sign in to both with the same account.
2. In the Tailscale admin console, open DNS. Turn on MagicDNS and "HTTPS Certificates".
3. Start the town and open Devices. Tailscale comes first: it is checked on this PC, any missing step is listed, and once it is ready the address is shown. Choose Use Tailscale, then Enable remote access. The Tailscale card says "In use" and shows the private address.

   To make Tailscale the default before anything is picked in Devices, add the provider to the town's gitignored `town.local.json`: `{ "remote": { "provider": "tailscale" } }`. What is picked in Devices wins after that; it is kept in `remote-settings.json` in the data folder.

4. Quick Tunnel stays below it as the fallback. Switching between the two while remote access is on restarts it on the new address, so phones pair again there.
5. Pair the phone as above. Keep the Tailscale app connected on the phone; with it on, the home-screen app keeps working after restarts.

Clowder runs `tailscale serve` on port 443 and only that. It never uses `tailscale funnel`. Turning off remote access removes that one serve entry.

## Passkey: money settings from the phone

Money settings, the Stripe key, marking a purchase paid and new routine webhook links stay on the computer. On a stable address (Tailscale, or a Cloudflare named tunnel) a phone paired with control can change them too, after confirming with a passkey:

1. On the computer, open Devices and choose Allow a passkey under the phone. This works for 5 minutes, so a phone taken while paired cannot add its own.
2. On the phone, open ☰ Settings, Devices, Passkey, and choose Add a passkey.
3. Before changing one of those settings, open Passkey and choose Confirm it's you. The phone can change them for the next 5 minutes.

A passkey works only for the address it was made on, so a Quick Tunnel, whose address changes on every restart, never offers one. Remove passkey in Devices, or revoking the phone, ends it at once. Device management, the tunnel and Telegram or Discord bot tokens stay on the computer either way.

## Pairing lasts 30 days

A paired phone stays connected for 30 days. A phone used at least once a month stays paired. Otherwise, pair it again from Devices on the computer.
