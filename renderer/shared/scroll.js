// Reading a scroll position back as a page number.

// The page you're on is the one filling most of the screen. The middle pixel
// alone got it wrong either way round — the next page on a short one, the
// previous on a tall one. Boxes must be in document order, which they are: they
// are the chapter, top to bottom.
export function pageOnScreen(scroller, boxes) {
	const top = scroller.scrollTop;
	const bottom = top + scroller.clientHeight;
	let best = 0;
	let bestCover = -1;
	for (let i = 0; i < boxes.length; i++) {
		const start = boxes[i].offsetTop;
		const end = start + boxes[i].offsetHeight;
		if (end <= top) continue;
		if (start >= bottom) break;
		const cover = Math.min(end, bottom) - Math.max(start, top);
		if (cover > bestCover) { bestCover = cover; best = i; }
	}
	return best;
}
