// Checks GitHub Releases (via the `publish` block in package.json) for a
// newer NSIS build and restarts into it. Only meaningful for an installed,
// packaged app — there's nothing to update to in --dev, and portable builds
// don't have an install location to replace, so callers should gate on
// app.isPackaged before touching this module.

const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = true;
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

function quitAndInstall() {
	autoUpdater.quitAndInstall();
}

module.exports = { initAutoUpdater, checkForUpdates, quitAndInstall };
