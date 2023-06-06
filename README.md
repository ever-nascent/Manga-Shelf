Manga Downloader

This is a Node.js script that allows you to download manga panels from https://ww5.manganelo.tv.
The script fetches chapter links, panel links, and downloads the panels to your local machine.

Installation

Clone the repository or download the source code files.
Make sure you have Node.js installed on your machine.
Open a terminal or command prompt and navigate to the project directory.

Run the following command to install the required dependencies:
npm install

Usage

Open the index.js file in a text editor.

Modify the following variables according to your requirements:

manga_site_url: The URL of the manga site you want to download from.
Example: https://ww5.manganelo.tv/manga/manga-ng952689

title: The title or name of the manga series.
Example: Naruto

chapter_to_start_at: The chapter number from which you want to start downloading. Set it to 1 to start from the first chapter.
Save the changes to index.js.

Open a terminal or command prompt and navigate to the project directory.

Run the following command to start the script:
node index.js

The script will start fetching chapter links and panel links, and it will download the manga panels to the panels directory.
Note: Make sure you have a stable internet connection while running the script, as it requires internet access to fetch the manga content.

Folder Structure
The script will create a panels directory in the project folder. Inside the panels directory, it will create subdirectories for each chapter, following the naming convention: <title>-chapter-<chapter_number>. Inside each chapter directory, the downloaded panels will be saved with names like <title>-panel-<panel_number>.<extension>.

Dependencies
This script uses the following dependencies:

image-downloader: A library for downloading images from URLs.
node-superfetch: A library to make HTTP request.
cheerio: A library for parsing and manipulating HTML content.

License
This script is licensed under the MIT License.

Feel free to modify and use the script according to your needs.

Disclaimer
This script is intended for personal use only. Ensure that you have the necessary permissions to download and use the manga content in your jurisdiction. The author does not take any responsibility for any unauthorized usage or legal implications arising from the use of this script.
