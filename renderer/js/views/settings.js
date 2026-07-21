import { h, clear, toast, fmtBytes } from '../util.js';
import { styledSelect } from '../components.js';
import { icon } from '../icons.js';

const LANGUAGES = [
	['en', 'English'], ['es', 'Spanish'], ['es-la', 'Spanish (LATAM)'], ['fr', 'French'],
	['de', 'German'], ['it', 'Italian'], ['pt-br', 'Portuguese (BR)'], ['ru', 'Russian'],
	['id', 'Indonesian'], ['vi', 'Vietnamese'], ['pl', 'Polish'], ['tr', 'Turkish']
];

export async function render(root, params, ctx, signal) {
	root.append(h('div', { class: 'view-title' }, 'Settings'));
	let settings = await window.api.getSettings();

	const save = async (partial, msg = 'Saved.') => {
		settings = await window.api.setSettings(partial);
		toast(msg, 'success', 1800);
	};

	// ----- library folder -----
	const pathCode = h('code', {}, settings.libraryPath);
	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Library folder'),
		h('div', { class: 'hint' }, 'Where downloaded manga are stored (one folder per series, one subfolder per chapter).'),
		h('div', { class: 'settings-row' },
			pathCode,
			h('button', {
				class: 'btn small',
				onclick: async () => {
					const updated = await window.api.chooseLibraryFolder();
					if (updated) {
						settings = updated;
						pathCode.textContent = updated.libraryPath;
						toast('Library folder changed. Existing downloads stay in the old folder.', 'success');
					}
				}
			}, 'Change'),
			h('button', { class: 'btn small', onclick: () => window.api.openLibraryFolder() }, 'Open')
		)
	));

	// ----- content rating -----
	const ratings = [
		['safe', 'Safe'],
		['suggestive', 'Suggestive'],
		['erotica', 'Erotica (18+)']
	];
	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Content filter'),
		h('div', { class: 'hint' }, 'Which content ratings show up in Home, Browse, and chapter lists.'),
		ratings.map(([value, label]) => h('label', { class: 'check-row' },
			h('input', {
				type: 'checkbox',
				checked: settings.contentRating.includes(value),
				onchange: (e) => {
					const set = new Set(settings.contentRating);
					e.target.checked ? set.add(value) : set.delete(value);
					if (!set.size) { set.add('safe'); e.target.checked = value === 'safe'; }
					save({ contentRating: [...set] });
				}
			}),
			label
		))
	));

	// ----- quality -----
	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Image quality'),
		h('div', { class: 'hint' }, 'Data saver downloads compressed pages — smaller files, slightly lower quality.'),
		[['data', 'Original quality'], ['data-saver', 'Data saver']].map(([value, label]) => h('label', { class: 'check-row' },
			h('input', {
				type: 'radio', name: 'quality',
				checked: settings.quality === value,
				onchange: () => save({ quality: value })
			}),
			label
		))
	));

	// ----- notifications -----
	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Notifications'),
		h('div', { class: 'hint' },
			'Show a desktop notification when series you follow get new chapters. MangaShelf checks at launch and every 2 hours while open. Use the bell button on a series page to mute individual series.'),
		h('label', { class: 'check-row' },
			h('input', {
				type: 'checkbox',
				checked: settings.notifications !== false,
				onchange: (e) => save({ notifications: e.target.checked })
			}),
			'Desktop notifications for new chapters'
		)
	));

	// ----- language -----
	const langSelect = styledSelect({
		value: settings.language,
		options: LANGUAGES.map(([value, label]) => ({ value, label })),
		onChange: (v) => save({ language: v })
	});
	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Chapter language'),
		h('div', { class: 'hint' }, 'Translated language used for chapter lists and downloads.'),
		langSelect.el
	));

	// ----- phone remote -----
	const fmtCode = (t) => (t ? `${t.slice(0, 4)}-${t.slice(4)}` : '');
	const qrImg = h('img', { class: 'remote-qr', alt: 'Link QR code' });
	const urlCode = h('code', {}, '');
	const linkCode = h('div', { class: 'remote-code' }, '');
	const remotePanel = h('div', { class: 'remote-panel hidden' },
		qrImg,
		h('div', { class: 'remote-details' },
			h('div', { class: 'hint' }, 'Scan the QR code with your phone camera, or open the address in your phone browser and type the link code.'),
			h('div', { class: 'settings-row' }, h('span', { class: 'remote-label' }, 'Address'), urlCode),
			h('div', { class: 'settings-row' }, h('span', { class: 'remote-label' }, 'Link code'), linkCode),
			h('div', { class: 'settings-row' },
				h('button', {
					class: 'btn small',
					onclick: async () => {
						applyRemote(await window.api.regenerateRemoteToken());
						toast('New link code generated. Linked phones must scan again.', 'success');
					}
				}, 'Generate new code')
			)
		)
	);

	const applyRemote = (info) => {
		remoteToggle.checked = info.enabled && info.running;
		remotePanel.classList.toggle('hidden', !info.running);
		if (info.running) {
			qrImg.src = info.qrDataUrl || '';
			urlCode.textContent = info.url || '';
			linkCode.textContent = fmtCode(info.token);
		}
	};

	const remoteToggle = h('input', {
		type: 'checkbox',
		onchange: async (e) => {
			try {
				applyRemote(await window.api.setRemoteEnabled(e.target.checked));
				toast(e.target.checked ? 'Phone access is on for this Wi-Fi network.' : 'Phone access turned off.', 'success');
			} catch (err) {
				e.target.checked = false;
				toast(`Couldn't start phone access: ${err.message}`, 'error');
			}
		}
	});

	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Phone remote'),
		h('div', { class: 'hint' },
			'Use MangaShelf from your phone browser: browse, queue downloads to this PC, and read your library. Works while the app is open and both devices are on the same Wi-Fi network.'),
		h('label', { class: 'check-row' }, remoteToggle, 'Allow phones to connect'),
		remotePanel
	));
	window.api.getRemoteInfo().then((info) => { if (!signal.aborted) applyRemote(info); });

	// ----- storage -----
	const storageBody = h('div', { class: 'storage-body' });
	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'Storage'),
		h('div', { class: 'hint' }, 'How much disk space each downloaded series is using. Delete a series to free space.'),
		storageBody
	));

	async function loadStorage() {
		clear(storageBody);
		storageBody.append(h('div', { class: 'hint' }, 'Calculating…'));
		let usage;
		try {
			usage = await window.api.getStorageUsage();
		} catch (err) {
			clear(storageBody);
			storageBody.append(h('div', { class: 'hint' }, `Couldn't read storage: ${err.message}`));
			return;
		}
		if (signal.aborted) return;
		clear(storageBody);
		storageBody.append(h('div', { class: 'storage-total' },
			h('b', {}, fmtBytes(usage.total)),
			` across ${usage.items.length} series`));
		if (!usage.items.length) {
			storageBody.append(h('div', { class: 'hint' }, 'No downloads yet.'));
			return;
		}
		const max = usage.items[0].bytes || 1;
		const list = h('div', { class: 'storage-list' });
		for (const it of usage.items) {
			list.append(h('div', { class: 'storage-row' },
				h('div', { class: 'storage-meta' },
					h('span', { class: 'storage-name', title: it.title }, it.title),
					h('span', { class: 'storage-size' }, `${fmtBytes(it.bytes)} · ${it.chapters} ch.`)
				),
				h('div', { class: 'storage-bar' }, h('div', { style: { width: `${(it.bytes / max) * 100}%` } })),
				h('button', {
					class: 'btn small danger icon-only', title: 'Delete series from disk',
					onclick: async () => {
						if (!confirm(`Delete "${it.title}" and all ${it.chapters} downloaded chapters from disk?`)) return;
						await window.api.removeManga(it.id);
						toast(`Deleted ${it.title}.`);
						loadStorage();
					}
				}, icon('trash', 14))
			));
		}
		storageBody.append(list);
	}
	loadStorage();

	// ----- about / updates -----
	const version = await window.api.getAppVersion();
	const updateStatus = h('div', { class: 'hint' });
	const checkBtn = h('button', { class: 'btn small', onclick: runCheck }, 'Check for updates');

	async function runCheck() {
		checkBtn.disabled = true;
		updateStatus.textContent = 'Checking…';
		await window.api.checkForAppUpdates();
	}

	const onUpdateEvent = (e) => {
		const evt = e.detail;
		if (evt.type === 'none') { updateStatus.textContent = `You're on the latest version (${version}).`; checkBtn.disabled = false; }
		else if (evt.type === 'available') { updateStatus.textContent = `Update v${evt.version} found — downloading…`; }
		else if (evt.type === 'progress') { updateStatus.textContent = `Downloading update… ${evt.percent}%`; }
		else if (evt.type === 'downloaded') { updateStatus.textContent = `v${evt.version} is ready to install.`; checkBtn.disabled = false; }
		else if (evt.type === 'error') { updateStatus.textContent = `Update check failed: ${evt.message}`; checkBtn.disabled = false; }
	};
	window.addEventListener('app-update-event', onUpdateEvent, { signal });

	root.append(h('div', { class: 'settings-block' },
		h('h3', {}, 'About'),
		h('div', { class: 'hint' },
			'MangaShelf 2.0 — powered by the official MangaDex API. Please support the scanlation groups and MangaDex at mangadex.org. Downloads are for personal offline reading.'),
		h('div', { class: 'settings-row' }, h('span', {}, `Version ${version}`), checkBtn),
		updateStatus
	));
}
