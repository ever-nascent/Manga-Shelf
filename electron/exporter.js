// Export downloaded chapters as .cbz (comic archive) or .pdf.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { PDFDocument } = require('pdf-lib');
const { sanitizeName, padChapter } = require('./library');

function chapterLabel(mangaTitle, ch) {
	const num = ch.num ? `Chapter ${padChapter(ch.num)}` : 'Oneshot';
	return sanitizeName(`${mangaTitle} - ${num}`);
}

function exportChapterCBZ(pages, destFile) {
	const zip = new AdmZip();
	for (const page of pages) {
		zip.addLocalFile(page);
	}
	zip.writeZip(destFile);
}

async function exportChapterPDF(pages, destFile) {
	const doc = await PDFDocument.create();
	for (const page of pages) {
		const bytes = fs.readFileSync(page);
		const ext = path.extname(page).toLowerCase();
		let img;
		if (ext === '.jpg' || ext === '.jpeg') {
			img = await doc.embedJpg(bytes);
		} else if (ext === '.png') {
			img = await doc.embedPng(bytes);
		} else {
			throw new Error(`PDF export supports JPG/PNG pages only (found ${ext}). Use CBZ instead.`);
		}
		const p = doc.addPage([img.width, img.height]);
		p.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
	}
	fs.writeFileSync(destFile, await doc.save());
}

// Exports one chapter to destFile, format 'cbz' | 'pdf'.
async function exportChapter(library, mangaId, chapterId, format, destFile) {
	const pages = library.getChapterPages(mangaId, chapterId);
	if (!pages.length) throw new Error('No downloaded pages found for this chapter.');
	if (format === 'pdf') {
		await exportChapterPDF(pages, destFile);
	} else {
		exportChapterCBZ(pages, destFile);
	}
	return destFile;
}

// Exports every downloaded chapter of a manga into destDir. Returns file count.
async function exportManga(library, mangaId, format, destDir) {
	const manga = library.get(mangaId);
	if (!manga) throw new Error('Manga not found in library.');
	let count = 0;
	for (const ch of manga.chapters) {
		const dest = path.join(destDir, `${chapterLabel(manga.title, ch)}.${format}`);
		await exportChapter(library, mangaId, ch.id, format, dest);
		count++;
	}
	return count;
}

module.exports = { exportChapter, exportManga, chapterLabel };
