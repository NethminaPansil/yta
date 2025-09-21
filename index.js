const express = require("express");
const fetch = require("node-fetch"); // install: npm i node-fetch@2
const app = express();
const PORT = process.env.PORT || 3000;

// --- YTMP3.mobi scraper function ---
async function ytmp3mobi(youtubeUrl, format = "mp3") {
  const regYoutubeId = /https:\/\/(www\.youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/watch\?v=)([^&|^?]+)/;
  const videoId = youtubeUrl.match(regYoutubeId)?.[2];
  if (!videoId)
    throw Error("Cannot extract YouTube video ID. Please check your YouTube link.");

  const availableFormat = ["mp3", "mp4"];
  if (!availableFormat.includes(format.toLowerCase()))
    throw Error(`Invalid format: ${format}. Available: ${availableFormat.join(", ")}`);

  const urlParam = {
    v: videoId,
    f: format,
    _: Math.random(),
  };

  const headers = { Referer: "https://id.ytmp3.mobi/" };

  const fetchJson = async (url, desc) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw Error(`Fetch failed on ${desc} | ${res.status} ${res.statusText}`);
    return res.json();
  };

  // step 1: get convertURL
  const { convertURL } = await fetchJson(
    "https://d.ymcdn.org/api/v1/init?p=y&23=1llum1n471&_=" + Math.random(),
    "init convertURL"
  );

  // step 2: get progressURL + downloadURL
  const { progressURL, downloadURL } = await fetchJson(
    `${convertURL}&${new URLSearchParams(urlParam).toString()}`,
    "get progress/downloadURL"
  );

  // step 3: poll progress until ready
  let error, progress, title;
  while (progress !== 3) {
    ({ error, progress, title } = await fetchJson(progressURL, "progressURL"));
    if (error) throw Error(`Error from API: ${error}`);
    await new Promise(r => setTimeout(r, 1000)); // wait a sec before recheck
  }

  return { title, downloadURL };
}

// --- API endpoint ---
app.get("/api/ytmp3mobi", async (req, res) => {
  const { url, format = "mp3" } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  try {
    const result = await ytmp3mobi(url, format);
    return res.json({ status: 200, success: true, result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// root
app.get("/", (req, res) => {
  res.send(`<h2>ytmp3.mobi API</h2>
    <p>Usage: /api/ytmp3mobi?url=YOUTUBE_URL&format=mp3</p>`);
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
