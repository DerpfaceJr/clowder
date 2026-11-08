'use strict';
// When a downloaded update may install (plan 7.10). The server decides "idle" with busyReason() (src/server.ts), asked over the IPC channel;
// this only orders the steps, so desktop/main.cjs and test/update-gate.test.ts share it. The rule: never while a task or season runs, and
// always after stopServer() has finished, so the journal is flushed and the server has exited before the installer starts.
//   askBusy()      resolves a reason string while busy, null when idle
//   stopServer({quitting}) resolves once the server has exited
//   offer(version) resolves 'now' or 'quit': the owner's answer to "Update ready: restart now / at next quit"
//   updater        electron-updater's autoUpdater: install(isSilent, isForceRunAfter) starts the installer and returns whether it did
//   quit()         quits the app once the installer has started; restart() starts the server again when it did not
function updateGate({updater, askBusy, stopServer, offer, quit, restart}) {
  let ready = null;    // the downloaded version
  let atQuit = false;  // the owner chose "at next quit"
  let offering = false;
  const gate = {
    get ready() { return ready; },
    get atQuit() { return atQuit; },
    downloaded(version) { ready = String(version); },
    // Called on a timer once an update has downloaded: offers it only while the town is idle.
    async tryOffer() {
      if (!ready || atQuit || offering) return 'nothing';
      if (await askBusy()) return 'busy';
      offering = true;
      try {
        if (await offer(ready) !== 'now') { atQuit = true; return 'at-quit'; }
        return await gate.restartNow();
      } finally {
        offering = false;
      }
    },
    // A task may have started while the box was open, so the town is asked again; busy means the offer comes back later.
    // ponytail: a task that starts between this answer and stopServer() is stopped like any quit stops it; a server-side hold would close that.
    async restartNow() {
      if (!ready || await askBusy()) return 'busy';
      await stopServer({quitting: false}); // as a restore stops it: the app is not quitting yet
      // install() is quitAndInstall() without its own quit, so a refused install can bring the town back instead of leaving it stopped.
      if (updater.install(true, true) === true) { quit(); return 'installing'; }
      await restart();
      return 'failed';
    },
    // will-quit. The town is asked before it stops, since a stopped server cannot answer. True when the installer was started.
    async onQuit() {
      let install = false;
      try { install = !!ready && atQuit && !(await askBusy()); } catch { /* no answer: not idle */ }
      await stopServer({quitting: true});
      return install && updater.install(true, false) === true;
    },
  };
  return gate;
}

// Why the updater stays off, or null. On only in a release build (build-info.json release: true, written by the release workflow alone) whose
// app-update.yml names a publisher: electron-updater 6.8.11 skips the signature check when publisherName is missing.
const NOT_RELEASE = 'not a release build';
function updaterOff(info, updateConfig) {
  if (!info || info.release !== true) return NOT_RELEASE;
  const names = [].concat(updateConfig && updateConfig.publisherName || []).filter(n => typeof n === 'string' && n.trim());
  return names.length ? null : 'app-update.yml names no publisher, so a signature could not be checked';
}

module.exports = {updateGate, updaterOff, NOT_RELEASE};
