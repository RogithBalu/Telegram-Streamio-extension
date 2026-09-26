export function parseQuality(filename) {
  const f = filename.toLowerCase();
  if (f.includes("2160p") || f.includes("4k")) return "4K";
  if (f.includes("1080p")) return "1080p";
  if (f.includes("720p")) return "720p";
  if (f.includes("480p")) return "480p";
  return "Unknown";
}

export function parseCodec(filename) {
  const f = filename.toLowerCase();
  if (f.includes("x265") || f.includes("h265") || f.includes("hevc")) return "HEVC (x265)";
  if (f.includes("x264") || f.includes("h264") || f.includes("avc")) return "AVC (x264)";
  return "Unknown";
}

export function parseAudio(filename) {
  const f = filename.toLowerCase();
  let audios = [];
  if (f.includes("dual audio") || f.includes("dual")) audios.push("Dual Audio");
  if (f.includes("multi")) audios.push("Multi Audio");
  if (f.includes("atmos")) audios.push("Atmos");
  if (f.includes("dd5.1") || f.includes("ac3") || f.includes("5.1")) audios.push("5.1");
  if (f.includes("dts")) audios.push("DTS");
  if (f.includes("aac")) audios.push("AAC");
  
  if (f.includes("malayalam")) audios.push("Malayalam");
  if (f.includes("tamil")) audios.push("Tamil");
  if (f.includes("hindi")) audios.push("Hindi");
  if (f.includes("telugu")) audios.push("Telugu");
  
  return audios.length > 0 ? audios.join(", ") : "Unknown";
}

export function parseSource(filename) {
  const f = filename.toLowerCase();
  if (f.includes("bluray") || f.includes("brrip") || f.includes("bdrip")) return "BluRay";
  if (f.includes("web-dl") || f.includes("webdl") || f.includes("web")) return "WEB-DL";
  if (f.includes("hdtv")) return "HDTV";
  if (f.includes("cam") || f.includes("ts") || f.includes("hdts")) return "CAM/TS";
  return "Unknown";
}
