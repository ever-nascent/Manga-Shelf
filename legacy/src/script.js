
document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('form');
    const mangadex_url_pattern = /^https:\/\/mangadex\.org\/title\/[a-f0-9-]+\/.+$/;

    form.addEventListener('submit', async (event) => {
        event.preventDefault;

        const manga_url = document.querySelector('#manga-url').value;
        console.log(manga_url);
        if (!mangadex_url_pattern.test(manga_url)) {
            console.log("No Manga Found");
            return;
        }

        try {
            const res = await fetch(manga_url, {method: 'HEAD' });

            if (res.ok) {
                console.log('valud mangadex url');
            }
        } catch (err) {
            console.log(err);
            throw new Error("Error fetching the URL");
        }

        console.log("URL Submitted", manga_url);
    });
});