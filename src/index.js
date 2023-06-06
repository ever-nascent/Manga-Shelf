const Util = require('./utils');
const download = require('image-downloader');

const manga_site_url = 'https://ww5.manganelo.tv/manga/manga-oc955385';
const title = 'hunter-x-hunter';
let chapter_to_start_at = 1;

const main = async () => {
	Util.validate_path('../panels');
	chapter_to_start_at -= 1;

	const chapter_links = await fetch_chapter_links(manga_site_url);
	const panel_links = await fetch_panel_links(chapter_links, chapter_to_start_at);

	await download_panels(panel_links, chapter_to_start_at);
}

const fetch_chapter_links = async (site_url) => {
	console.log('Fetching Chapter Links. . .');
	const $ = await Util.fetch_url(site_url);
	
	const unordered_chapter_list = $('ul.row-content-chapter');
	const chapter_list_items = unordered_chapter_list.find('li.a-h');
	const list_of_chapter_links = chapter_list_items
		.find('a')
		.map((_, element) => $(element)
		.attr('href'))
		.get()
		.map((href) => `https://ww5.manganelo.tv${href}`)
		.reverse();

	console.log(`Fetched ${list_of_chapter_links.length} Chapter Links`);
	return list_of_chapter_links;
}

const fetch_panel_links = async (chapter_links, chapter_to_start_at) => {
	const panel_links = [];

	for (let i = chapter_to_start_at; i < chapter_links.length; i++) {
		console.log(`Fetching Panel Links for Chapter ${i + 1}`)
		const $ = await Util.fetch_url(chapter_links[i]);
		
		const panels = $('div.container-chapter-reader')
			.find('img')
			.map((_, element) => $(element)
			.attr('data-src'))
			.get();

		panel_links.push(panels);
	}

	console.log(`Successfully fetched all Panel Links for ${panel_links.length} Chapters`);
	return panel_links;
}

const download_panels = async(panel_links) => {
	for (let i = 0; i < panel_links.length; i++) {
		console.log(`Starting Panel Downloads for Chapter ${chapter_to_start_at + i}`)

		for (let j = 0; j < panel_links[i].length; j++) {
			const panel_link = panel_links[i][j];
			const extension = panel_link.slice(-3);

			Util.validate_path(`../panels/${title}-chapter-${chapter_to_start_at + i}`);

			const options = {
				url: panel_link,
				dest: `../../panels/${title}-chapter-${chapter_to_start_at + i}/${title}-panel-${j + 1}.${extension}`
			}
				
			if (options.url) {
				await download.image(options);
			}
		}

		console.log(`Successfully downloaded ${panel_links[i].length} Panels for Chapter ${chapter_to_start_at + i}`)
	}
}

main();