import { h, clear, toast, fmtDate } from '../util.js';
import { coverImg } from '../components.js';
import { icon } from '../icons.js';
import { setUpdatesBadge } from '../app.js';

export async function render(root, params, ctx) {
	setUpdatesBadge(0);

	const checkBtn = h('button', { class: 'btn primary' }, icon('refresh', 15), 'Check for new chapters');
	root.append(
		h('div', { class: 'view-title' }, 'Updates'),
		h('div', { style: { marginBottom: '16px' } }, checkBtn)
	);

	const list = h('div', {});
	root.append(list);

	function draw(feed) {
		clear(list);
		if (!feed.length) {
			list.append(h('div', { class: 'empty-state' },
				h('div', { class: 'big' }, icon('bell', 44)),
				h('div', {}, 'No new chapters right now.'),
				h('div', {}, 'Follow manga with the bookmark button and new releases will show up here. MangaShelf also checks automatically while it\'s open.')
			));
			return;
		}

		// group consecutive feed entries per manga, newest first
		const groups = new Map();
		for (const u of feed) {
			if (!groups.has(u.mangaId)) groups.set(u.mangaId, []);
			groups.get(u.mangaId).push(u);
		}

		for (const [mangaId, entries] of groups) {
			const newest = entries[0];
			const nums = entries
				.map((e) => e.num)
				.sort((a, b) => parseFloat(b) - parseFloat(a));
			const shown = nums.slice(0, 6);
			list.append(
				h('div', { class: 'update-row', onclick: () => ctx.navigate('detail', { id: mangaId }) },
					coverImg(newest.coverUrl, newest.mangaTitle),
					h('div', { class: 'u-info' },
						h('div', { class: 'u-title' }, newest.mangaTitle),
						h('div', { class: 'u-chips' },
							shown.map((n) => h('span', { class: 'chip' }, `Ch. ${n}`)),
							nums.length > shown.length ? h('span', { class: 'chip' }, `+${nums.length - shown.length} more`) : null
						)
					),
					h('div', { class: 'u-date' }, fmtDate(newest.publishAt || newest.foundAt))
				)
			);
		}
	}

	checkBtn.addEventListener('click', async () => {
		checkBtn.disabled = true;
		checkBtn.textContent = 'Checking…';
		try {
			const result = await window.api.checkUpdates();
			draw(result.feed);
			toast(result.added
				? `Found ${result.added} new chapter${result.added === 1 ? '' : 's'}!`
				: 'No new chapters since last check.', result.added ? 'success' : 'info');
			if (result.failed?.length) {
				const first = result.failed[0];
				toast(`Couldn't check ${result.failed.length === 1 ? first.title : `${result.failed.length} series`} — ${first.error}`, 'error', 7000);
			}
		} catch (err) {
			toast(`Update check failed: ${err.message}`, 'error');
		} finally {
			checkBtn.disabled = false;
			checkBtn.textContent = 'Check for new chapters';
		}
	});

	draw(await window.api.getUpdatesFeed());
}
