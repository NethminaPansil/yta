const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.set('json spaces', 2);

/*
  ========== (1) YOUR GENIUS LYRICS ENDPOINT (kept largely as you provided) ==========
  (You can keep your original implementation here; I included a compact version for completeness)
*/

app.get('/api/lyrics', async (req, res) => {
  const { q: searchQuery } = req.query;
  if (!searchQuery) return res.status(400).json({ error: 'Please provide ?q=SEARCH' });

  try {
    const searchResponse = await axios.get(
      "https://genius.com/api/search/multi?per_page=5&q=" + encodeURIComponent(searchQuery),
      { headers: { accept: "application/json, text/plain, */*", "user-agent": "Mozilla/5.0" } }
    );
    const responseData = searchResponse.data;

    const songResult = responseData.response.sections
      .find(section => ["song","lyric"].includes(section.type))
      ?.hits?.find(hit => ["song","lyric"].includes(hit.type))?.result;

    if (!songResult) return res.status(404).json({ error: "No song found matching your query" });

    const {
      artist_names: artistName,
      title: songTitle,
      url: songUrl,
      header_image_url: imageUrl,
      api_path
    } = songResult;

    // optional view count bump (non-critical)
    try {
      const songId = api_path.split('/').pop();
      await axios.post(`https://genius.com/api/songs/${songId}/count_view`, {}, {
        headers: { 'accept': '*/*', 'referer': songUrl, 'user-agent': 'Mozilla/5.0' }
      });
    } catch (e) { /* ignore */ }

    // scrape lyrics (robust selectors)
    const lyricsPage = await axios.get(songUrl).then(r => r.data);
    const $ = cheerio.load(lyricsPage);
    let lyricsText = "";

    // try several selectors
    const blocks = $("div[data-lyrics-container='true'], .Lyrics__Container, .lyrics");
    blocks.each((i, el) => {
      // replace <br> with newline and get text
      const html = $(el).html() || '';
      const text = html.replace(/<br\s*\/?>/g, '\n').replace(/<\/?[^>]+(>|$)/g, '').trim();
      if (text) lyricsText += text + "\n\n";
    });

    const cleanedLyrics = lyricsText.replace(/\n{3,}/g, '\n\n').trim();

    return res.json({
      status: 200,
      success: true,
      result: {
        title: songTitle,
        artist: artistName,
        link: songUrl,
        image: imageUrl,
        lyrics: cleanedLyrics || "Lyrics not found in expected selectors."
      }
    });

  } catch (error) {
    console.error('Lyrics fetch error:', error.message || error);
    return res.status(500).json({ error: "Failed to fetch lyrics", details: error.message || error });
  }
});


/*
  ========== (2) YT SONG DOWNLOADER / STREAMER ENDPOINT ==========
  Endpoint: /api/yt-song?url=YOUTUBE_URL&format=mp3|m4a&quality=128
  - Streams converted audio to client (no disk)
  - Ensure your host supports streaming and ffmpeg.
*/

function sanitizeFilename(name = 'song') {
  return name.replace(/[^a-z0-9_\-\.()\[\] ]/ig, '').replace(/\s+/g, '_').slice(0, 120);
}

/*
  PLACEHOLDER: integrate your scraper here.
  If you will provide a scraper (for searching or getting youtube id from query), you can
  call it in place of `getYouTubeInfoFromUrl`.
*/
async function getYouTubeInfoFromUrl(url) {
  // If you provide a scraper API / function, call it here and return something like:
  // { title: 'Song Title', artist: 'Artist Name', thumbnail: 'https://..', videoId: 'abc123' }
  // For now, we'll fall back to ytdl-core's getInfo:
  const info = await ytdl.getInfo(url);
  const videoDetails = info.videoDetails || {};
  return {
    title: videoDetails.title || 'unknown',
    author: videoDetails.author?.name || '',
    thumbnail: videoDetails.thumbnails?.pop()?.url || '',
    videoId: videoDetails.videoId || ''
  };
}

app.get('/api/yt-song', async (req, res) => {
  const { url, format = 'mp3', quality = '128' } = req.query;
  if (!url) return res.status(400).json({ error: 'Please provide ?url=YOUTUBE_VIDEO_URL' });

  // validate format
  if (!['mp3','m4a'].includes(format)) return res.status(400).json({ error: 'format must be mp3 or m4a' });

  try {
    // get info (or call your scraper here)
    const info = await getYouTubeInfoFromUrl(url);
    const filename = sanitizeFilename(`${info.title || 'youtube_audio'}.${format}`);

    // set response headers for download/streaming
    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // create YTDL stream (audio only)
    const ytdlStream = ytdl(url, {
      quality: 'highestaudio',
      filter: 'audioonly',
      highWaterMark: 1 << 25 // buffer
    });

    // pipe through ffmpeg to convert to mp3/m4a
    const passThrough = new PassThrough();

    ffmpeg(ytdlStream)
      .audioBitrate(parseInt(quality) || 128)
      .format(format === 'mp3' ? 'mp3' : 'ipod') // ipod -> m4a
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message || err);
        if (!res.headersSent) res.status(500).json({ error: 'Conversion error', details: err.message || err });
        try { passThrough.end(); } catch(e){/*ignore*/ }
      })
      .on('end', () => {
        try { passThrough.end(); } catch(e){/*ignore*/ }
      })
      .pipe(passThrough);

    // finally pipe to response
    passThrough.pipe(res);

  } catch (error) {
    console.error('YT download error:', error.message || error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to process YouTube URL', details: error.message || error });
    }
  }
});


/*
  ========== (3) Root & health check ==========
*/
app.get('/', (req, res) => {
  res.send(`
    <h1>VORTEX YouTube Audio API</h1>
    <p>/api/lyrics?q=SONG_NAME</p>
    <p>/api/yt-song?url=YOUTUBE_URL&format=mp3&quality=128</p>
    <p>Made By:  VORTEX MD_</p>
  `);
});

app.get('/ping', (req,res) => res.json({ ok: true, timestamp: Date.now() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Try: http://localhost:${PORT}/api/yt-song?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=mp3`);
});
