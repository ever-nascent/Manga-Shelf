const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
	// discovery
	getHome: invoke('md:home'),
	getTags: invoke('md:tags'),
	search: invoke('md:search'),
	getManga: invoke('md:manga'),
	getStats: invoke('md:stats'),
	getChapters: invoke('md:chapters'),
	getMangaByIds: invoke('md:byIds'),
	getSimilar: invoke('md:similar'),
	getChapterImages: invoke('md:chapterImages'),

	// alternative source (manual fallback)
	searchMangaKatana: invoke('mk:search'),

	// downloads
	download: invoke('dl:add'),
	cancelDownload: invoke('dl:cancel'),
	retryDownload: invoke('dl:retry'),
	getQueue: invoke('dl:queue'),
	clearFinishedDownloads: invoke('dl:clearFinished'),
	onQueueUpdate: (cb) => {
		const listener = (_e, queue) => cb(queue);
		ipcRenderer.on('dl:updated', listener);
		return () => ipcRenderer.removeListener('dl:updated', listener);
	},

	// library
	getLibrary: invoke('lib:all'),
	getLibraryManga: invoke('lib:get'),
	getChapterPages: invoke('lib:pages'),
	removeChapter: invoke('lib:removeChapter'),
	removeManga: invoke('lib:removeManga'),

	// reading progress
	setReading: invoke('reading:set'),
	getReading: invoke('reading:get'),
	getReadingAll: invoke('reading:all'),

	// follows
	setFollow: invoke('follows:set'),
	removeFollow: invoke('follows:remove'),
	getFollow: invoke('follows:get'),
	getFollows: invoke('follows:all'),

	// updates
	checkUpdates: invoke('updates:check'),
	getUpdatesFeed: invoke('updates:feed'),
	setFollowNotify: invoke('follows:setNotify'),
	onUpdatesFound: (cb) => {
		const listener = (_e, result) => cb(result);
		ipcRenderer.on('updates:found', listener);
		return () => ipcRenderer.removeListener('updates:found', listener);
	},
	onNavigate: (cb) => {
		const listener = (_e, view) => cb(view);
		ipcRenderer.on('app:navigate', listener);
		return () => ipcRenderer.removeListener('app:navigate', listener);
	},

	// exports
	exportChapter: invoke('export:chapter'),
	exportManga: invoke('export:manga'),

	// app updates
	getAppVersion: invoke('app:version'),
	checkForAppUpdates: invoke('app:checkForUpdates'),
	restartToUpdate: invoke('app:restartToUpdate'),
	onAppUpdate: (cb) => {
		const listener = (_e, evt) => cb(evt);
		ipcRenderer.on('app-update:event', listener);
		return () => ipcRenderer.removeListener('app-update:event', listener);
	},

	// settings / shell
	getSettings: invoke('settings:get'),
	setSettings: invoke('settings:set'),
	chooseLibraryFolder: invoke('settings:chooseFolder'),
	openPath: invoke('shell:openPath'),
	openExternal: invoke('shell:openExternal'),
	openMangaFolder: invoke('shell:openMangaFolder')
});
