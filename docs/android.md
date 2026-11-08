# Clowder for Android

One app that stays connected to your town. Pair it once; after the computer restarts, the app finds the town's new address by itself.

## Build

Run `npm run android`. It writes `dist-android/Clowder.apk`. It uses the Android SDK and JDK that ship with Unity's Android module, or `ANDROID_HOME` if set. No Gradle and no downloads.

The signing key lives outside the repo at `%APPDATA%\Clowder\android`. Back it up. Every update must use the same key, or Android refuses to install over the old app.

## Install

1. Open `https://<your-town>/app/clowder.apk` on the phone, or copy the APK over. The APK holds no secrets, so it downloads without pairing.
2. Allow "Install unknown apps" for the browser or Files app. You only do this once.
3. Open the APK and install.

The desktop app ships the APK too, so the town can serve it from its own address.

## Pair once

1. On your computer, open Devices and copy the pairing link.
2. Open it on the phone and choose **Clowder**. If Android opens the browser instead, go to App info, then Open by default, and add the link, or use Share and choose Clowder.
3. Or open Clowder, paste the link into the setup screen, and tap Connect.

Pair once. After that, when the computer restarts and the address changes, Clowder finds the new address on its own and stays signed in. If it cannot (no network, or the relay is off), copy a new pairing link and open it with Clowder.

A phone that is used at least once a month stays paired.

## After a restart

The quick tunnel gives the town a new address each time it starts. Clowder follows it:

1. The town announces its current address, sealed, to [ntfy.sh](https://ntfy.sh) (a public relay). Only paired devices receive the topic and key, which the town gives them at pairing.
2. The app reads the newest message, opens it, and connects to the new address. The town re-announces every six hours and whenever the address changes.

ntfy.sh can see the topic name, the sealed text (the address is inside it, encrypted), when messages are sent, and the IP addresses of the computer and the phone. It cannot read the address.

To turn this off, set `"rendezvous": false` under `remote` in `town.local.json`. Then the app cannot find a new address after a restart, and you pair it again from Devices.

If the town cannot be reached, Clowder shows a message with a paste field and a Retry button. The menu (top right) has Change town link, Reload and Connection details, which shows whether the app holds the sign-in and the relay details.

## Ping when Clowder needs you (optional, off by default)

The WebView has no Web Push, so the phone gets no notification from Clowder on its own. A ping channel fills the gap: when Clowder would send a notification (a decision, the Mayor, a finished season), it posts one fixed line, "Clowder needs you — open the app", to a private ntfy topic. Tapping it opens Clowder. The ping never carries the question, a cat's name or any town data.

1. Install the ntfy app on the phone (Play Store or F-Droid).
2. On the computer, enable the ping for the paired device: `POST /api/ntfy/devices/<device id>/enable` as the owner (the device id is in `GET /api/ntfy`). The response has the subscribe address, `https://ntfy.sh/clowder-…`.
3. In the ntfy app, subscribe to that address. Allow its notifications.

Revoking the device, or calling `POST /api/ntfy/devices/<device id>/disable`, deletes the topic, and the pings stop. The topic is secret: anyone who learns it can ping the phone, but cannot read anything. At most one ping a minute reaches a device. The server is `ntfy.server` in `town.config.json` (https://ntfy.sh by default); a self-hosted ntfy goes there.

Manual check: enable, approve or wait for any notice, and confirm one ping arrives and that tapping it opens Clowder.

## What the phone keeps

The device token and the relay key are encrypted with an AES-GCM key held in the Android Keystore; the key never leaves it. An older install's plain copies are encrypted on the first start of this version and deleted only after the encrypted copy reads back. If the Keystore key is lost (for example after a factory reset), the app forgets the pairing and you pair again. The WebView's own cookie store still holds the sign-in cookie, as any browser does.

Manual check after changing this code:

1. Pair, force-stop the app, reopen it. Connection details still says the sign-in is saved, and the app follows the town after a restart of the computer.
2. On an emulator with `adb root`, or a test build with `android:debuggable="true"` (then `adb shell run-as com.derpfacejr.clowder`), run `cat /data/data/com.derpfacejr.clowder/shared_prefs/clowder.xml`. It has `device.sealed` and `relayKey.sealed`, no `device` or `relayKey` entries, and no 64-character hex string.
3. Install the previous APK, pair, then install the new one over it and reopen. Step 2 holds and the app is still signed in.

## Limits

- Web Push and the Notification API do not work inside the app's WebView, so you get no phone notifications from Clowder.
- Android 12 and newer do not show "Open with" for trycloudflare.com links unless you set the default in App info.
- iOS is not covered.
