// Checks GitHub Releases (via the `publish` block in package.json) for a
// newer NSIS build and restarts into it. Only meaningful for an installed,
// packaged app — there's nothing to update to in --dev, and portable builds
// don't have an install location to replace, so callers should gate on
// app.isPackaged before touching this module.

const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;
// We install by hand instead. The silent install-on-quit looks broken from
// the outside: the exe is mid-replacement for a few seconds, so reopening
// the app right after closing it hits "file not found", or launches a copy
// the installer then kills. Nothing on screen explains any of that.
autoUpdater.autoInstallOnAppQuit = false;

// sendEvent receives {type: 'checking'|'available'|'none'|'progress'|'downloaded'|'error', ...}
function initAutoUpdater(sendEvent) {
	autoUpdater.on('checking-for-update', () => sendEvent({ type: 'checking' }));
	autoUpdater.on('update-available', (info) => sendEvent({ type: 'available', version: info.version }));
	autoUpdater.on('update-not-available', () => sendEvent({ type: 'none' }));
	autoUpdater.on('download-progress', (p) => sendEvent({ type: 'progress', percent: Math.round(p.percent) }));
	autoUpdater.on('update-downloaded', (info) => sendEvent({ type: 'downloaded', version: info.version }));
	autoUpdater.on('error', (err) => sendEvent({ type: 'error', message: err.message }));
}

function checkForUpdates() {
	return autoUpdater.checkForUpdates().catch((err) => console.error('Update check failed:', err.message));
}

// isSilent: false — show the installer's own progress window, so the user can
// see why the app vanished for a few seconds instead of guessing.
// isForceRunAfter: true — reopen MangaShelf once the install finishes, so
// nobody is left double-clicking a shortcut that isn't there yet.
function quitAndInstall({ relaunch }) {
	autoUpdater.quitAndInstall(false, relaunch);
}

module.exports = { initAutoUpdater, checkForUpdates, quitAndInstall };
