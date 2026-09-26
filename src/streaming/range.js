export function parseRangeHeader(rangeHeader, totalSize) {
  if (!rangeHeader) {
    return { start: 0, end: totalSize - 1, chunkSize: totalSize };
  }

  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  let start = parseInt(parts[0], 10);
  let end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

  // Clamp end to totalSize - 1 (RFC 7233: last byte is totalSize - 1)
  if (end >= totalSize) end = totalSize - 1;

  if (isNaN(start) || start < 0 || start >= totalSize || start > end) {
    throw new Error("Invalid range");
  }

  const chunkSize = end - start + 1;
  return { start, end, chunkSize };
}
