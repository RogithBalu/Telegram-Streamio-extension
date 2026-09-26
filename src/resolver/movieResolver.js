import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { automateMovieRequest } from "../telegram/automation.js";
import { parseFilename } from "./filenameParser.js";
import { matchTitle } from "./titleMatcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, "../../.stream-cache/.resolved-streams.json");

const streamCache = new Map();

// How many of the best-ranked streams Stremio is shown per title.
const MAX_STREAMS_SHOWN = 5;

// Persist resolved streams to disk so an already-searched movie doesn't need
// the whole (slow) bot-automation flow re-run just because the server restarted.
function loadPersistedCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [key, value] of Object.entries(obj)) {
      streamCache.set(key, value);
    }
    console.log(`[INFO] Loaded ${streamCache.size} cached movie search(es) from disk`);
  } catch {
    // No cache file yet — fine, starts empty.
  }
}

function savePersistedCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(streamCache)));
  } catch (err) {
    console.warn("[WARN] Failed to persist stream cache:", err.message);
  }
}

loadPersistedCache();

// Fetch metadata from Cinemeta (imdbId only — never the "tt123:season:episode" form)
async function fetchMetadata(imdbId, type) {
  try {
    const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);
    const data = await response.json();
    if (data && data.meta) {
      return {
        title: data.meta.name,
        year: data.meta.year ? parseInt(data.meta.year) : null,
      };
    }
  } catch (err) {
    console.error("Error fetching metadata from Cinemeta:", err);
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, "0");

export async function resolveStreams(client, id, type, baseUrl) {
  const cacheKey = `${type}_${id}`;
  if (streamCache.has(cacheKey)) {
    const cached = streamCache.get(cacheKey);
    // 60 minutes TTL
    const ttl = (process.env.CACHE_TTL || 3600) * 1000;
    if (Date.now() - cached.timestamp < ttl) {
      console.log(`[INFO] Serving cached streams for ${id}`);
      return cached.streams;
    } else {
      streamCache.delete(cacheKey);
      savePersistedCache();
    }
  }

  // Stremio sends series stream ids as "tt1234567:season:episode"
  let imdbId = id;
  let season = null;
  let episode = null;
  if (type === "series") {
    const parts = id.split(":");
    imdbId = parts[0];
    season = parseInt(parts[1]);
    episode = parseInt(parts[2]);
  }

  const meta = await fetchMetadata(imdbId, type);
  if (!meta) {
    console.log(`Could not resolve metadata for ${id}`);
    return [];
  }

  const query = type === "series"
    ? `${meta.title} S${pad2(season)}E${pad2(episode)}`
    : meta.title;

  console.log(`[INFO] Stremio request: ${id}`);
  console.log(`[INFO] Resolving metadata: ${query}` + (type === "movie" ? ` (${meta.year || "Unknown Year"})` : ""));

  // Trigger Automation Engine for bots
  console.log(`[INFO] Triggering Bot Automation Engine...`);
  const results = await automateMovieRequest(client, query);

  console.log(`[INFO] Found ${results.length} candidate files`);

  // Filter and score matches
  const validStreams = [];

  for (const result of results) {
    const parsed = parseFilename(result.filename);

    // Check title match
    if (!matchTitle(parsed.title, meta.title)) {
      continue;
    }

    if (type === "series") {
      // A series episode has to match season/episode exactly — a title match
      // alone (or a missing/parsed-wrong episode number) isn't good enough.
      if (parsed.season !== season || parsed.episode !== episode) {
        continue;
      }
    } else {
      // A movie must never be satisfied by an episode or season pack of a
      // show that just shares its title (e.g. the "Obsession" series files
      // showing up under the "Obsession" movie).
      if (parsed.season !== null || parsed.episode !== null) {
        continue;
      }

      if (meta.year && parsed.year && meta.year !== parsed.year) {
        // Allow +/- 1 year discrepancy
        if (Math.abs(meta.year - parsed.year) > 1) {
           continue;
        }
      }
    }

    // Construct stream description
    const sizeGB = (result.size / 1024 / 1024 / 1024).toFixed(2);
    let name = `Telegram\n${parsed.resolution || "Unknown"}`;
    let description = `${result.filename}\n📁 ${sizeGB} GB • ${parsed.source || "Unknown"} • ${parsed.codec || ""} • ${parsed.audio || ""}`;

    // Stremio URL format for our proxy
    // We pass chatId and messageId to our proxy
    const proxyUrl = `${baseUrl || `http://127.0.0.1:${process.env.PORT || 7000}`}/stream/${result.chatId}/${result.messageId}/video.mkv`;

    validStreams.push({
      name,
      description,
      url: proxyUrl,
      // Internal metadata for sorting and deduplication
      _resolution: parsed.resolution,
      _size: result.size,
      _filename: result.filename
    });
  }

  // Sort by resolution, then source quality, then size
  validStreams.sort((a, b) => {
    const resMap = { "4K": 4, "1080p": 3, "720p": 2, "480p": 1, "Unknown": 0 };
    const resA = resMap[a._resolution] || 0;
    const resB = resMap[b._resolution] || 0;
    if (resA !== resB) return resB - resA;

    // Prefer well-known, compatible sources (WEB-DL, BluRay, BDRip) over fan encodes
    const sourceScore = (f) => {
      const fn = f._filename.toLowerCase();
      if (fn.includes("web-dl") || fn.includes("webrip")) return 3;
      if (fn.includes("bluray") || fn.includes("bdrip") || fn.includes("blu-ray")) return 2;
      if (fn.includes("hdrip") || fn.includes("hd.rip")) return 1;
      return 0; // unknown / fan encode
    };
    const sA = sourceScore(a), sB = sourceScore(b);
    if (sA !== sB) return sB - sA;

    // Deprioritize files with '@' (fan-encoded, often compatibility issues)
    const atA = a._filename.includes("@") ? -1 : 0;
    const atB = b._filename.includes("@") ? -1 : 0;
    if (atA !== atB) return atB - atA;

    return b._size - a._size; // Largest first within same tier
  });

  // Deduplicate by filename (same file from different bots)
  const seen = new Set();
  const deduped = validStreams.filter(s => {
    if (seen.has(s._filename)) return false;
    seen.add(s._filename);
    return true;
  });

  // The search gathers up to 10 candidates, but only show the 5 best. `deduped`
  // is already sorted best-first (resolution, source, size), so slice the top.
  const capped = deduped.slice(0, MAX_STREAMS_SHOWN);

  // Remove internal properties before returning to Stremio
  const finalStreams = capped.map(s => {
    delete s._resolution;
    delete s._size;
    delete s._filename;
    return s;
  });

  streamCache.set(`${type}_${id}`, {
    timestamp: Date.now(),
    streams: finalStreams
  });
  savePersistedCache();

  console.log(`[INFO] Selected ${finalStreams.length} streams`);
  return finalStreams;
}
