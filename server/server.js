// server.js - FINAL VERSION WITH AGGRESSIVE FOREIGN LANGUAGE FILTER

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());

const PORT = 4000;

// ⬇️ PATH DEFINITIONS
const SERVER_DIR = __dirname;
const YTDLP_PATH = path.join(SERVER_DIR, "yt-dlp.exe");
const TMP_DIR = path.join(SERVER_DIR, "tmp_downloads");
const COOKIE_PATH = path.join(SERVER_DIR, "youtube_cookies.txt"); 

// Ensure temp dir exists
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// --- UTILITY FUNCTIONS ---

/**
 * Runs the yt-dlp process and returns a promise.
 */
function runYtdlp(args, options = {}) {
  return new Promise((resolve, reject) => {
    
    // Check if yt-dlp and cookies exist before trying to spawn
    if (!fs.existsSync(YTDLP_PATH)) {
        return reject({ code: "path_error", stderr: `yt-dlp.exe not found at ${YTDLP_PATH}` });
    }
    
    // Add cookie arguments to the start of the command
    const fullArgs = ["--cookies", COOKIE_PATH, ...args];

    const child = spawn(YTDLP_PATH, fullArgs, { windowsHide: true });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject({ code, stdout, stderr });
    });

    if (options.timeoutMs) {
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        reject({ code: "timeout", stderr: "Timed out" });
      }, options.timeoutMs);
    }
  });
}

/**
 * Normalizes a YouTube URL to a canonical watch link.
 */
function normalizeYouTubeUrl(url) {
  try {
    if (!url) return null;
    let cleaned = url.split("&")[0].split("?si")[0];
    const match = cleaned.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([^#?&]+)/);
    if (!match) return null;
    return `https://www.youtube.com/watch?v=${match[1]}`;
  } catch {
    return null;
  }
}

const INFO_STRATEGIES = [
  ["-J", "--no-warnings"],
  ["-J", "--no-warnings", "--extractor-args", "youtube:player_client=android"],
  ["-J", "--no-warnings", "--extractor-args", "youtube:player_client=default"],
  ["-J", "--no-warnings", "--extractor-args", "youtube:player_client=tvhtml5"],
  ["-J", "--no-warnings", "--allow-dynamic-mpd", "--no-check-formats"],
];

// --- /api/info (GET VIDEO METADATA) ---
// -----------------------------------------------------------------------------
app.get("/api/info", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const cleanedUrl = normalizeYouTubeUrl(url);
  if (!cleanedUrl) return res.status(400).json({ error: "Invalid URL" });

  let info = null;
  let lastErr = null;

  for (const strat of INFO_STRATEGIES) {
    try {
      const args = [...strat, cleanedUrl];
      console.log("INFO →", args.join(" "));
      const { stdout } = await runYtdlp(args, { timeoutMs: 30000 });
      info = JSON.parse(stdout);
      if (info?.formats?.length > 0) break;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  if (!info || !info.formats)
    return res.status(500).json({
      error: "Failed to extract video info. Update yt-dlp.",
      details: lastErr?.stderr?.slice(0, 500) || "No response received from yt-dlp.",
    });

  // Split formats
  const mixed = [];
  const videoOnly = [];
  const audioOnly = [];

  for (const f of info.formats) {
    const v = f.vcodec !== "none";
    const a = f.acodec !== "none";

    if (v && a) mixed.push(f);
    else if (v && !a) videoOnly.push(f);
    else if (!v && a) audioOnly.push(f);
  }

  // Build video list
  const map = new Map();
  // We assume the desired language is English based on your highest quality tracks.
  const DESIRED_LANGUAGE_CODE = "en"; 


  function pushFormat(f, hasAudio) {
    const height = f.height || 0;
    const key = height || f.format_id;
    const trackLanguage = (f.language || "").toLowerCase().split("-")[0];

    // **CRITICAL FILTER ADDITION**
    // If the format contains audio, and the language is NOT the desired language, skip it.
    const isForeignAudio = hasAudio && trackLanguage.length > 0 && trackLanguage !== DESIRED_LANGUAGE_CODE;

    if (isForeignAudio) {
        // Skip formats that are explicitly tagged as a foreign language (e.g., the French/Dutch mixed tracks)
        return;
    }
    // END CRITICAL FILTER

    if (!map.has(key)) {
      map.set(key, {
        itag: String(f.format_id),
        quality: height ? `${height}p` : f.format_note,
        height,
        container: f.ext,
        hasAudio,
        merge: !hasAudio,
      });
      return;
    }

    const existing = map.get(key);
    if (hasAudio && !existing.hasAudio) {
      map.set(key, {
        itag: String(f.format_id),
        quality: height ? `${height}p` : f.format_note,
        height,
        container: f.ext,
        hasAudio: true,
        merge: false,
      });
    }
  }

  mixed.forEach((f) => pushFormat(f, true));
  videoOnly.forEach((f) => pushFormat(f, false));

  // Fix: Include webm containers for high quality formats
  let videoArr = Array.from(map.values()).filter((v) => v.container === "mp4" || v.container === "webm");
  videoArr.sort((a, b) => b.height - a.height);

  // ---------------------------------------------------------------------
  // 🎤 FINAL AUDIO SELECTION LOGIC (Unchanged, selects best non-foreign audio-only stream)
  // ---------------------------------------------------------------------

  const originalLanguage = (info.language || "").toLowerCase().split("-")[0];

  let bestSelectedAudio = null;
  let defaultTrack = null;

  for (const a of audioOnly) {
    const abr = Math.round(a.abr || a.tbr || 0);
    if (abr <= 0) continue;

    const note = (a.format_note || "").toLowerCase();
    const trackLanguage = (a.language || "").toLowerCase().split("-")[0];

    // Define tracks we DON'T want
    const isDubOrCommentary = 
      note.includes("dub") || 
      note.includes("descriptive") ||
      note.includes("commentary") ||
      // Exclude tracks that are clearly tagged as a language different from the video's original language, unless the original language is unknown
      (a.language && a.language.length > 0 && trackLanguage !== originalLanguage && originalLanguage !== ""); 
    
    if (isDubOrCommentary) continue;

    const obj = {
      itag: String(a.format_id),
      bitrate: abr,
      container: a.ext,
      language: trackLanguage,
      note,
      // Preference 0 or greater often means default/best track. This is the most reliable check.
      isDefault: a.preference >= 0
    };

    // 1. First priority: Find the highest bitrate track that is marked as default/best
    if (obj.isDefault && abr > (defaultTrack?.bitrate || 0)) {
      defaultTrack = obj;
    }

    // 2. Second priority (fallback): Find the overall highest bitrate track (excluding excluded tracks)
    if (abr > (bestSelectedAudio?.bitrate || 0)) {
      bestSelectedAudio = obj;
    }
  }

  // Select the default track if we found one, otherwise fall back to the highest bitrate track found.
  const selectedAudio = defaultTrack || bestSelectedAudio;


  const audioArr = selectedAudio
    ? [
        {
          itag: selectedAudio.itag,
          bitrate: selectedAudio.bitrate,
          container: "mp3",
          converted: true,
          language: selectedAudio.language,
          original_itag: selectedAudio.itag, 
        },
      ]
    : [];

  // FINAL RESPONSE
  res.json({
    title: info.title,
    thumbnail: info.thumbnail_url || info.thumbnail,
    formats: {
      video: videoArr,
      audio: audioArr,
    },
  });
});

// --- /api/download (INITIATE DOWNLOAD) ---
// -----------------------------------------------------------------------------
app.get("/api/download", async (req, res) => {
  const { url, itag, type, audio_itag } = req.query;

  const cleanedUrl = normalizeYouTubeUrl(url);
  if (!cleanedUrl || !itag) return res.status(400).json({ error: "Invalid URL or Missing ITAG" });

  const isAudio = type === "audio";
  const timestamp = Date.now();
  const outExt = isAudio ? "mp3" : "mp4";
  const tmpPath = path.join(TMP_DIR, `dl_${timestamp}.${outExt}`);

  // Since all video formats now listed should be video-only or have original audio, 
  // we default to the best separate audio for merging, except for audio-only downloads.
  const selectedAudioItag = audio_itag || "bestaudio";

  const buildArgs = (strat) => {
    
    if (isAudio) {
      return [
        ...strat,
        "-f",
        itag,
        "--extract-audio",
        "--audio-format",
        "mp3",
        "-o",
        tmpPath,
        cleanedUrl,
      ];
    }

    // Since we filtered the mixed tracks above, this command should now correctly 
    // combine a video-only track with the best original audio-only track.
    return [
      ...strat,
      "-f",
      `${itag}+${selectedAudioItag}/bestaudio`,
      "--merge-output-format",
      "mp4",
      "-o",
      tmpPath,
      cleanedUrl,
    ];
  };

  const DOWNLOAD_STRATS = [
    ["--no-warnings"],
    ["--no-warnings", "--extractor-args", "youtube:player_client=android"],
    ["--no-warnings", "--extractor-args", "youtube:player_client=tvhtml5"],
    ["--no-warnings", "--allow-dynamic-mpd", "--no-check-formats"],
  ];

  let success = false;
  let lastErr = null;

  for (const strat of DOWNLOAD_STRATS) {
    try {
      const args = buildArgs(strat);
      console.log("DOWNLOAD →", args.join(" "));
      await runYtdlp(args, { timeoutMs: 1000 * 60 * 20 }); // 20 minute timeout
      success = true;
      break;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  if (!success)
    return res.status(500).json({
      error: "Download failed!",
      details: lastErr?.stderr?.slice(0, 500) || "No response received during download attempt.",
    });

  // Stream the file back to the client
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="download.${outExt}"`
  );
  const stream = fs.createReadStream(tmpPath);
  stream.pipe(res);

  // Ensure file cleanup on successful stream close
  stream.on("close", () => {
    try { fs.unlinkSync(tmpPath); } catch {}
  });

  // Fix: Ensure file cleanup on stream error/abort
  stream.on("error", (err) => {
    console.error("Stream error:", err);
    try { fs.unlinkSync(tmpPath); } catch {}
  });
});

// --- RUN SERVER ---
// -----------------------------------------------------------------------------

/**
 * Startup function to clean up old temp files (older than 24 hours).
 */
(function cleanupOld() {
  try {
    const files = fs.readdirSync(TMP_DIR);
    const cutoff = Date.now() - 24 * 3600 * 1000; // 24h
    for (const f of files) {
      const p = path.join(TMP_DIR, f);
      const stat = fs.statSync(p);
      if (stat.mtimeMs < cutoff) {
          console.log("Cleaning old file:", p);
          fs.unlinkSync(p);
      }
    }
  } catch (e) {
    console.warn("Failed to cleanup old temp files:", e.message);
  }
})();

app.get("/", (req, res) => res.send("yt-dlp server running"));

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));