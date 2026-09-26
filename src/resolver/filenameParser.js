import { parseQuality, parseCodec, parseAudio, parseSource } from "./qualityParser.js";

const EPISODE_PATTERNS = [
  /S(\d{1,2})E(\d{1,2})/i,
  /\b(\d{1,2})x(\d{2})\b/i
];

// Season with no episode number — season packs like "Show_S01_Complete" or
// "Show Season 1". Must be a standalone token so titles like "S1m0ne" or
// "Se7en" aren't mistaken for one.
const SEASON_ONLY_PATTERNS = [
  /(?:^|[\s._\-\[\(])S(\d{1,2})(?=$|[\s._\-\]\)])/i,
  /(?:^|[\s._\-\[\(])Season[\s._\-]?(\d{1,2})(?=$|[\s._\-\]\)])/i
];

export function parseFilename(filename) {
  // Simple heuristic: title usually comes before the year, season/episode
  // marker, or resolution/quality indicator.
  // E.g., Interstellar.2014.1080p.BluRay.x264.mkv
  // E.g., The.Good.Doctor.S04E04.1080p.WEB-DL.mkv

  // Remove extension
  let cleanName = filename.replace(/\.(mkv|mp4|avi|webm)$/i, "");

  // Extract season/episode if present (TV releases)
  let season = null;
  let episode = null;
  let episodeMatch = null;
  for (const pattern of EPISODE_PATTERNS) {
    const m = cleanName.match(pattern);
    if (m) {
      season = parseInt(m[1]);
      episode = parseInt(m[2]);
      episodeMatch = m;
      break;
    }
  }

  // No episode number — fall back to a bare season marker (season pack).
  // `episode` stays null; `episodeMatch` is only used as a title-cut marker.
  if (!episodeMatch) {
    for (const pattern of SEASON_ONLY_PATTERNS) {
      const m = cleanName.match(pattern);
      if (m) {
        season = parseInt(m[1]);
        episodeMatch = m;
        break;
      }
    }
  }

  // Extract year if present
  const yearMatch = cleanName.match(/(19\d{2}|20\d{2})/);
  let year = yearMatch ? parseInt(yearMatch[0]) : null;

  const qualityMatch = cleanName.match(/(2160p|1080p|720p|480p)/i);

  // Title ends at whichever marker (year, season/episode, or quality) appears first
  const markers = [yearMatch, episodeMatch, qualityMatch].filter(Boolean);
  let titlePart = cleanName;
  if (markers.length > 0) {
    const cutIndex = Math.min(...markers.map(m => m.index));
    titlePart = cleanName.substring(0, cutIndex);
  }

  // Normalize title (remove dots, underscores, dashes, trailing spaces)
  let title = titlePart.replace(/[\._\-]/g, " ").trim();
  // Remove trailing parentheses or brackets that might have got caught
  title = title.replace(/[\[\(\]\)]/g, "").trim();

  // Extract other metadata
  const resolution = parseQuality(filename);
  const codec = parseCodec(filename);
  const audio = parseAudio(filename);
  const source = parseSource(filename);

  return {
    title,
    year,
    season,
    episode,
    resolution,
    source,
    codec,
    audio,
    extension: filename.split('.').pop()
  };
}
