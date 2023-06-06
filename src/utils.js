const fs = require('fs');
const fetch = require('node-superfetch');
const cheerio = require('cheerio');

class Utils {
	static async validate_path(path) {
		try {
			if (!fs.existsSync(path)) await fs.promises.mkdir(path);
		} catch (error) {
		  console.error(`Error creating directory: ${path}`, error);
		  throw error;
		}
	}

	static async fetch_url(url) {
		try {
			const web_request = await fetch.get(url);
			
			if (web_request.status === 404) {
				throw new Error('404 Not Found');
			}

			if (!web_request.ok) {
				throw new Error(`HTTP Error: ${web_request.status}`);
			}

			const { body } = web_request;
			return cheerio.load(body);
		} catch (error) {
			if (error.code === 'ECONNREFUSED') {
				throw new Error('Connection Refused');
			}

			if (error.code === 'ETIMEDOUT') {
				throw new Error('Connection Timed Out');
			}

			throw error;
		}
	}

	static async fetch_all_panels(url) {
		const $ = await this.fetch_url(url);
		const panels = [];

		$('#centerDivVideo img').each((_, element) => {
			const panel_link = $(element).attr('src');
			panels.push(panel_link);
		});

		return panels;
	}
};

module.exports = Utils;
